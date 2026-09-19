import {
  AnchorProvider,
  BN,
  Program,
  web3,
} from "https://esm.sh/@coral-xyz/anchor@0.30.1?bundle";
import QRCode from "https://esm.sh/qrcode@1.5.4";
import { createOrGetPasskeyWallet, handleFromPubkey } from "./auth.js?v=39";
import {
  API_BASE,
  BETTING_CLOSES_AT,
  HOST_COPY,
  PROGRAM_ID_BASE58,
  REFUND_AFTER_MS,
  ROOM_TIERS,
  ROUND_MS,
  RPC_ENDPOINT,
  TELEGRAM_URL,
  WINNERS_PAGE_SIZE,
} from "./config.js?v=39";
import {
  elapsedInRound,
  localRoundId,
  maybeResyncClock,
  roundSeconds,
  syncClock,
  syncedNow,
} from "./clock.js?v=39";
import { fetchSyncState, fetchWinners, findWinnerRow, roomFromSync } from "./api.js?v=39";
import { bindSheetDismiss, closeModal, copyText, openModal } from "./ui.js?v=39";

const PROGRAM_ID = new web3.PublicKey(PROGRAM_ID_BASE58);
const connection = new web3.Connection(RPC_ENDPOINT, {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
});

const elements = {
  connect: document.getElementById("connectWallet"),
  sessionBar: document.getElementById("sessionBar"),
  balanceButton: document.getElementById("balanceButton"),
  balanceLabel: document.getElementById("balanceLabel"),
  bet: document.getElementById("betButton"),
  message: document.getElementById("actionMessage"),
  timer: document.getElementById("timer"),
  progress: document.getElementById("timerProgress"),
  round: document.getElementById("roundNumber"),
  state: document.getElementById("roundState"),
  players: document.getElementById("playersCount"),
  pot: document.getElementById("potAmount"),
  winnerTicker: document.getElementById("winnerTicker"),
  walletModal: document.getElementById("walletModal"),
  walletMessage: document.getElementById("walletMessage"),
  passkeyButton: document.getElementById("passkeyButton"),
  phantomStatus: document.getElementById("phantomStatus"),
  solflareStatus: document.getElementById("solflareStatus"),
  backpackStatus: document.getElementById("backpackStatus"),
  depositModal: document.getElementById("depositModal"),
  depositAddress: document.getElementById("depositAddress"),
  depositQr: document.getElementById("depositQr"),
  accountModal: document.getElementById("accountModal"),
  accountTitle: document.getElementById("accountTitle"),
  accountAddress: document.getElementById("accountAddress"),
  accountBalance: document.getElementById("accountBalance"),
  accountJoined: document.getElementById("accountJoined"),
  accountWon: document.getElementById("accountWon"),
  accountMethod: document.getElementById("accountMethod"),
  settleModal: document.getElementById("settleModal"),
  settleKicker: document.getElementById("settleKicker"),
  settleTitle: document.getElementById("settleTitle"),
  settleCopy: document.getElementById("settleCopy"),
  settleSpinner: document.getElementById("settleSpinner"),
  settleWinnerLabel: document.getElementById("settleWinnerLabel"),
  settleWinnerAddress: document.getElementById("settleWinnerAddress"),
  settleVerifyLink: document.getElementById("settleVerifyLink"),
  settleFairness: document.getElementById("settleFairness"),
  settleRefund: document.getElementById("settleRefund"),
  settleClose: document.getElementById("settleClose"),
  historyModal: document.getElementById("historyModal"),
  historyList: document.getElementById("historyList"),
  historyPageLabel: document.getElementById("historyPageLabel"),
  historyPrev: document.getElementById("historyPrev"),
  historyNext: document.getElementById("historyNext"),
  inviteModal: document.getElementById("inviteModal"),
  inviteMessage: document.getElementById("inviteMessage"),
  withdrawModal: document.getElementById("withdrawModal"),
  withdrawTo: document.getElementById("withdrawTo"),
  withdrawAmount: document.getElementById("withdrawAmount"),
  withdrawStatus: document.getElementById("withdrawStatus"),
  claimModal: document.getElementById("claimModal"),
  claimRoundId: document.getElementById("claimRoundId"),
  claimTier: document.getElementById("claimTier"),
  claimStatus: document.getElementById("claimStatus"),
};

