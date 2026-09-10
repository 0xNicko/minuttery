import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Minuttery } from "../target/types/minuttery";

// Node 24 can load this ESM package from the CommonJS test runner.
const { SecretKey } = require("@blueshift-gg/solana-ecvrf");

const LAMPORTS_PER_SOL = 1_000_000_000;
const BET_AMOUNT = 100_000_000;
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

function buildAlpha(roundId: number, totalPot: number, players: { wallet: PublicKey; seed: Uint8Array }[]): Uint8Array {
  const parts = [Buffer.from("minuttery-v1"), i64Bytes(roundId), i64Bytes(totalPot)];
  for (const player of players) {
    parts.push(Buffer.from(player.wallet.toBytes()), Buffer.from(player.seed));
  }
  return createHash("sha256").update(Buffer.concat(parts)).digest();
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
    if (second < 45) return { roundId: Math.floor(timestamp / 60), timestamp };
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

    const secondPlayer = Keypair.generate();
    print("Segundo jugador temporal", secondPlayer.publicKey.toBase58());
    const fundingSignature = await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: payer, toPubkey: secondPlayer.publicKey, lamports: 400_000_000 }),
      ),
    );
    print("Segundo jugador financiado con 0.4 SOL", fundingSignature);

    const { roundId, timestamp } = await waitForBettingWindow(provider);
    const [round] = PublicKey.findProgramAddressSync([Buffer.from("round"), i64Bytes(roundId)], program.programId);
    const firstSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const secondSeed = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    print("Ronda seleccionada", { roundId, timestamp, round: round.toBase58() });

    print("Enviando primera apuesta", { amount: BET_AMOUNT, seed: Buffer.from(firstSeed).toString("hex") });
    const firstBetSignature = await program.methods
      .placeBet(new anchor.BN(roundId), new anchor.BN(BET_AMOUNT), Array.from(firstSeed))
      .accountsPartial({ player: payer, round, systemProgram: SystemProgram.programId })
      .rpc();
    print("Primera apuesta confirmada", firstBetSignature);

    print("Enviando segunda apuesta", { player: secondPlayer.publicKey.toBase58(), amount: BET_AMOUNT });
    const secondBetSignature = await program.methods
      .placeBet(new anchor.BN(roundId), new anchor.BN(BET_AMOUNT), Array.from(secondSeed))
      .accountsPartial({ player: secondPlayer.publicKey, round, systemProgram: SystemProgram.programId })
      .signers([secondPlayer])
      .rpc();
    print("Segunda apuesta confirmada", secondBetSignature);
    print("Estado de la ronda", await program.account.roundState.fetch(round));

    const settleAt = roundId * 60 + 55;
    while (Math.floor(Date.now() / 1000) < settleAt) {
      const secondsLeft = settleAt - Math.floor(Date.now() / 1000);
      print(`Esperando liquidación. Faltan ${secondsLeft}s`);
      await sleep(3_000);
    }

    const alpha = buildAlpha(roundId, BET_AMOUNT * 2, [
      { wallet: payer, seed: firstSeed },
      { wallet: secondPlayer.publicKey, seed: secondSeed },
    ]);
    print("alpha construido", Buffer.from(alpha).toString("hex"));

    const proof = operator.prove(alpha);
    const output = proof.verify(operator.publicKey, alpha);
    const winnerIndex = output[0] % 2;
    const winner = winnerIndex === 0 ? payer : secondPlayer.publicKey;
    print("Proof ECVRF generado y verificado localmente", {
      proofLength: proof.bytes.length,
      proof: Buffer.from(proof.bytes).toString("hex"),
      output: Buffer.from(output).toString("hex"),
      winnerIndex,
      winner: winner.toBase58(),
    });

    if (Math.floor(Date.now() / 1000) >= settleAt + SETTLE_GRACE_SEC) {
      throw new Error("La ventana de liquidación expiró antes de enviar la prueba");
    }

    const liquidationSignature = await program.methods
      .liquidateRound(Array.from(proof.bytes))
      .accountsPartial({
        liquidator: payer,
        house: payer,
        winner,
        initiator: payer,
        config,
        round,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    print("liquidateRound() confirmado", liquidationSignature);
    const roundAfterLiquidation = await provider.connection.getAccountInfo(round);
    if (roundAfterLiquidation === null) {
      print("Cuenta de la ronda cerrada por Solana al quedar sin lamports: comportamiento esperado");
    } else {
      print("Cuenta de la ronda aún existe", roundAfterLiquidation.data.length);
    }
    print("Balances finales", {
      payer: `${(await provider.connection.getBalance(payer)) / LAMPORTS_PER_SOL} SOL`,
      secondPlayer: `${(await provider.connection.getBalance(secondPlayer.publicKey)) / LAMPORTS_PER_SOL} SOL`,
    });
    print("Test E2E completado correctamente");
  });
});
