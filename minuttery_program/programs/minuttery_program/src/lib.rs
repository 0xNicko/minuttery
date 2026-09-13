use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_lang::system_program;
use solana_ecvrf::{Proof, PublicKey};

declare_id!("9Uf52hSPJPDqDj7QFqL5dKmdJseU1pRtzL8oNQGeDxrP");

pub const BETTING_CUTOFF_SEC: i64 = 55;
pub const SETTLE_GRACE_SEC: i64 = 30;
pub const PROOF_LEN: usize = 80;
pub const MAX_PARTICIPANTS: usize = 24;

pub const ROOM_TIERS: [u64; 5] = [
    100_000_000,
    200_000_000,
    1_000_000_000,
    2_000_000_000,
    5_000_000_000,
];

#[program]
pub mod minuttery {
    use super::*;

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

    pub fn place_bet(
        ctx: Context<PlaceBet>,
        round_id: i64,
        room_tier: u8,
        amount: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(round_id == now / 60, CustomError::InvalidRoundId);
        require!(now % 60 < BETTING_CUTOFF_SEC, CustomError::BettingClosed);

        let tier_amount = room_tier_amount(room_tier)?;
        require!(amount == tier_amount, CustomError::InvalidAmount);

        let round = &mut ctx.accounts.round;
        let player = ctx.accounts.player.key();

        require!(round.n as usize <= MAX_PARTICIPANTS, CustomError::RoundFull);
        require!(
            (round.n as usize) < MAX_PARTICIPANTS,
            CustomError::RoundFull
        );

        for i in 0..round.n as usize {
            require!(round.players[i] != player, CustomError::AlreadyJoined);
        }

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

        let player_index = round.n as usize;
        round.players[player_index] = player;
        round.n = round
            .n
            .checked_add(1)
            .ok_or(CustomError::RoundFull)?;
        Ok(())
    }

    pub fn liquidate_round(
        ctx: Context<LiquidateRound>,
        round_id: i64,
        room_tier: u8,
        proof_bytes: [u8; PROOF_LEN],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round = &ctx.accounts.round;
        let cfg = &ctx.accounts.config;

        require!(now >= settle_open_ts(round_id), CustomError::TooEarlyToSettle);
        require!(now < expire_ts(round_id), CustomError::SettleWindowClosed);
        require!(ctx.accounts.house.key() == cfg.house, CustomError::InvalidHouse);
        require!(round.n > 0, CustomError::EmptyRound);
        require!(
            ctx.accounts.opener.key() == round.players[0],
            CustomError::InvalidOpener
        );

        let n = round.n as usize;
        let total_pot = (n as u64)
            .checked_mul(room_tier_amount(room_tier)?)
            .ok_or(CustomError::InvalidAmount)?;
        let round_ai = ctx.accounts.round.to_account_info();

        if n == 1 {
            require!(
                ctx.accounts.winner.key() == round.players[0],
                CustomError::InvalidWinnerAccount
            );
            **round_ai.try_borrow_mut_lamports()? -= total_pot;
            **ctx.accounts.winner.try_borrow_mut_lamports()? += total_pot;
            // close = opener devuelve el rent
            return Ok(());
        }

        let mut wallets = round.players[..n].to_vec();
        wallets.sort();

        let alpha = build_alpha(round_id, total_pot, &wallets);
        let output = Proof(proof_bytes)
            .verify(&PublicKey(cfg.operator), &alpha)
            .map_err(|_| error!(CustomError::InvalidProof))?;

        let winner_pubkey = wallets[winner_index_from_output(&output, n as u32)];
        require!(
            ctx.accounts.winner.key() == winner_pubkey,
            CustomError::InvalidWinnerAccount
        );

        let winner_amount = (total_pot * 965) / 1000;
        let house_amount = (total_pot * 30) / 1000;
        let opener_amount = total_pot.saturating_sub(winner_amount + house_amount); // 0.5%

        **round_ai.try_borrow_mut_lamports()? -= winner_amount;
        **ctx.accounts.winner.try_borrow_mut_lamports()? += winner_amount;

        **round_ai.try_borrow_mut_lamports()? -= house_amount;
        **ctx.accounts.house.try_borrow_mut_lamports()? += house_amount;

        **round_ai.try_borrow_mut_lamports()? -= opener_amount;
        **ctx.accounts.opener.try_borrow_mut_lamports()? += opener_amount;
        // close = opener: rent de ~0.0046 SOL
        Ok(())
    }

