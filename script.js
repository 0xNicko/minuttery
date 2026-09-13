import {
  AnchorProvider,
  BN,
  Program,
  web3,
} from "https://esm.sh/@coral-xyz/anchor@0.30.1?bundle";

console.log("[minuttery] CAMBIOS 15PX CARGADOS", {
  url: window.location.href,
  gamePanelRadius: document.querySelector(".game-panel")?.style.borderRadius,
  stylesheet: "style.css?v=15",
});

const PROGRAM_ID = new web3.PublicKey(
  "9Uf52hSPJPDqDj7QFqL5dKmdJseU1pRtzL8oNQGeDxrP",
);
const ROOM_TIERS = [0.1, 0.2, 1, 2, 5];
const RPC_ENDPOINT = new URL("/rpc", window.location.origin).toString();
const connection = new web3.Connection(RPC_ENDPOINT, {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
});
const elements = {
  connect: document.getElementById("connectWallet"),
  bet: document.getElementById("betButton"),
  message: document.getElementById("actionMessage"),
  timer: document.getElementById("timer"),
  progress: document.getElementById("timerProgress"),
  round: document.getElementById("roundNumber"),
  state: document.getElementById("roundState"),
  players: document.getElementById("playersCount"),
  pot: document.getElementById("potAmount"),
  settleCountdown: document.getElementById("settleCountdown"),
  walletModal: document.getElementById("walletModal"),
  walletMessage: document.getElementById("walletMessage"),
  phantomStatus: document.getElementById("phantomStatus"),
  solflareStatus: document.getElementById("solflareStatus"),
  backpackStatus: document.getElementById("backpackStatus"),
  winnerModal: document.getElementById("winnerModal"),
  winnerAddress: document.getElementById("winnerAddress"),
  winnerSummary: document.getElementById("winnerSummary"),
  proofRound: document.getElementById("proofRound"),
  proofParticipants: document.getElementById("proofParticipants"),
  proofAlpha: document.getElementById("proofAlpha"),
  roundExplorerLink: document.getElementById("roundExplorerLink"),
};
let walletPublicKey = null;
let connectedWallet = null;
const readOnlyWallet = {
  publicKey: web3.SystemProgram.programId,
  signTransaction: async () => {
    throw new Error("Read-only wallet");
  },
  signAllTransactions: async () => {
    throw new Error("Read-only wallet");
  },
};
let program = null;
let currentRoundId = null;
let clockOffsetMs = 0;
let selectedBetSol = ROOM_TIERS[0];
let selectedRoomTier = 0;
let roundLoadInFlight = null;
let lastRoundLoadAt = 0;
let roundLoadToken = 0;
let rpcBackoffUntil = 0;
let betInFlight = false;
const localClockEpoch = Date.now() - performance.now();
const idl = {
  address: PROGRAM_ID.toBase58(),
  metadata: { name: "minuttery", version: "0.1.0", spec: "0.1.0" },
  instructions: [
    {
      name: "placeBet",
      discriminator: [222, 62, 67, 220, 63, 166, 126, 33],
      accounts: [
        { name: "player", writable: true, signer: true },
        { name: "round", writable: true },
        {
          name: "systemProgram",
          address: web3.SystemProgram.programId.toBase58(),
        },
      ],
      args: [
        { name: "roundId", type: "i64" },
        { name: "roomTier", type: "u8" },
        { name: "amount", type: "u64" },
      ],
    },
  ],
  accounts: [
    { name: "RoundState", discriminator: [153, 242, 39, 64, 102, 34, 239, 11] },
  ],
  types: [
    {
      name: "RoundState",
      type: {
        kind: "struct",
        fields: [
          { name: "n", type: "u8" },
          { name: "players", type: { array: ["pubkey", 24] } },
        ],
      },
    },
  ],
};
program = new Program(
  idl,
  new AnchorProvider(connection, readOnlyWallet, { commitment: "confirmed" }),
);
function currentRound() {
  return Math.floor(Date.now() / 1000 / 60);
}
function roundPda(roundId, roomTier = selectedRoomTier) {
  return web3.PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("round"),
      Uint8Array.of(roomTier),
      new BN(roundId).toArrayLike(Uint8Array, "le", 8),
    ],
    PROGRAM_ID,
  )[0];
}
function setMessage(message, isError = false) {
  elements.message.textContent = message;
  elements.message.style.color = isError ? "#ff7575" : "";
}
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function syncedNow() {
  return localClockEpoch + performance.now() + clockOffsetMs;
}
function updateClock() {
  const preciseNow = syncedNow();
  const elapsedInRound = ((preciseNow % 60000) + 60000) % 60000;
  const seconds = Math.floor(elapsedInRound / 1000);
  const centiseconds = Math.floor((elapsedInRound % 1000) / 10);
  const secondsUntilSettlementExpiry = Math.max(0, 85 - seconds);
  elements.timer.textContent = `00:${String(seconds).padStart(2, "0")}:${String(centiseconds).padStart(2, "0")}`;
  elements.settleCountdown.textContent = secondsUntilSettlementExpiry;
  elements.progress.style.width = `${(elapsedInRound / 60000) * 100}%`;
  const roundId = Math.floor(preciseNow / 60000);
  elements.round.textContent = roundId;
  elements.bet.disabled = seconds >= 55 || betInFlight;
  elements.bet.querySelector("span").textContent = betInFlight
    ? "Confirming..."
    : walletPublicKey
      ? "Bet and go"
      : "Connect your wallet";
  if (seconds >= 55) {
    elements.state.textContent = "betting closed";
    setMessage("The next round starts in a few seconds");
  } else if (!walletPublicKey) {
    elements.state.textContent = "round open";
    setMessage("Connect your wallet to join this round");
  }
  if (roundId !== currentRoundId) {
    currentRoundId = roundId;
    loadRound();
  }
  requestAnimationFrame(updateClock);
}
async function syncClock() {
  return;
}
function isResolved(round) {
  return round?.status?.resolved !== undefined;
}
function roundStorageKey(roundId) {
  return `minuttery:winner-shown:${roundId}`;
}
function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
function concatBytes(...parts) {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  parts.forEach((part) => {
    result.set(part, offset);
    offset += part.length;
  });
  return result;
}
async function buildAlpha(roundId, roomTier, round) {
  const roundBytes = new BN(roundId.toString()).toArrayLike(
    Uint8Array,
    "le",
    8,
  );
  const totalPot = BigInt(round.n) * BigInt(ROOM_TIERS[roomTier] * web3.LAMPORTS_PER_SOL);
  const potBytes = new BN(totalPot.toString()).toArrayLike(
    Uint8Array,
    "le",
    8,
  );
  const parts = [
    new TextEncoder().encode("minuttery-v2"),
    roundBytes,
    potBytes,
  ];
  round.players
    .slice(0, round.n)
    .sort((left, right) => {
      const leftBytes = left.toBytes();
      const rightBytes = right.toBytes();
      for (let index = 0; index < leftBytes.length; index += 1) {
        if (leftBytes[index] !== rightBytes[index]) {
          return leftBytes[index] - rightBytes[index];
        }
      }
      return 0;
    })
    .forEach((player) => parts.push(player.toBytes()));
  const digest = await crypto.subtle.digest("SHA-256", concatBytes(...parts));
  return bytesToHex(new Uint8Array(digest));
}
async function showWinnerModal(roundId, roomTier, round) {
  const storageKey = `${roundId}:${roomTier}`;
  if (!isResolved(round) || localStorage.getItem(roundStorageKey(storageKey)))
    return;
  localStorage.setItem(roundStorageKey(storageKey), "1");
  const winner = round.winner.toBase58();
  const pda = roundPda(roundId, roomTier).toBase58();
  elements.winnerAddress.textContent = winner;
  elements.winnerSummary.textContent = `Round #${roundId} · tier ${roomTier} resolved with ${round.n} participants.`;
  elements.proofRound.textContent = roundId;
  elements.proofParticipants.textContent = round.n;
  elements.proofAlpha.textContent = "See settlement transaction";
  elements.roundExplorerLink.href = `https://explorer.solana.com/address/${pda}?cluster=devnet`;
  elements.winnerModal.hidden = false;
}
async function inspectResolvedRound(roundId, roomTier = selectedRoomTier) {
  try {
    const round = await program.account.roundState.fetch(
      roundPda(roundId, roomTier),
    );
    if (isResolved(round)) await showWinnerModal(roundId, roomTier, round);
    return round;
  } catch (error) {
    if (error?.message?.includes("429")) {
      rpcBackoffUntil = Date.now() + 60_000;
      setMessage(
        "Devnet is rate-limiting requests. Try again in a minute.",
        true,
      );
    }
    return null;
  }
}
function resetRoundStats() {
  elements.players.textContent = "0";
  elements.pot.textContent = "0.00";
  elements.state.textContent = "round open";
}
async function loadRound(force = false) {
  const now = Date.now();
  const loadToken = ++roundLoadToken;
  if (!walletPublicKey || now < rpcBackoffUntil || roundLoadInFlight || (!force && now - lastRoundLoadAt < 1500) || !program) return roundLoadInFlight;
  lastRoundLoadAt = now;
  roundLoadInFlight = (async () => {
    const current = await inspectResolvedRound(currentRoundId, selectedRoomTier);
    if (loadToken !== roundLoadToken) return;
    if (current && !isResolved(current)) {
      elements.players.textContent = current.n.toString();
      elements.pot.textContent = (Number(current.n) * selectedBetSol).toFixed(2);
    } else if (!current) {
      resetRoundStats();
    }
  })().finally(() => {
    roundLoadInFlight = null;
  });
  return roundLoadInFlight;
}
function getPhantom() {
  return (
    window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null)
  );
}
function getBackpack() {
  return window.backpack?.solana || window.backpack || null;
}
function openWalletModal() {
  elements.walletMessage.textContent = "";
  elements.phantomStatus.textContent = getPhantom()
    ? "Ready to connect"
    : "Open in Phantom app";
  elements.solflareStatus.textContent = window.solflare?.isSolflare
    ? "Ready to connect"
    : "Open in Solflare app";
  elements.backpackStatus.textContent = getBackpack()
    ? "Ready to connect"
    : "Install Backpack";
  elements.walletModal.hidden = false;
}
function closeWalletModal() {
  elements.walletModal.hidden = true;
}
function handleWalletAccountChanged(publicKey) {
  if (!publicKey || !connectedWallet) return;
  walletPublicKey = publicKey;
  program = new Program(
    idl,
    new AnchorProvider(connection, connectedWallet, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
    }),
  );
  elements.connect.textContent = `${publicKey.toBase58().slice(0, 4)}...${publicKey.toBase58().slice(-4)}`;
  resetRoundStats();
  loadRound(true);
}
async function connectWallet() {
  openWalletModal();
}
async function connectProvider(wallet) {
  try {
    const response = await wallet.connect();
    connectedWallet = wallet;
    walletPublicKey = wallet.publicKey || response.publicKey;
    if (!walletPublicKey) throw new Error("The wallet did not provide a public key.");
    const provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
    });
    program = new Program(idl, provider);
    elements.connect.textContent = `${walletPublicKey.toBase58().slice(0, 4)}...${walletPublicKey.toBase58().slice(-4)}`;
    closeWalletModal();
    setMessage("Wallet connected. The round is ready.");
    await loadRound();
  } catch (error) {
    elements.walletMessage.textContent =
      error.message || "Could not connect wallet";
  }
}
async function placeBet() {
  if (!program || !walletPublicKey || !connectedWallet) return connectWallet();
  if (betInFlight) return;
  betInFlight = true;
  updateClock();
  try {
    const activePublicKey = connectedWallet.publicKey;
    if (!activePublicKey) throw new Error("The wallet is no longer connected.");
    if (!activePublicKey.equals(walletPublicKey)) {
      walletPublicKey = activePublicKey;
      elements.connect.textContent = `${walletPublicKey.toBase58().slice(0, 4)}...${walletPublicKey.toBase58().slice(-4)}`;
      throw new Error("Wallet account changed. Please try the bet again.");
    }

    const round = roundPda(currentRoundId, selectedRoomTier);

    const instruction = await program.methods
      .placeBet(
        new BN(currentRoundId),
        selectedRoomTier,
        new BN(selectedBetSol * web3.LAMPORTS_PER_SOL),
      )
      .accounts({
        player: walletPublicKey,
        round,
        systemProgram: web3.SystemProgram.programId,
      })
      .instruction();
    const transaction = new web3.Transaction().add(instruction);
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    transaction.feePayer = walletPublicKey;
    const signedTransaction = await connectedWallet.signTransaction(transaction);
    const signature = await connection.sendRawTransaction(
      signedTransaction.serialize(),
      { skipPreflight: false, maxRetries: 0, preflightCommitment: "confirmed" },
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const statusResponse = await connection.getSignatureStatuses([signature]);
      const status = statusResponse.value[0];
      if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
      if (attempt === 19) throw new Error("Transaction confirmation timed out");
      await delay(1000);
    }
    setMessage(`Tier ${selectedBetSol} SOL joined. May luck find you.`);
    await loadRound();
  } catch (error) {
    let message = error.message || "Transaction could not be completed";
    if (typeof error.getLogs === "function") {
      const logs = await error.getLogs(connection);
      if (logs?.length) message = `${message}\n${logs.join("\n")}`;
    }
    setMessage(message, true);
  } finally {
    betInFlight = false;
    updateClock();
  }
}
elements.connect.addEventListener("click", connectWallet);
elements.bet.addEventListener("click", placeBet);
document.querySelectorAll(".bet-preset").forEach((button) =>
  button.addEventListener("click", () => {
    selectedRoomTier = Number(button.dataset.tier ?? ROOM_TIERS.indexOf(Number(button.dataset.amount)));
    selectedBetSol = Number(button.dataset.amount);
    resetRoundStats();
    document
      .querySelectorAll(".bet-preset")
      .forEach((item) => item.classList.remove("is-selected"));
    button.classList.add("is-selected");
    loadRound(true);
  }),
);
document
  .getElementById("closeWalletModal")
  .addEventListener("click", closeWalletModal);