let walletPublicKey = null;
let connectedWallet = null;
let walletKind = null;
let walletBalanceSol = null;
let program = null;
let currentRoundId = null;
let selectedBetSol = ROOM_TIERS[0];
let selectedRoomTier = 0;
let roundLoadInFlight = null;
let lastRoundLoadAt = 0;
let roundLoadToken = 0;
let rpcBackoffUntil = 0;
let lastRpcRoundAt = 0;
let betInFlight = false;
let knownPlayers = 0;
let cachedPlayers = [];
let joinedRound = null;
let joinedCount = Number(localStorage.getItem("minuttery.joined") || 0);
let wonCount = Number(localStorage.getItem("minuttery.won") || 0);
let settleWatch = null;
let settleShownFor = "";
let lastUiTick = "";
let winnersFeed = [];
let winnerTickIndex = 0;
let historyPage = 0;
let historyHasMore = false;
let historyTotal = null;
let pageHidden = document.visibilityState === "hidden";
let lastSyncPollAt = 0;
let clockReady = false;
let countedWinSignatures = new Set(
  JSON.parse(localStorage.getItem("minuttery.wonSigs") || "[]"),
);

const readOnlyWallet = {
  publicKey: web3.SystemProgram.programId,
  signTransaction: async () => {
    throw new Error("Read-only wallet");
  },
  signAllTransactions: async () => {
    throw new Error("Read-only wallet");
  },
};

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
    {
      name: "refundAll",
      discriminator: [174, 87, 222, 126, 23, 59, 189, 155],
      accounts: [
        { name: "caller", signer: true },
        { name: "opener", writable: true },
        { name: "round", writable: true },
        {
          name: "systemProgram",
          address: web3.SystemProgram.programId.toBase58(),
        },
      ],
      args: [
        { name: "roundId", type: "i64" },
        { name: "roomTier", type: "u8" },
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function explorerTx(signature) {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function explorerAccount(address) {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

function lamportsToSol(value) {
  return (Number(value) / web3.LAMPORTS_PER_SOL).toFixed(2);
}

function shortWallet(address) {
  if (!address) return "—";
  return `${address.slice(0, 4)}....${address.slice(-4)}`;
}

function formatMinuteStamp(ts) {
  const date = new Date((ts || 0) * 1000);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("en-GB", { hour12: false });
}

function formatHistoryDate(ts) {
  return new Date(ts * 1000).toLocaleString("es-UY");
}

function userJoinedThisRound() {
  return (
    joinedRound &&
    joinedRound.roundId === currentRoundId &&
    joinedRound.tier === selectedRoomTier
  );
}

function renderSession() {
  if (!walletPublicKey) {
    elements.connect.hidden = false;
    elements.sessionBar.hidden = true;
    return;
  }
  elements.connect.hidden = true;
  elements.sessionBar.hidden = false;
  const amount = walletBalanceSol == null ? "0.00" : walletBalanceSol.toFixed(2);
  elements.balanceLabel.textContent = `${amount} SOL`;
}

async function refreshWalletBalance() {
  if (!walletPublicKey) {
    walletBalanceSol = null;
    renderSession();
    return;
  }
  try {
    const lamports = await connection.getBalance(walletPublicKey, "confirmed");
    walletBalanceSol = lamports / web3.LAMPORTS_PER_SOL;
  } catch {
    walletBalanceSol = walletBalanceSol ?? 0;
  }
  renderSession();
}

function applyHostCopy() {
  const seconds = roundSeconds();
  if (seconds >= BETTING_CLOSES_AT) {
    elements.state.textContent = "betting closed";
    if (!userJoinedThisRound()) {
      setMessage("The next round starts in a few seconds");
    }
    return;
  }
  elements.state.textContent = "round open";
  if (!walletPublicKey) {
    setMessage("Login to join this round");
    return;
  }
  if (knownPlayers === 0) setMessage(HOST_COPY);
}

function applyPlayerCount(count) {
  knownPlayers = Number(count) || 0;
  elements.players.textContent = String(knownPlayers);
  elements.pot.textContent = (knownPlayers * selectedBetSol).toFixed(2);
}

function resetRoundStats() {
  knownPlayers = 0;
  cachedPlayers = [];
  elements.players.textContent = "0";
  elements.pot.textContent = "0.00";
  elements.state.textContent = "round open";
}

function rpcAllowed() {
  return Date.now() >= rpcBackoffUntil && !pageHidden;
}

async function loadRoundFromChain(force = false) {
  if (!rpcAllowed()) return;
  const now = Date.now();
  const minGap = force ? 4000 : 8000;
  if (!force && (roundLoadInFlight || now - lastRpcRoundAt < minGap)) return roundLoadInFlight;
  lastRpcRoundAt = now;
  lastRoundLoadAt = now;
  const token = ++roundLoadToken;
  const watchedId = currentRoundId;
  const watchedTier = selectedRoomTier;
  roundLoadInFlight = (async () => {
    try {
      const account = await program.account.roundState.fetchNullable(
        roundPda(watchedId, watchedTier),
      );
      if (token !== roundLoadToken) return;
      if (watchedId !== currentRoundId || watchedTier !== selectedRoomTier) return;
      if (!account) {
        resetRoundStats();
        applyHostCopy();
        return;
      }
      applyPlayerCount(account.n);
      cachedPlayers = account.players.slice(0, knownPlayers);
      if (
        walletPublicKey &&
        cachedPlayers.some((item) => item.equals(walletPublicKey))
      ) {
        joinedRound = { roundId: currentRoundId, tier: selectedRoomTier };
      }
      applyHostCopy();
    } catch (error) {
      if (error?.message?.includes("429")) {
        rpcBackoffUntil = Date.now() + 60_000;
        setMessage("Devnet is rate-limiting requests. Try again in a minute.", true);
      }
    }
  })().finally(() => {
    roundLoadInFlight = null;
  });
  return roundLoadInFlight;
}

async function pollWorkerState(force = false) {
  if (pageHidden) return;
  const now = Date.now();
  const seconds = roundSeconds();
  const gap = seconds >= BETTING_CLOSES_AT ? 4000 : 2000;
  if (!force && now - lastSyncPollAt < gap) return;
  lastSyncPollAt = now;
  maybeResyncClock();

  const sync = await fetchSyncState().catch(() => null);
  if (sync) {
    const serverNow = sync.serverNow ?? sync.now;
    if (typeof serverNow === "number") {
      const ms = serverNow < 1e12 ? serverNow * 1000 : serverNow;
      const serverRound = Math.floor(ms / ROUND_MS);
      if (Number.isFinite(serverRound)) currentRoundId = serverRound;
    } else if (sync.roundId != null) {
      currentRoundId = Number(sync.roundId);
    }

    const room = roomFromSync(sync, selectedRoomTier);
    if (room) {
      const count = room.n ?? room.players ?? room.playerCount;
      if (count != null) applyPlayerCount(count);
      applyHostCopy();
      return;
    }
  }

  await loadRoundFromChain(force);
}

function updateClock() {
  const preciseNow = syncedNow();
  const elapsed = elapsedInRound(preciseNow);
  const seconds = Math.floor(elapsed / 1000);
  const centiseconds = Math.floor((elapsed % 1000) / 10);
  elements.timer.textContent = `00:${String(seconds).padStart(2, "0")}:${String(centiseconds).padStart(2, "0")}`;
  elements.progress.style.width = `${(elapsed / ROUND_MS) * 100}%`;
  const roundId = localRoundId(preciseNow);
  if (currentRoundId == null) currentRoundId = roundId;
  elements.round.textContent = currentRoundId;
  elements.bet.disabled = !clockReady || seconds >= BETTING_CLOSES_AT || betInFlight;
  elements.bet.querySelector("span").textContent = betInFlight
    ? "Confirming..."
    : "Join this round";

  const tick = `${currentRoundId}:${seconds >= BETTING_CLOSES_AT}:${walletPublicKey}:${knownPlayers}:${userJoinedThisRound()}`;
  if (tick !== lastUiTick) {
    lastUiTick = tick;
    applyHostCopy();
  }

  if (roundId !== currentRoundId && Math.abs(roundId - currentRoundId) <= 1) {
    const jumpedForward = roundId > currentRoundId;
    currentRoundId = roundId;
    if (jumpedForward) {
      cachedPlayers = [];
      knownPlayers = 0;
      pollWorkerState(true);
    }
  } else if (currentRoundId == null) {
    currentRoundId = roundId;
  }

  if (joinedRound && (currentRoundId > joinedRound.roundId || (currentRoundId === joinedRound.roundId && seconds >= BETTING_CLOSES_AT))) {
    startSettleWatch();
  }

  if (!pageHidden) pollWorkerState();
  requestAnimationFrame(updateClock);
}

function hideSettleOutcome() {
  elements.settleWinnerLabel.hidden = true;
  elements.settleWinnerAddress.hidden = true;
  elements.settleWinnerAddress.textContent = "";
  elements.settleVerifyLink.hidden = true;
  elements.settleFairness.hidden = true;
  elements.settleRefund.hidden = true;
}

function openSettleCalculating() {
  elements.settleKicker.textContent = "live settlement";
  elements.settleTitle.textContent = "Calculating winner";
  elements.settleCopy.textContent =
    "The worker is settling this round on-chain. Hang tight — this usually lands before second 85.";
  elements.settleSpinner.hidden = false;
  hideSettleOutcome();
  openModal(elements.settleModal);
}

function openSettleSolo(roundId, players = 1) {
  hideSettleOutcome();
  elements.settleKicker.textContent = "no draw";
  elements.settleTitle.textContent = "Stake returned";
  elements.settleCopy.textContent =
    `Round #${roundId} · ${players} player. Nobody else joined, so there was no raffle. The program sent the stake back to the only wallet in the room.`;
  elements.settleSpinner.hidden = true;
  elements.settleRefund.hidden = true;
}

function openSettleWinner(row, fallbackPlayers = 0) {
  const stake = ROOM_TIERS[row.tier] ?? row.tier;
  const players = Number(row.n ?? row.players ?? fallbackPlayers) || 0;
  if (players <= 1 || row.kind === "refunded") {
    openSettleSolo(row.roundId, players || 1);
    if (row.signature) {
      elements.settleVerifyLink.hidden = false;
      elements.settleVerifyLink.href = explorerTx(row.signature);
      elements.settleVerifyLink.textContent = "View return transaction";
    }
    return;
  }
  elements.settleKicker.textContent = "round resolved";
  elements.settleTitle.textContent = "Winner selected";
  elements.settleCopy.textContent = `Round #${row.roundId} · ${stake} SOL room · ${players} players`;
  elements.settleSpinner.hidden = true;
  elements.settleWinnerLabel.hidden = false;
  elements.settleWinnerAddress.hidden = false;
  elements.settleWinnerAddress.textContent = "";
  const winnerLink = document.createElement("a");
  winnerLink.href = explorerAccount(row.winner);
  winnerLink.target = "_blank";
  winnerLink.rel = "noreferrer";
  winnerLink.textContent = row.winner;
  elements.settleWinnerAddress.appendChild(winnerLink);
  elements.settleVerifyLink.hidden = false;
  elements.settleVerifyLink.href = explorerTx(row.signature);
  elements.settleVerifyLink.textContent = "Verify settlement";
  elements.settleFairness.hidden = false;
  elements.settleRefund.hidden = true;
  elements.settleRefund.setAttribute("hidden", "");

  if (walletPublicKey && row.winner === walletPublicKey.toBase58() && row.signature) {
    if (!countedWinSignatures.has(row.signature)) {
      countedWinSignatures.add(row.signature);
      wonCount = countedWinSignatures.size;
      localStorage.setItem("minuttery.won", String(wonCount));
      localStorage.setItem("minuttery.wonSigs", JSON.stringify([...countedWinSignatures]));
    }
  }
}

function openSettleWaitingRefund(roundId, players) {
  elements.settleKicker.textContent = "settlement delayed";
  elements.settleTitle.textContent = "Still waiting";
  elements.settleCopy.textContent =
    `Round #${roundId} · ${players} players · No settlement yet. You can refund the room: bets return to each player, and the opener gets the room deposit back.`;
  elements.settleSpinner.hidden = true;
  elements.settleWinnerLabel.hidden = true;
  elements.settleWinnerAddress.hidden = true;
  elements.settleVerifyLink.hidden = true;
  elements.settleFairness.hidden = true;
  elements.settleRefund.hidden = false;
}

function closeSettleModal() {
  closeModal(elements.settleModal);
}

async function startSettleWatch() {
  const key = `${joinedRound.roundId}:${joinedRound.tier}`;
  if (settleShownFor === key) return;
  settleShownFor = key;
  openSettleCalculating();
  if (settleWatch) return;
  settleWatch = true;

  const watchedRound = joinedRound.roundId;
  const watchedTier = joinedRound.tier;
  const watchedPlayers = knownPlayers || cachedPlayers.length;
  const startedAt = Date.now();
  let resolved = false;

  try {
    while (!resolved) {
      const row = await findWinnerRow(watchedRound, watchedTier).catch(() => null);
      if (row?.winner || row?.kind === "refunded") {
        openSettleWinner(row, watchedPlayers || Number(row.n) || 0);
        loadWinnersFeed();
        resolved = true;
        return;
      }
      if (watchedPlayers <= 1 && Date.now() - startedAt >= 8_000) {
        openSettleSolo(watchedRound, watchedPlayers || 1);
        resolved = true;
        return;
      }
      if (Date.now() - startedAt >= REFUND_AFTER_MS) {
        openSettleWaitingRefund(watchedRound, watchedPlayers);
        for (let extra = 0; extra < 20; extra += 1) {
          await delay(2000);
          const late = await findWinnerRow(watchedRound, watchedTier).catch(() => null);
          if (late?.winner) {
            openSettleWinner(late, watchedPlayers);
            loadWinnersFeed();
            resolved = true;
            return;
          }
        }
        return;
      }
      await delay(2000);
    }
  } catch (error) {
    if (!resolved && Date.now() - startedAt >= REFUND_AFTER_MS) {
      openSettleWaitingRefund(watchedRound, watchedPlayers);
    }
    if (error?.message?.includes("429")) rpcBackoffUntil = Date.now() + 60_000;
  } finally {
    settleWatch = null;
  }
}

async function refundRound() {
  if (!program || !walletPublicKey || !connectedWallet) return connectWallet();
  const roundId = joinedRound?.roundId ?? currentRoundId;
  const roomTier = joinedRound?.tier ?? selectedRoomTier;
  const pda = roundPda(roundId, roomTier);
  try {
    elements.settleRefund.textContent = "Refunding…";
    let players = cachedPlayers;
    if (!players.length && rpcAllowed()) {
      const account = await program.account.roundState.fetch(pda);
      players = account.players.slice(0, Number(account.n));
    }
    if (!players.length) throw new Error("No players found for refund.");
    const instruction = await program.methods
      .refundAll(new BN(roundId), roomTier)
      .accounts({
        caller: walletPublicKey,
        opener: players[0],
        round: pda,
        systemProgram: web3.SystemProgram.programId,
      })
      .remainingAccounts(
        players.map((pubkey) => ({
          pubkey,
          isWritable: true,
          isSigner: false,
        })),
      )
      .instruction();
    const transaction = new web3.Transaction().add(instruction);
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    transaction.feePayer = walletPublicKey;
    const signed = await connectedWallet.signTransaction(transaction);
    const signature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 0,
      preflightCommitment: "confirmed",
    });
    elements.settleTitle.textContent = "Refund sent";
    elements.settleCopy.textContent = "Bets are returning to each wallet. The opener receives the room deposit.";
    elements.settleRefund.hidden = true;
    elements.settleVerifyLink.hidden = false;
    elements.settleVerifyLink.href = explorerTx(signature);
    elements.settleVerifyLink.textContent = "View refund transaction";
  } catch (error) {
    elements.settleCopy.textContent = error.message || "Refund failed";
  } finally {
    elements.settleRefund.textContent = "Refund this round";
  }
}

function chevronSvg() {
  return `<svg viewBox="0 0 12 12" width="10" height="10"><path d="M4.2 2.2 8 6l-3.8 3.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// keeps the yellow fill visible briefly on tap since touch devices have no real :hover
function flashActive(element) {
  element.classList.add("is-active");
  window.setTimeout(() => element.classList.remove("is-active"), 250);
}

function winnerLine(row) {
  const pot = lamportsToSol(row.pot);
  const when = formatMinuteStamp(row.ts);
  return `${shortWallet(row.winner)} won <span class="ticker-pot">${pot} SOL</span> in minute ${when}`;
}

function showWinnerTick() {
  if (!winnersFeed.length) {
    elements.winnerTicker.innerHTML = `No settled rounds yet <span class="ticker-chevron" aria-hidden="true">${chevronSvg()}</span>`;
    return;
  }
  elements.winnerTicker.classList.add("is-fading");
  window.setTimeout(() => {
    const row = winnersFeed[winnerTickIndex % winnersFeed.length];
    elements.winnerTicker.innerHTML = `${winnerLine(row)} <span class="ticker-chevron" aria-hidden="true">${chevronSvg()}</span>`;
    elements.winnerTicker.classList.remove("is-fading");
    winnerTickIndex = (winnerTickIndex + 1) % winnersFeed.length;
  }, 280);
}

async function loadWinnersFeed() {
  try {
    const page = await fetchWinners({ limit: 30, offset: 0 });
    winnersFeed = page.rows;
    showWinnerTick();
    refreshWonCount(page.rows);
  } catch {
    elements.winnerTicker.innerHTML = `Browse past winners <span class="ticker-chevron" aria-hidden="true">${chevronSvg()}</span>`;
  }
}

function refreshWonCount(rows) {
  if (!walletPublicKey || !rows?.length) return;
  const mine = walletPublicKey.toBase58();
  const fromFeed = rows.filter((row) => row.winner === mine).length;
  if (fromFeed > wonCount) {
    wonCount = fromFeed;
    localStorage.setItem("minuttery.won", String(wonCount));
  }
}

async function loadPastWinners() {
  elements.historyList.textContent = "Loading settled rounds…";
  try {
    const offset = historyPage * WINNERS_PAGE_SIZE;
    const page = await fetchWinners({ limit: WINNERS_PAGE_SIZE, offset });
    winnersFeed = historyPage === 0 ? page.rows : winnersFeed;
    historyHasMore = page.hasMore;
    historyTotal = page.total;
    if (!page.rows.length) {
      elements.historyList.textContent = historyPage === 0 ? "No settled rounds yet." : "No more rounds.";
      renderHistoryPager();
      return;
    }
    elements.historyList.innerHTML = page.rows
      .map((row) => {
        const stake = ROOM_TIERS[row.tier] ?? row.tier;
        const pot = lamportsToSol(row.pot);
        const when = row.ts ? formatHistoryDate(row.ts) : "—";
        const short = shortWallet(row.winner);
        return `<article class="history-row">
          <p class="history-line">Winner: <a class="history-wallet" href="${explorerAccount(row.winner)}" target="_blank" rel="noreferrer">${short}</a></p>
          <p class="history-meta">Round id: ${row.roundId} · Bet: ${stake} SOL · Players: ${row.n} · Pot <span class="ticker-pot">${pot} ◎</span></p>
          <p class="history-meta">Date: ${when}</p>
          <a class="explorer-link" href="${explorerTx(row.signature)}" target="_blank" rel="noreferrer">Open settlement</a>
        </article>`;
      })
      .join("");
    renderHistoryPager();
  } catch (error) {
    elements.historyList.textContent = error.message || "Could not load history";
    renderHistoryPager();
  }
}

function renderHistoryPager() {
  const pageNumber = historyPage + 1;
  const totalPages = historyTotal != null
    ? Math.max(1, Math.ceil(historyTotal / WINNERS_PAGE_SIZE))
    : null;
  elements.historyPageLabel.textContent = totalPages
    ? `${pageNumber} / ${totalPages}`
    : `Page ${pageNumber}`;
  elements.historyPrev.disabled = historyPage === 0;
  elements.historyNext.disabled = !historyHasMore;
}

function getPhantom() {
  return window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null);
}
function getBackpack() {
  return window.backpack?.solana || window.backpack || null;
}
function openWalletModal() {
  elements.walletMessage.textContent = "";
  elements.phantomStatus.textContent = getPhantom() ? "Ready to connect" : "Open in Phantom app";
  elements.solflareStatus.textContent = window.solflare?.isSolflare ? "Ready to connect" : "Open in Solflare app";
  elements.backpackStatus.textContent = getBackpack() ? "Ready to connect" : "Install Backpack";
  openModal(elements.walletModal);
}
function closeWalletModal() {
  closeModal(elements.walletModal);
}

async function connectProvider(wallet, kind = "wallet") {
  try {
    const response = wallet.connect ? await wallet.connect() : { publicKey: wallet.publicKey };
    connectedWallet = wallet;
    walletKind = kind;
    walletPublicKey = wallet.publicKey || response.publicKey;
    if (!walletPublicKey) throw new Error("The wallet did not provide a public key.");
    program = new Program(
      idl,
      new AnchorProvider(connection, wallet, {
        commitment: "confirmed",
        disableRetryOnRateLimit: true,
      }),
    );
    await refreshWalletBalance();
    closeWalletModal();
    await pollWorkerState(true);
    applyHostCopy();
  } catch (error) {
    elements.walletMessage.textContent = error.message || "Could not connect";
  }
}

function connectWallet() {
  openWalletModal();
}

async function signInWithPasskey() {
  elements.walletMessage.textContent = "";
  elements.passkeyButton.disabled = true;
  elements.passkeyButton.querySelector("span:last-child").textContent = "Waiting for passkey…";
  try {
    const wallet = await createOrGetPasskeyWallet();
    await connectProvider(wallet, "passkey");
  } catch (error) {
    elements.walletMessage.textContent = error.message || "Passkey sign-in failed";
  } finally {
    elements.passkeyButton.disabled = false;
    elements.passkeyButton.querySelector("span:last-child").textContent = "Sign in with passkey";
  }
}

async function disconnectWallet() {
  try {
    if (connectedWallet?.disconnect) await connectedWallet.disconnect();
  } catch {}
  connectedWallet = null;
  walletPublicKey = null;
  walletKind = null;
  walletBalanceSol = null;
  joinedRound = null;
  program = new Program(
    idl,
    new AnchorProvider(connection, readOnlyWallet, { commitment: "confirmed" }),
  );
  renderSession();
  closeModal(elements.accountModal);
  applyHostCopy();
}

async function openDepositSheet() {
  if (!walletPublicKey) return openWalletModal();
  const address = walletPublicKey.toBase58();
  elements.depositAddress.textContent = address;
  try {
    await QRCode.toCanvas(elements.depositQr, address, {
      width: 120,
      margin: 1,
      color: { dark: "#0a0b0b", light: "#f1ff0a" },
    });
  } catch {}
  openModal(elements.depositModal);
}

function openAccountSheet() {
  if (!walletPublicKey) return openWalletModal();
  const address = walletPublicKey.toBase58();
  elements.accountTitle.textContent = handleFromPubkey(address);
  elements.accountAddress.textContent = address;
  elements.accountBalance.textContent = `${(walletBalanceSol ?? 0).toFixed(4)} SOL`;
  elements.accountJoined.textContent = String(joinedCount);
  elements.accountWon.textContent = String(wonCount);
  elements.accountMethod.textContent = walletKind === "passkey" ? "connected with passkey" : "connected with wallet";
  openModal(elements.accountModal);
}

async function placeBet() {
  if (!program || !walletPublicKey || !connectedWallet) return connectWallet();
  if (betInFlight) return;
  betInFlight = true;
  try {
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
    const signature = await connection.sendRawTransaction(signedTransaction.serialize(), {
      skipPreflight: false,
      maxRetries: 0,
      preflightCommitment: "confirmed",
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = (await connection.getSignatureStatuses([signature])).value[0];
      if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
      if (attempt === 19) throw new Error("Transaction confirmation timed out");
      await delay(1000);
    }
    const alreadyCounted = userJoinedThisRound();
    joinedRound = { roundId: currentRoundId, tier: selectedRoomTier };
    joinedCount += 1;
    localStorage.setItem("minuttery.joined", String(joinedCount));
    if (!alreadyCounted) applyPlayerCount(knownPlayers + 1);
    setMessage(`Tier ${selectedBetSol} SOL joined. May luck find you.`);
    await pollWorkerState(true);
    refreshWalletBalance();
  } catch (error) {
    setMessage(error.message || "Transaction could not be completed", true);
  } finally {
    betInFlight = false;
  }
}

function inviteText() {
  const site = window.location.origin;
  return `I'm in a 1-minute pot on minuttery.com on Solana. Join this minute to beat me!`;
}

function openInviteSheet() {
  elements.inviteMessage.value = inviteText();
  openModal(elements.inviteModal);
}

function shareInvite(channel) {
  const text = (elements.inviteMessage.value || inviteText()).trim();
  const url = window.location.origin;
  const encoded = encodeURIComponent(text);
  if (channel === "x") {
    window.open(`https://twitter.com/intent/tweet?text=${encoded}`, "_blank", "noopener");
    return;
  }
  if (channel === "telegram") {
    window.open(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encoded}`, "_blank", "noopener");
    return;
  }
  if (channel === "discord") {
    copyText(text, document.querySelector('[data-share="discord"]'));
    window.open("https://discord.com/channels/@me", "_blank", "noopener");
    return;
  }
  if (channel === "copy") {
    copyText(text, document.querySelector('[data-share="copy"]'));
  }
}

function openWithdrawSheet() {
  elements.withdrawStatus.textContent = "";
  elements.withdrawAmount.value = "";
  openModal(elements.withdrawModal);
}

async function sendWithdraw() {
  if (!connectedWallet || !walletPublicKey) return connectWallet();
  const destRaw = elements.withdrawTo.value.trim();
  const amountSol = Number(elements.withdrawAmount.value);
  elements.withdrawStatus.textContent = "";
  try {
    const dest = new web3.PublicKey(destRaw);
    if (!Number.isFinite(amountSol) || amountSol <= 0) throw new Error("Enter an amount.");
    const lamports = Math.round(amountSol * 1e9);
    const transaction = new web3.Transaction().add(
      web3.SystemProgram.transfer({
        fromPubkey: walletPublicKey,
        toPubkey: dest,
        lamports,
      }),
    );
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    transaction.feePayer = walletPublicKey;
    elements.withdrawStatus.textContent = "Confirm in your wallet…";
    const signed = await connectedWallet.signTransaction(transaction);
    const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    elements.withdrawStatus.textContent = `Sent. ${signature.slice(0, 16)}…`;
    refreshWalletBalance();
  } catch (error) {
    elements.withdrawStatus.textContent = error.message || "Withdraw failed";
  }
}

function openClaimSheet() {
  elements.claimStatus.textContent = "";
  elements.claimRoundId.value = String(joinedRound?.roundId ?? currentRoundId ?? "");
  if (!elements.claimTier.options.length) {
    ROOM_TIERS.forEach((sol, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${sol} SOL room`;
      elements.claimTier.appendChild(option);
    });
  }
  elements.claimTier.value = String(joinedRound?.tier ?? selectedRoomTier ?? 0);
  openModal(elements.claimModal);
}

