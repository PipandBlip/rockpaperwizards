// Rock, Paper, Wizards — the global Escalation leaderboard.
//
// One row per wizard: their best-ever Escalation run. That is the whole
// design — it is what stops one very active player from occupying every
// row on the board with runs of their own, which is exactly what the old
// board did (it kept your last eight runs in THIS BROWSER's localStorage
// and called that "Escalation records" — global-sounding, but it was only
// ever your own history, and a table of eight rows all reading the same
// name is what that looked like).
//
// Storage-agnostic like accounts.js: a tiny async key/value `store`, so the
// ranking rule can be tested in Node (server/test-leaderboard.js) without
// deploying anything. The Cloudflare Durable Object wrapper (one instance,
// addressed by a fixed name, so there is exactly one board) lives in
// cloudflare/worker/src/index.js.
//
// Storage key:
//   top    array of { key, name, s, w, k, p, d }, sorted by score descending,
//          `key` is the lowercased name (dedupe key), capped at MAX_ROWS.
//          p is how many wizards were in that run (co-op inflates the score,
//          so it rides along as context) — rows written before this field
//          existed simply don't have it, and every reader treats that as
//          "unknown", not zero.

const MAX_ROWS = 50;   // rows kept in storage — generous headroom over TOP_N
const TOP_N = 20;      // rows a read ever returns; the client only shows 6

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v) || 0);
  return n < lo ? lo : n > hi ? hi : n;
}
// Mirrors cleanName in cloudflare/worker/src/index.js (rooms) and accounts.js
// (cleanName there also lowercases and enforces the 3-14 length window at
// registration) — this copy exists so leaderboard.js stays dependency-free,
// same reason accounts.js does not import from index.js.
function cleanName(n) {
  return String(n == null ? "" : n).replace(/[^\w \-'.]/g, "").trim().slice(0, 14) || "Wizard";
}

// A run just reported. Kept only when it beats that name's own previous
// best on the board — a worse run from someone already on the board changes
// nothing. Returns the row that ended up stored for this name (their best),
// or null if nothing was submitted (a non-positive score).
export async function submit(store, body) {
  const name = cleanName(body && body.name);
  const s = clampInt(body && body.s, 0, 9999999);
  const w = clampInt(body && body.w, 0, 200);
  const k = clampInt(body && body.k, 0, 999);
  const p = clampInt(body && body.p, 1, 99);   // party size; missing/junk clamps to solo (1)
  if (s <= 0) return null;
  const key = name.toLowerCase();
  let list = (await store.get("top")) || [];
  const i = list.findIndex(r => r.key === key);
  if (i >= 0 && s <= list[i].s) return list[i];   // not a new best; the board is unchanged
  const row = { key, name, s, w, k, p, d: Date.now() };
  list = i >= 0 ? list.slice(0, i).concat(list.slice(i + 1)) : list;
  list.push(row);
  list.sort((a, b) => b.s - a.s);
  if (list.length > MAX_ROWS) list = list.slice(0, MAX_ROWS);
  await store.put("top", list);
  return row;
}

// The board as the client draws it: the id and internal sort key are ours
// to change later, so only the display fields cross the wire.
export async function top(store) {
  const list = (await store.get("top")) || [];
  return list.slice(0, TOP_N).map(r => ({ n: r.name, s: r.s, w: r.w, k: r.k, p: r.p }));
}

// Drop one wizard's row — moderation (an offensive name) or cleanup (a test
// account that made it onto a live board), not something a player ever
// triggers. Matched the same way `submit` dedupes, by lowercased name, so it
// finds a row regardless of how the name was capitalised when it was set.
// Returns whether a row was actually removed. The caller (RPWLeaderboard in
// index.js) is what gates who may call this — this function trusts whatever
// key it is given.
export async function remove(store, name) {
  const key = String(name == null ? "" : name).trim().toLowerCase();
  if (!key) return false;
  const list = (await store.get("top")) || [];
  const next = list.filter(r => r.key !== key);
  if (next.length === list.length) return false;
  await store.put("top", next);
  return true;
}

export const LIMITS = { MAX_ROWS, TOP_N };