    /// Cualquiera, después del grace. Devuelve cada apuesta y el rent al opener.
    pub fn refund_all(
        ctx: Context<RefundAll>,
        round_id: i64,
        _room_tier: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round = &ctx.accounts.round;

        require!(now >= expire_ts(round_id), CustomError::NotExpired);
        require!(round.n > 0, CustomError::EmptyRound);
        require!(
            ctx.accounts.opener.key() == round.players[0],
            CustomError::InvalidOpener
        );
        require!(
            ctx.remaining_accounts.len() == round.n as usize,
            CustomError::SeatCountMismatch
        );

        let amount = room_tier_amount(_room_tier)?;
        let round_ai = ctx.accounts.round.to_account_info();
        let n = round.n as usize;

        for i in 0..n {
            let dest = &ctx.remaining_accounts[i];
            require!(dest.key() == round.players[i], CustomError::InvalidSeatAccount);
            require!(dest.is_writable, CustomError::InvalidSeatAccount);
            **round_ai.try_borrow_mut_lamports()? -= amount;
            **dest.try_borrow_mut_lamports()? += amount;
        }
        // close = opener
        Ok(())
    }
}

fn settle_open_ts(round_id: i64) -> i64 {
    round_id * 60 + BETTING_CUTOFF_SEC
}

fn expire_ts(round_id: i64) -> i64 {
    settle_open_ts(round_id) + SETTLE_GRACE_SEC
}

fn room_tier_amount(room_tier: u8) -> Result<u64> {
    ROOM_TIERS
        .get(room_tier as usize)
        .copied()
        .ok_or_else(|| error!(CustomError::InvalidRoomTier))
}

fn build_alpha(round_id: i64, total_pot: u64, wallets_sorted: &[Pubkey]) -> Vec<u8> {
    let mut parts: Vec<&[u8]> = Vec::with_capacity(3 + wallets_sorted.len());
    let id_bytes = round_id.to_le_bytes();
    let pot_bytes = total_pot.to_le_bytes();
    parts.push(b"minuttery-v2");
    parts.push(&id_bytes);
    parts.push(&pot_bytes);
    for w in wallets_sorted {
        parts.push(w.as_ref());
    }
    hashv(&parts).to_bytes().to_vec()
}

fn winner_index_from_output(output: &[u8; 64], n: u32) -> usize {
    let mut x = [0u8; 8];
    x.copy_from_slice(&output[0..8]);
    (u64::from_le_bytes(x) % n as u64) as usize
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub operator: [u8; 32],
    pub house: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RoundState {
    pub n: u8,
    pub players: [Pubkey; MAX_PARTICIPANTS],
}

impl RoundState {
    pub const LEN: usize = 8 + RoundState::INIT_SPACE; // 8 + 1 + 768 = 777
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: i64, room_tier: u8)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(
        init_if_needed,
        payer = player,
        space = RoundState::LEN,
        seeds = [b"round", room_tier.to_le_bytes().as_ref(), round_id.to_le_bytes().as_ref()],
        bump
    )]
    pub round: Account<'info, RoundState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: i64, room_tier: u8)]
pub struct LiquidateRound<'info> {
    pub liquidator: Signer<'info>,
    #[account(mut, address = config.house)]
    pub house: SystemAccount<'info>,
    #[account(mut)]
    pub winner: SystemAccount<'info>,
    /// Jugador 1. Recibe 0.5% + rent (close).
    #[account(mut)]
    pub opener: SystemAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"round", room_tier.to_le_bytes().as_ref(), round_id.to_le_bytes().as_ref()],
        bump,
        close = opener
    )]
    pub round: Account<'info, RoundState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: i64, room_tier: u8)]
pub struct RefundAll<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub opener: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [b"round", room_tier.to_le_bytes().as_ref(), round_id.to_le_bytes().as_ref()],
        bump,
        close = opener
    )]
    pub round: Account<'info, RoundState>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum CustomError {
    #[msg("Betting for this round is already closed.")]
    BettingClosed,
    #[msg("The bet amount is invalid.")]
    InvalidAmount,
    #[msg("The selected room tier is invalid.")]
    InvalidRoomTier,
    #[msg("The provided round ID does not match the current time.")]
    InvalidRoundId,
    #[msg("This round has reached its maximum capacity.")]
    RoundFull,
    #[msg("The provided account does not match the expected winner.")]
    InvalidWinnerAccount,
    #[msg("The provided account does not match the round opener.")]
    InvalidOpener,
    #[msg("Invalid ECVRF operator public key.")]
    InvalidOperatorKey,
    #[msg("Player already joined this round.")]
    AlreadyJoined,
    #[msg("Too early to settle.")]
    TooEarlyToSettle,
    #[msg("Settle window closed; use refund_all.")]
    SettleWindowClosed,
    #[msg("House account does not match config.")]
    InvalidHouse,
    #[msg("ECVRF proof failed.")]
    InvalidProof,
    #[msg("Round has no players.")]
    EmptyRound,
    #[msg("Round has not expired.")]
    NotExpired,
    #[msg("Invalid player account for refund.")]
    InvalidSeatAccount,
    #[msg("Player account count does not match the round.")]
    SeatCountMismatch,
}