async function claimRefundFromSheet() {
  joinedRound = {
    roundId: Number(elements.claimRoundId.value),
    tier: Number(elements.claimTier.value),
  };
  elements.claimStatus.textContent = "Preparing refund…";
  try {
    await refundRound();
    elements.claimStatus.textContent = "Refund submitted if the round was still open.";
  } catch (error) {
    elements.claimStatus.textContent = error.message || "Refund failed";
  }
}

function bindChrome() {
  elements.connect.addEventListener("click", openWalletModal);
  elements.balanceButton.addEventListener("click", openAccountSheet);
  elements.passkeyButton.addEventListener("click", signInWithPasskey);
  document.getElementById("disconnectWallet").addEventListener("click", disconnectWallet);
  document.getElementById("openDepositFromAccount").addEventListener("click", () => {
    closeModal(elements.accountModal);
    openDepositSheet();
  });
  document.getElementById("openWithdrawFromAccount").addEventListener("click", () => {
    closeModal(elements.accountModal);
    openWithdrawSheet();
  });
  document.getElementById("inviteButton").addEventListener("click", (event) => {
    flashActive(event.currentTarget);
    openInviteSheet();
  });
  document.getElementById("closeInviteModal").addEventListener("click", () => closeModal(elements.inviteModal));
  document.querySelectorAll("[data-share]").forEach((button) => {
    button.addEventListener("click", () => {
      flashActive(button);
      shareInvite(button.dataset.share);
    });
  });
  document.getElementById("closeWithdrawModal").addEventListener("click", () => closeModal(elements.withdrawModal));
  document.getElementById("withdrawSend").addEventListener("click", sendWithdraw);
  document.getElementById("openClaimSheet").addEventListener("click", () => {
    closeModal(elements.historyModal);
    openClaimSheet();
  });
  document.getElementById("closeClaimModal").addEventListener("click", () => closeModal(elements.claimModal));
  document.getElementById("claimRefund").addEventListener("click", claimRefundFromSheet);
  document.getElementById("copyDepositAddress").addEventListener("click", (event) => {
    copyText(walletPublicKey?.toBase58() || "", event.currentTarget);
  });
  document.getElementById("closeDepositModal").addEventListener("click", () => closeModal(elements.depositModal));
  document.getElementById("closeAccountModal").addEventListener("click", () => closeModal(elements.accountModal));
  elements.bet.addEventListener("click", placeBet);
  document.getElementById("closeWalletModal").addEventListener("click", closeWalletModal);
  document.getElementById("closeSettleModal").addEventListener("click", closeSettleModal);
  elements.settleClose.addEventListener("click", closeSettleModal);
  elements.settleRefund.addEventListener("click", refundRound);
  elements.winnerTicker.addEventListener("click", () => {
    historyPage = 0;
    openModal(elements.historyModal);
    loadPastWinners();
  });
  document.getElementById("closeHistoryModal").addEventListener("click", () => closeModal(elements.historyModal));
  document.getElementById("historyClose").addEventListener("click", () => closeModal(elements.historyModal));
  elements.historyPrev.addEventListener("click", () => {
    if (historyPage === 0) return;
    historyPage -= 1;
    loadPastWinners();
  });
  elements.historyNext.addEventListener("click", () => {
    if (!historyHasMore) return;
    historyPage += 1;
    loadPastWinners();
  });

  [
    elements.walletModal,
    elements.depositModal,
    elements.accountModal,
    elements.settleModal,
    elements.historyModal,
    elements.inviteModal,
    elements.withdrawModal,
    elements.claimModal,
  ].forEach((modal) => bindSheetDismiss(modal, () => closeModal(modal)));

  document.querySelectorAll(".bet-preset").forEach((button) =>
    button.addEventListener("click", () => {
      selectedRoomTier = ROOM_TIERS.indexOf(Number(button.dataset.amount));
      selectedBetSol = Number(button.dataset.amount);
      resetRoundStats();
      document.querySelectorAll(".bet-preset").forEach((item) => item.classList.remove("is-selected"));
      button.classList.add("is-selected");
      pollWorkerState(true);
    }),
  );

  document.querySelector('[data-wallet="phantom"]').addEventListener("click", () => {
    const phantom = getPhantom();
    if (phantom) connectProvider(phantom, "wallet");
    else window.location.href = `https://phantom.app/ul/browse/${encodeURIComponent(window.location.href)}`;
  });
  document.querySelector('[data-wallet="solflare"]').addEventListener("click", () => {
    if (window.solflare?.isSolflare) connectProvider(window.solflare, "wallet");
  });
  document.querySelector('[data-wallet="backpack"]').addEventListener("click", () => {
    const backpack = getBackpack();
    if (backpack) connectProvider(backpack, "wallet");
    else if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      window.location.href = `https://backpack.app/ul/v1/browse/${encodeURIComponent(window.location.href)}`;
    }
  });

  document.addEventListener("visibilitychange", () => {
    pageHidden = document.visibilityState === "hidden";
    if (!pageHidden) pollWorkerState(true);
  });
}

bindChrome();
currentRoundId = localRoundId();
syncClock()
  .catch(() => {})
  .finally(() => {
    clockReady = true;
    currentRoundId = localRoundId();
    pollWorkerState(true);
    loadWinnersFeed();
    updateClock();
  });
window.setInterval(showWinnerTick, 4000);

void API_BASE;
