use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_lang::system_program;
use solana_ecvrf::{Proof, PublicKey};

declare_id!("9Uf52hSPJPDqDj7QFqL5dKmdJseU1pRtzL8oNQGeDxrP");

pub const MIN_BET: u64 = 100_000_000; // 0.1 SOL
pub const BETTING_CUTOFF_SEC: i64 = 55; // apuestas 0–54s
pub const SETTLE_GRACE_SEC: i64 = 30; // prueba hasta segundo 85 del minuto
pub const PROOF_LEN: usize = 80;

#[program]
pub mod minuttery {
    use super::*;

    /// Una vez: pubkey ECVRF del operador (tu VM) + wallet de la casa.
    pub fn initialize(ctx: Context<Initialize>, operator: [u8; 32], house: Pubkey) -> Result<()> {
        PublicKey(operator)
            .validate()
            .map_err(|_| error!(CustomError::InvalidOperatorKey))?;

        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.operator = operator;
        cfg.house = house;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn place_bet(ctx: Context<PlaceBet>, round_id: i64, amount: u64, seed: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let current_round = now / 60;
        let second = now % 60;

        require!(round_id == current_round, CustomError::InvalidRoundId);
        require!(second < BETTING_CUTOFF_SEC, CustomError::BettingClosed);
        require!(amount >= MIN_BET, CustomError::InvalidAmount);

        let round = &mut ctx.accounts.round;
        let round_ai = round.to_account_info();

        if round.round_id == 0 {
            round.round_id = current_round;
            round.participants_count = 0;
            round.total_pot = 0;
            round.status = RoundStatus::Open;
            round.initiator = ctx.accounts.player.key();
            round.initiator_rent = round_ai.lamports();
            round.winner = Pubkey::default();
            round.players = Vec::new();
        }

        require!(round.status == RoundStatus::Open, CustomError::BettingClosed);
        require!(
            (round.participants_count as usize) < RoundState::MAX_PARTICIPANTS,
            CustomError::RoundFull
        );
        require!(
            !round.players.iter().any(|p| p.wallet == ctx.accounts.player.key()),
            CustomError::AlreadyJoined
        );

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.player.to_account_info(),
                    to: round.to_account_info(),
                },
            ),
            amount,
        )?;

        round.players.push(PlayerEntry {
            wallet: ctx.accounts.player.key(),
            seed,
            amount,
            refunded: false,
        });
        round.participants_count += 1;
        round.total_pot += amount;
        Ok(())
    }

    /// La VM (o quien tenga la prueba) llama esto DESPUÉS del segundo 55.
    /// `proof` = 80 bytes de `secretKey.prove(alpha)` en la VM.
    pub fn liquidate_round(ctx: Context<LiquidateRound>, proof_bytes: [u8; PROOF_LEN]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        let cfg = &ctx.accounts.config;

        require!(round.status == RoundStatus::Open, CustomError::AlreadyResolved);
        require!(now >= settle_open_ts(round.round_id), CustomError::TooEarlyToSettle);
        require!(now < expire_ts(round.round_id), CustomError::SettleWindowClosed);
        require!(ctx.accounts.house.key() == cfg.house, CustomError::InvalidHouse);
        require!(
            ctx.accounts.initiator.key() == round.initiator,
            CustomError::InvalidInitiatorAccount
        );

        let total_pot = round.total_pot;
        let rent_amount = round.initiator_rent;
        let round_ai = round.to_account_info();

        if round.participants_count == 0 {
            return err!(CustomError::EmptyRound);
        }

        // Un solo jugador: refund, no hay sorteo.
        if round.participants_count == 1 {
            let only = round.players[0].wallet;
            require!(ctx.accounts.winner.key() == only, CustomError::InvalidWinnerAccount);

            let payout = total_pot + rent_amount;
            **round_ai.try_borrow_mut_lamports()? -= payout;
            **ctx.accounts.winner.try_borrow_mut_lamports()? += payout;

            round.winner = only;
            round.status = RoundStatus::Resolved;
            return Ok(());
        }

        let alpha = build_alpha(round);
        let output = Proof(proof_bytes)
            .verify(&PublicKey(cfg.operator), &alpha)
            .map_err(|_| error!(CustomError::InvalidProof))?;

        let winner_index = winner_index_from_output(&output, round.participants_count);
        let winner_pubkey = round.players[winner_index].wallet;
        require!(ctx.accounts.winner.key() == winner_pubkey, CustomError::InvalidWinnerAccount);

        let winner_amount = (total_pot * 965) / 1000;
        let house_amount = (total_pot * 30) / 1000;
        let liquidator_amount = total_pot.saturating_sub(winner_amount + house_amount);

        **round_ai.try_borrow_mut_lamports()? -= rent_amount;
        **ctx.accounts.initiator.try_borrow_mut_lamports()? += rent_amount;

        **round_ai.try_borrow_mut_lamports()? -= winner_amount;
        **ctx.accounts.winner.try_borrow_mut_lamports()? += winner_amount;

        **round_ai.try_borrow_mut_lamports()? -= house_amount;
        **ctx.accounts.house.try_borrow_mut_lamports()? += house_amount;

        **round_ai.try_borrow_mut_lamports()? -= liquidator_amount;
        **ctx.accounts.liquidator.try_borrow_mut_lamports()? += liquidator_amount;

        round.winner = winner_pubkey;
        round.status = RoundStatus::Resolved;
        Ok(())
    }

    /// Si la VM no publica la prueba a tiempo: cada jugador recupera su apuesta.
    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;

        require!(now >= expire_ts(round.round_id), CustomError::NotExpired);
        require!(round.status != RoundStatus::Resolved, CustomError::AlreadyResolved);

        if round.status == RoundStatus::Open {
            round.status = RoundStatus::Expired;
        }

        let player_key = ctx.accounts.player.key();
        let entry = round
            .players
            .iter_mut()
            .find(|p| p.wallet == player_key)
            .ok_or(CustomError::NotAParticipant)?;
        require!(!entry.refunded, CustomError::AlreadyRefunded);

        let amount = entry.amount;
        entry.refunded = true;

        **round.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.player.try_borrow_mut_lamports()? += amount;
        Ok(())
    }
}

