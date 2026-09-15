import { web3 } from "https://esm.sh/@coral-xyz/anchor@0.30.1?bundle";

const RP_NAME = "minuttery";
const STORAGE_KEY = "minuttery.passkey.v1";
const PRF_SALT = new TextEncoder().encode("minuttery:solana:ed25519:v1");

function bufferToB64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64ToBuffer(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function hostname() {
  return window.location.hostname === "localhost" ? "localhost" : window.location.hostname;
}

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function writeStore(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function getPrfBytes(credential) {
  const results = credential.getClientExtensionResults?.()?.prf?.results?.first;
  if (!results) {
    throw new Error("This device created a passkey, but it does not expose PRF. Use a wallet instead.");
  }
  return new Uint8Array(results);
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function keypairFromPrf(prf) {
  const seed = await sha256(prf);
  return web3.Keypair.fromSeed(seed);
}

function publicKeyOptions(challenge, extra = {}) {
  return {
    challenge,
    rpId: hostname(),
    userVerification: "required",
    extensions: {
      prf: { eval: { first: PRF_SALT } },
    },
    ...extra,
  };
}

export function passkeysSupported() {
  return typeof window.PublicKeyCredential === "function";
}

export async function createOrGetPasskeyWallet() {
  if (!passkeysSupported()) {
    throw new Error("Passkeys are not available in this browser.");
  }

  const stored = readStore();
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  try {
    const existing = await navigator.credentials.get({
      publicKey: publicKeyOptions(challenge, stored?.id
        ? { allowCredentials: [{ type: "public-key", id: b64ToBuffer(stored.id) }] }
        : {}),
      mediation: "optional",
    });
    if (existing) {
      const keypair = await keypairFromPrf(getPrfBytes(existing));
      writeStore({
        id: bufferToB64(existing.rawId),
        pubkey: keypair.publicKey.toBase58(),
      });
      return makeWallet(keypair);
    }
  } catch {
    // No saved passkey yet — create one below.
  }

  const userId = crypto.getRandomValues(new Uint8Array(16));
  const created = await navigator.credentials.create({
    publicKey: {
      rp: { name: RP_NAME, id: hostname() },
      user: {
        id: userId,
        name: `minuttery-${bufferToB64(userId).slice(0, 8)}`,
        displayName: "minuttery",
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -8 },
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: "preferred",
        requireResidentKey: false,
        userVerification: "required",
      },
      timeout: 120000,
      extensions: {
        prf: { eval: { first: PRF_SALT } },
      },
    },
  });

  if (!created) throw new Error("Passkey creation was cancelled.");

  let prf;
  try {
    prf = getPrfBytes(created);
  } catch {
    const followUp = await navigator.credentials.get({
      publicKey: publicKeyOptions(crypto.getRandomValues(new Uint8Array(32)), {
        allowCredentials: [{ type: "public-key", id: created.rawId }],
      }),
    });
    prf = getPrfBytes(followUp);
  }

  const keypair = await keypairFromPrf(prf);
  writeStore({
    id: bufferToB64(created.rawId),
    pubkey: keypair.publicKey.toBase58(),
  });
  return makeWallet(keypair);
}

function makeWallet(keypair) {
  return {
    kind: "passkey",
    publicKey: keypair.publicKey,
    async connect() {
      return { publicKey: keypair.publicKey };
    },
    async disconnect() {},
    async signTransaction(transaction) {
      transaction.partialSign(keypair);
      return transaction;
    },
    async signAllTransactions(transactions) {
      transactions.forEach((tx) => tx.partialSign(keypair));
      return transactions;
    },
  };
}

export function handleFromPubkey(address) {
  const chunks = ["amber", "lime", "onyx", "volt", "jade", "flux", "nova", "apex"];
  const tails = ["fox", "reef", "byte", "mint", "spark", "node", "tide", "quip"];
  let hash = 0;
  for (let i = 0; i < address.length; i += 1) hash = (hash * 33 + address.charCodeAt(i)) >>> 0;
  return `${chunks[hash % chunks.length]}${tails[(hash >> 4) % tails.length]}`;
}