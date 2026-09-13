// Pages Function: moderation/cleanup for the global Escalation leaderboard.
//
// POST /api/leaderboard-admin, header x-admin-key, body { name }. This is
// NOT a player-facing action — there is no admin role or login anywhere in
// this app, on purpose (see docs/accounts.md: no password reset either, for
// the same reason). This route exists only to drop one name's row — an
// offensive name, or a test account that made it onto the live board — and
// it does nothing at all unless LEADERBOARD_ADMIN_KEY has been set on the
// worker that owns RPWLeaderboard (`wrangler secret put
// LEADERBOARD_ADMIN_KEY`, run from cloudflare/worker) and the caller
// supplies the same value. This Function is a thin forward; the actual
// check is in cloudflare/worker/src/index.js (RPWLeaderboard.fetch), which
// is what actually touches storage.

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" }
});

export async function onRequestPost(context){
  if (!context.env.RPW_LEADERBOARD) return json({ error: "not configured" }, 501);
  let body;
  try { body = await context.request.json(); }
  catch (e) { return json({ error: "Expected JSON." }, 400); }
  const id = context.env.RPW_LEADERBOARD.idFromName("global-escalation");
  const stub = context.env.RPW_LEADERBOARD.get(id);
  const res = await stub.fetch("https://leaderboard/remove", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-key": context.request.headers.get("x-admin-key") || ""
    },
    body: JSON.stringify({ name: body && body.name })
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