elements.walletModal.addEventListener("click", (event) => {
  if (event.target === elements.walletModal) closeWalletModal();
});
document.getElementById("closeWinnerModal").addEventListener("click", () => {
  elements.winnerModal.hidden = true;
});
elements.winnerModal.addEventListener("click", (event) => {
  if (event.target === elements.winnerModal) elements.winnerModal.hidden = true;
});
document
  .querySelector('[data-wallet="phantom"]')
  .addEventListener("click", () => {
    const phantom = getPhantom();
    if (phantom) connectProvider(phantom);
    else {
      elements.walletMessage.textContent =
        "Open this page in the Phantom app browser to connect.";
      elements.phantomStatus.textContent = "Open in Phantom app";
      window.location.href = `https://phantom.app/ul/browse/${encodeURIComponent(window.location.href)}`;
    }
  });
document
  .querySelector('[data-wallet="solflare"]')
  .addEventListener("click", () => {
    if (window.solflare?.isSolflare) connectProvider(window.solflare);
    else
      elements.walletMessage.textContent =
        "Open this page in the Solflare app browser to connect.";
  });
document
  .querySelector('[data-wallet="backpack"]')
  .addEventListener("click", () => {
    const backpack = getBackpack();
    if (backpack) connectProvider(backpack);
    else {
      elements.walletMessage.textContent =
        "Install the Backpack extension or open this page in Backpack.";
      elements.backpackStatus.textContent = "Install Backpack";
    }
  });
window.solana?.on("disconnect", () => {
  connectedWallet = null;
  walletPublicKey = null;
  program = new Program(
    idl,
    new AnchorProvider(connection, readOnlyWallet, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
    }),
  );
  elements.connect.textContent = "Connect wallet";
});
window.backpack?.solana?.on?.("disconnect", () => {
  connectedWallet = null;
  walletPublicKey = null;
  program = new Program(
    idl,
    new AnchorProvider(connection, readOnlyWallet, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
    }),
  );
  elements.connect.textContent = "Connect wallet";
});
window.backpack?.solana?.on?.("accountChanged", handleWalletAccountChanged);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    syncClock();
    loadRound();
  }
});
currentRoundId = Math.floor(syncedNow() / 60000);
updateClock();
syncClock();
setInterval(syncClock, 60000);
