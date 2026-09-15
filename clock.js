import { API_BASE, ROUND_MS } from "./config.js";

const localClockEpoch = Date.now() - performance.now();
let clockOffsetMs = 0;
let lastSyncAt = 0;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function sampleOffset(url) {
  const t0 = performance.now();
  const sentAt = Date.now();
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const t1 = performance.now();
  const rtt = t1 - t0;
  let serverMs = null;

  const raw = await response.text();
  if (raw) {
    try {
      const json = JSON.parse(raw);
      const candidate = json.serverNow ?? json.now ?? json.ts ?? json.time;
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        serverMs = candidate < 1e12 ? candidate * 1000 : candidate;
      }
    } catch {
      // Date header fallback below.
    }
  }

  const dateHeader = response.headers.get("date");
  if (serverMs == null && dateHeader) {
    const parsed = Date.parse(dateHeader);
    if (!Number.isNaN(parsed)) serverMs = parsed;
  }

  if (serverMs == null) return null;
  const localMid = sentAt + rtt / 2;
  return serverMs - localMid;
}

export async function syncClock() {
  const endpoints = [`${API_BASE}/winners?limit=1`];
  const samples = [];

  for (const url of endpoints) {
    for (let i = 0; i < 2 && samples.length < 4; i += 1) {
      try {
        const offset = await sampleOffset(url);
        if (offset != null && Math.abs(offset) < 10 * 60_000) samples.push(offset);
      } catch {
        break;
      }
    }
    if (samples.length >= 2) break;
  }

  if (samples.length) {
    clockOffsetMs = median(samples);
    lastSyncAt = Date.now();
  }
  return clockOffsetMs;
}

export function maybeResyncClock() {
  if (Date.now() - lastSyncAt > 45_000) {
    syncClock().catch(() => {});
  }
}

export function syncedNow() {
  return localClockEpoch + performance.now() + clockOffsetMs;
}

export function clockOffset() {
  return clockOffsetMs;
}

export function elapsedInRound(now = syncedNow()) {
  return ((now % ROUND_MS) + ROUND_MS) % ROUND_MS;
}

export function roundSeconds(now = syncedNow()) {
  return Math.floor(elapsedInRound(now) / 1000);
}

export function localRoundId(now = syncedNow()) {
  return Math.floor(now / ROUND_MS);
}