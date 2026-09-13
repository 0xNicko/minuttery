import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Minuttery } from "../target/types/minuttery";

// Node 24 can load this ESM package from the CommonJS test runner.
const { SecretKey } = require("@blueshift-gg/solana-ecvrf");

const LAMPORTS_PER_SOL = 1_000_000_000;
const ROOM_TIER_01 = 0;
const ROOM_TIER_02 = 1;
const TIER_AMOUNTS = [100_000_000, 200_000_000];
const BET_AMOUNT = TIER_AMOUNTS[ROOM_TIER_01];
const ROOM_TIER = ROOM_TIER_01;
const SETTLE_GRACE_SEC = 30;
const ECVRF_KEYPAIR_PATH = "/workspaces/minuttery/.solana/ecvrf-test-keypair.json";

function print(label: string, value?: unknown): void {
  if (value === undefined) {
    console.log(`\n[MINUTTERY] ${label}`);
    return;
  }
  console.log(`[MINUTTERY] ${label}`, value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function i64Bytes(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(BigInt(value));
  return bytes;
}

function loadOrCreateOperator(): any {
  mkdirSync("/workspaces/minuttery/.solana", { recursive: true });
  if (!existsSync(ECVRF_KEYPAIR_PATH)) {
    const keypair = Keypair.generate();
    writeFileSync(ECVRF_KEYPAIR_PATH, JSON.stringify(Array.from(keypair.secretKey), null, 2));
    print(`Keypair ECVRF local creada: ${ECVRF_KEYPAIR_PATH}`);
  }
  return SecretKey.fromKeypair(JSON.parse(readFileSync(ECVRF_KEYPAIR_PATH, "utf8")));
}

async function waitForBettingWindow(provider: anchor.AnchorProvider): Promise<{ roundId: number; timestamp: number }> {
  for (;;) {
    const slot = await provider.connection.getSlot("confirmed");
    const timestamp = (await provider.connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
    const second = timestamp % 60;
    if (second < 35) return { roundId: Math.floor(timestamp / 60), timestamp };
    print(`Esperando el siguiente minuto. Segundo actual: ${second}`);
    await sleep(2_000);
  }
}

describe("minuttery devnet end-to-end", function () {
  this.timeout(180_000);

  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.minuttery as Program<Minuttery>;
  const payer = provider.wallet.publicKey;
  const operator = loadOrCreateOperator();

  it("inicializa, apuesta, genera ECVRF y liquida", async () => {
    print("Inicio del test en devnet");
    print("Program ID", program.programId.toBase58());
    print("Wallet pagadora", payer.toBase58());
    print("Operador ECVRF", operator.publicKey.toString());

    const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    print("Config PDA", config.toBase58());
    const configInfo = await program.account.config.fetchNullable(config);

    if (!configInfo) {
      print("Config no existe. Ejecutando initialize()");
      const signature = await program.methods
        .initialize(Array.from(operator.publicKey.bytes), payer)
        .accountsPartial({ authority: payer, config, systemProgram: SystemProgram.programId })
        .rpc();
      print("initialize() confirmado", signature);
    } else {
      print("Config ya existe; verificando operador y house", configInfo);
      if (Buffer.from(configInfo.operator).compare(Buffer.from(operator.publicKey.bytes)) !== 0) {
        throw new Error(`La config usa otro operador. Keypair esperada: ${ECVRF_KEYPAIR_PATH}`);
      }
      if (!configInfo.house.equals(payer)) throw new Error("La config usa otra house");
    }

    const players = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    print("Jugadores temporales", players.map((player) => player.publicKey.toBase58()));
    const fundingSignature = await provider.sendAndConfirm(
      new Transaction().add(
        ...players.map((player) => SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: player.publicKey,
          lamports: 500_000_000,
        })),
      ),
    );
    print("Jugadores financiados", fundingSignature);

    const { roundId, timestamp } = await waitForBettingWindow(provider);
    const roundDefinitions = [
      { tier: ROOM_TIER_01, amount: TIER_AMOUNTS[ROOM_TIER_01], firstPlayer: payer, firstSigner: undefined, secondPlayer: players[0] },
      { tier: ROOM_TIER_02, amount: TIER_AMOUNTS[ROOM_TIER_02], firstPlayer: players[1].publicKey, firstSigner: players[1], secondPlayer: players[2] },
    ];
    const rounds = roundDefinitions.map(({ tier }) => PublicKey.findProgramAddressSync(
      [Buffer.from("round"), Buffer.from([tier]), i64Bytes(roundId)],
      program.programId,
    )[0]);
    print("Rondas seleccionadas en el mismo minuto", {
      roundId,
      timestamp,
      rounds: roundDefinitions.map(({ tier, amount }, index) => ({
        tier,
        amount,
        round: rounds[index].toBase58(),
      })),
    });

    for (const [index, definition] of roundDefinitions.entries()) {
      const { tier, amount, firstPlayer, firstSigner, secondPlayer } = definition;
      const round = rounds[index];
      print(`Tier ${tier}: enviando primera apuesta`, { amount, player: firstPlayer.toBase58() });
      const firstBetSignature = await program.methods
        .placeBet(new anchor.BN(roundId), tier, new anchor.BN(amount))
        .accountsPartial({ player: firstPlayer, round, systemProgram: SystemProgram.programId })
        .signers(firstSigner ? [firstSigner] : [])
        .rpc();
      print(`Tier ${tier}: primera apuesta confirmada`, firstBetSignature);

      print(`Tier ${tier}: enviando segunda apuesta`, { amount, player: secondPlayer.publicKey.toBase58() });
      const secondBetSignature = await program.methods
        .placeBet(new anchor.BN(roundId), tier, new anchor.BN(amount))
        .accountsPartial({ player: secondPlayer.publicKey, round, systemProgram: SystemProgram.programId })
        .signers([secondPlayer])
        .rpc();
      print(`Tier ${tier}: segunda apuesta confirmada`, secondBetSignature);
      print(`Tier ${tier}: estado`, await program.account.roundState.fetch(round));
      print(`Tier ${tier}: balance`, `${(await provider.connection.getBalance(round)) / LAMPORTS_PER_SOL} SOL`);
    }

    const settleAt = roundId * 60 + 55;
    while (Math.floor(Date.now() / 1000) < settleAt) {
      const secondsLeft = settleAt - Math.floor(Date.now() / 1000);
      print(`Esperando liquidación. Faltan ${secondsLeft}s`);
      await sleep(3_000);
    }

    print("Apuestas cerradas; esperando que el worker liquide ambas rondas", roundId);
    const workerDeadline = settleAt + SETTLE_GRACE_SEC;
    const resolvedRounds = new Set<string>();
    while (Math.floor(Date.now() / 1000) < workerDeadline) {
      for (const [index, round] of rounds.entries()) {
        const key = round.toBase58();
        if (resolvedRounds.has(key)) continue;
        const currentRound = await program.account.roundState.fetchNullable(round);
        if (currentRound === null) {
          resolvedRounds.add(key);
          print(`Tier ${roundDefinitions[index].tier}: worker cerró la cuenta`);
        } else if (currentRound.status.resolved !== undefined) {
          resolvedRounds.add(key);
          print(`Tier ${roundDefinitions[index].tier}: worker liquidó la ronda`, currentRound.winner.toBase58());
        }
      }

      if (resolvedRounds.size === rounds.length) break;
      print(`Esperando liquidación del worker: ${resolvedRounds.size}/${rounds.length}`);
      await sleep(3_000);
    }

    if (resolvedRounds.size !== rounds.length) {
      throw new Error(`El worker liquidó ${resolvedRounds.size}/${rounds.length} rondas dentro de la ventana permitida`);
    }

    print("Balances finales", {
      payer: `${(await provider.connection.getBalance(payer)) / LAMPORTS_PER_SOL} SOL`,
      players: await Promise.all(players.map(async (player) => ({
        wallet: player.publicKey.toBase58(),
        balance: `${(await provider.connection.getBalance(player.publicKey)) / LAMPORTS_PER_SOL} SOL`,
      }))),
    });
    print("Test E2E de dos rondas completado correctamente");
  });
});
