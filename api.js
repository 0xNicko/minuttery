import { API_BASE, WINNERS_PAGE_SIZE } from "./config.js";

let syncSupported = true;

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

async function getJson(path) {
  const response = await fetch(apiUrl(path), {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const error = new Error(`API ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function fetchSyncState() {
  if (!syncSupported) return null;
  try {
    const data = await getJson("/winners?limit=1");
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    if (data.serverNow == null && data.roundId == null) return null;
    return data;
  } catch (error) {
    if (error.status === 404 || error.status === 405) syncSupported = false;
    return null;
  }
}

export async function fetchWinners({ limit = WINNERS_PAGE_SIZE, offset = 0, roundId, tier } = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (offset) params.set("offset", String(offset));
  if (roundId != null) params.set("roundId", String(roundId));
  if (tier != null) params.set("tier", String(tier));

  const data = await getJson(`/winners?${params.toString()}`);
  if (Array.isArray(data)) {
    return {
      rows: data,
      total: offset === 0 && data.length < limit ? data.length : null,
      hasMore: data.length === limit,
    };
  }
  const rows = data.rows || data.items || data.winners || [];
  const total = data.total ?? data.count ?? null;
  return {
    rows,
    total,
    hasMore: total != null ? offset + rows.length < total : rows.length === limit,
  };
}

export async function findWinnerRow(roundId, roomTier) {
  const targeted = await fetchWinners({
    limit: 20,
    roundId,
    tier: roomTier,
  }).catch(() => null);

  const pool = targeted?.rows?.length
    ? targeted.rows
    : (await fetchWinners({ limit: 40 })).rows;

  const exact = pool.find(
    (row) => Number(row.roundId) === Number(roundId) && Number(row.tier) === Number(roomTier),
  );
  if (exact?.winner) return exact;
  return (
    pool.find((row) => Number(row.roundId) === Number(roundId) && row.winner) ||
    pool.find((row) => Number(row.roundId) === Number(roundId) && row.kind === "refunded") ||
    exact ||
    null
  );
}

export function roomFromSync(sync, roomTier) {
  if (!sync) return null;
  const rooms = sync.rooms || sync.rounds || [];
  if (Array.isArray(rooms)) {
    return (
      rooms.find((room) => Number(room.tier) === Number(roomTier)) ||
      rooms.find((room) => Number(room.roomTier) === Number(roomTier)) ||
      null
    );
  }
  return null;
}
