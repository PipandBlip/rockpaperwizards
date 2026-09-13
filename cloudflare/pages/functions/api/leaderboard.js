// Pages Function: the GLOBAL Escalation leaderboard for Rock, Paper, Wizards.
//
// GET /api/leaderboard — no token, nothing to identify: reading the board is
// public, the way the board itself is public. Rows are submitted server-side
// by cloudflare/worker/src/index.js (RPWAccount.fetch) whenever a signed-in
// wizard's Escalation result beats their own previous best; the ranking
// itself lives in cloudflare/worker/src/leaderboard.js.
//
// A static path like this one is matched ahead of the api/[[route]].js
// catch-all, so it does not need to squeeze into that file's POST-only,
// token-routed shape — this is a plain, unauthenticated GET.

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" }
});

export async function onRequestGet(context){
  if (!context.env.RPW_LEADERBOARD) return json({ rows: [] });
  const id = context.env.RPW_LEADERBOARD.idFromName("global-escalation");
  const stub = context.env.RPW_LEADERBOARD.get(id);
  let res;
  try { res = await stub.fetch("https://leaderboard/top"); }
  catch (e) { return json({ rows: [] }); }
  let out = { rows: [] };
  try { out = await res.json(); } catch (e) {}
  return json(out, res.status);
}
