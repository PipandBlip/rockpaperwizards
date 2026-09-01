// Pages Function: the accounts API for Rock, Paper, Wizards.
//
// Everything under /api/* lands here. The job is small: work out WHICH
// account Durable Object this request is about, then hand the parsed body
// straight to it. All the rules — validation, hashing, sessions, the
// experience curve — live in the worker's accounts.js.
//
// Which object? Accounts are keyed by name, so:
//   register / login  — the name is in the body
//   me / result / signout — the caller has a token, and a token is
//                           "<lowercased name>.<secret>", so the name is
//                           the part before the first dot
//
// That token shape is why no shared secret is needed anywhere: the secret
// half is only ever compared against a hash held inside that one account's
// own storage.

const ACTIONS = new Set(["register", "login", "me", "result", "signout"]);

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" }
});

export async function onRequest(context){
  if (context.request.method !== "POST") return json({ error: "POST only." }, 405);
  const action = (context.params.route || []).join("/");
  if (!ACTIONS.has(action)) return json({ error: "No such action." }, 404);

  let body;
  try { body = await context.request.json(); }
  catch (e) { return json({ error: "Expected JSON." }, 400); }
  if (!body || typeof body !== "object") return json({ error: "Expected JSON." }, 400);

  // find the account this is about
  let who = "";
  if (action === "register" || action === "login"){
    who = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 14).toLowerCase();
  } else {
    const token = String(body.token || "");
    const dot = token.indexOf(".");
    if (dot > 0){
      who = token.slice(0, dot);
      body = { ...body, token: token.slice(dot + 1) };   // the object sees only its half
    }
  }
  if (!who) return json({ error: action === "register" || action === "login"
    ? "Name and password, please." : "Signed out." }, action === "register" || action === "login" ? 400 : 401);

  const id = context.env.RPW_ACCOUNT.idFromName("u:" + who);
  const stub = context.env.RPW_ACCOUNT.get(id);
  const res = await stub.fetch(new Request("https://account/" + action, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }));

  const out = await res.json();
  // Hand the token back in the form the client stores and sends: the object
  // only ever knows its own half, so the name is glued back on out here.
  if (out && out.token) out.token = who + "." + out.token;
  return json(out, res.status);
}