fn settle_open_ts(round_id: i64) -> i64 {
    round_id * 60 + BETTING_CUTOFF_SEC
}

fn expire_ts(round_id: i64) -> i64 {
    settle_open_ts(round_id) + SETTLE_GRACE_SEC
}

/// Mismo cálculo en la VM. Si cambia acá, cambia allá.
fn build_alpha(round: &RoundState) -> Vec<u8> {
    let mut parts: Vec<&[u8]> = Vec::with_capacity(2 + round.players.len() * 2);
    let id_bytes = round.round_id.to_le_bytes();
    let pot_bytes = round.total_pot.to_le_bytes();
    parts.push(b"minuttery-v1");
    parts.push(&id_bytes);
    parts.push(&pot_bytes);
    for p in &round.players {
        parts.push(p.wallet.as_ref());
        parts.push(&p.seed);
    }
    hashv(&parts).to_bytes().to_vec()
}

fn winner_index_from_output(output: &[u8; 64], n: u32) -> usize {
    let mut x = [0u8; 8];
    x.copy_from_slice(&output[0..8]);
    (u64::from_le_bytes(x) % n as u64) as usize
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RoundStatus {
    Open,
    Resolved,
    Expired,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PlayerEntry {
    pub wallet: Pubkey,
    pub seed: [u8; 32],
    pub amount: u64,
    pub refunded: bool,
}

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub operator: [u8; 32], // address ECVRF = pubkey de tu keypair de la VM
    pub house: Pubkey,
    pub bump: u8,
}

#[account]
pub struct RoundState {
    pub round_id: i64,
    pub participants_count: u32,
    pub total_pot: u64,
    pub status: RoundStatus,
    pub initiator: Pubkey,
    pub initiator_rent: u64,
    pub winner: Pubkey,
    pub players: Vec<PlayerEntry>,
}

impl RoundState {
    pub const MAX_PARTICIPANTS: usize = 100;
    // 8 disc + fields + vec prefix + 100 * (32+32+8+1)
    pub const LEN: usize = 8 + 8 + 4 + 8 + 1 + 32 + 8 + 32 + 4 + 100 * 73;
}

impl Config {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 1;
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = Config::LEN,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: i64)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(
        init_if_needed,
        payer = player,
        space = RoundState::LEN,
        seeds = [b"round", round_id.to_le_bytes().as_ref()],
        bump
    )]
    pub round: Account<'info, RoundState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LiquidateRound<'info> {
    #[account(mut)]
    pub liquidator: Signer<'info>,
    #[account(mut)]
    pub house: SystemAccount<'info>,
    #[account(mut)]
    pub winner: SystemAccount<'info>,
    #[account(mut)]
    pub initiator: SystemAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub round: Account<'info, RoundState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut)]
    pub round: Account<'info, RoundState>,
}

#[error_code]
pub enum CustomError {
    #[msg("Betting for this round is already closed.")]
    BettingClosed,
    #[msg("This round has already been resolved.")]
    AlreadyResolved,
    #[msg("The bet amount is below the minimum allowed.")]
    InvalidAmount,
    #[msg("The provided round ID does not match the current time.")]
    InvalidRoundId,
    #[msg("This round has reached its maximum capacity of participants.")]
    RoundFull,
    #[msg("The provided account does not match the expected winner.")]
    InvalidWinnerAccount,
    #[msg("The provided account does not match the original round initiator.")]
    InvalidInitiatorAccount,
    #[msg("Invalid ECVRF operator public key.")]
    InvalidOperatorKey,
    #[msg("Player already joined this round.")]
    AlreadyJoined,
    #[msg("Too early to settle.")]
    TooEarlyToSettle,
    #[msg("Settle window closed; use claim_refund.")]
    SettleWindowClosed,
    #[msg("House account does not match config.")]
    InvalidHouse,
    #[msg("ECVRF proof failed.")]
    InvalidProof,
    #[msg("Round has no players.")]
    EmptyRound,
    #[msg("Round has not expired.")]
    NotExpired,
    #[msg("Not a participant.")]
    NotAParticipant,
    #[msg("Already refunded.")]
    AlreadyRefunded,
}