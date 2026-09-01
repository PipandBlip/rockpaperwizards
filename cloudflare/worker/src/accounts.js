// Rock, Paper, Wizards — accounts and character profiles.
//
// Deliberately dependency-free and Workers-agnostic: everything here is
// plain JavaScript over WebCrypto (which Node 18+ and Cloudflare both
// provide) and a tiny async key/value `store`. The Durable Object in
// index.js wraps ctx.storage; server/test-accounts.js wraps a Map. That is
// what lets the whole account system be tested without deploying anything.
//
// One Durable Object per account, addressed by idFromName("u:" + lowercased
// name), so a name is unique by construction — there is no index to keep,
// no scan to do, and two people registering the same name at the same
// moment are serialised by the object itself.
//
// Storage keys inside one account's object:
//   acct            the account record (below)
//   sess:<hash>     one live session, hash = sha256 of the raw token
//
// Account record:
//   { name, lower, created, pass:{salt,hash,iter}, profile:{...}, cosmetics:{...} }

/* ------------------------------------------------------------------ shape */

const NAME_MIN = 3, NAME_MAX = 14;
const PASS_MIN = 8, PASS_MAX = 200;
const PBKDF2_ITER = 60000;   // Cloudflare Workers cap PBKDF2 at 100,000 — stay under it
const SESSION_MS = 60 * 24 * 60 * 60 * 1000;   // 60 days
const MAX_SESSIONS = 8;

// A result is the client's word for what just happened, so it is fenced in:
// one accepted report per RESULT_GAP, a hard ceiling per report, and a
// rolling daily ceiling. Someone determined can still inflate a profile —
// only the relay arbitrating matches could stop that — but nobody levels to
// the moon in an afternoon with a loop, and honest play never touches these.
const RESULT_GAP_MS = 12000;
const XP_PER_RESULT_CAP = 420;
const XP_PER_DAY_CAP = 7000;

export const LIMITS = { NAME_MIN, NAME_MAX, PASS_MIN, PASS_MAX };

/* ------------------------------------------------------------------ levels
   The curve every level display in the game reads from. Kept small and
   integer-only so the client can mirror it exactly (src/account.js) and a
   test can assert the two agree level for level. */

// experience needed to go from `level` to `level + 1`
export function needFor(level){
  const n = Math.max(1, level | 0);
  return 120 + 80 * (n - 1) + 12 * (n - 1) * (n - 1);
}
// total experience banked by the time you arrive at `level`
export function totalFor(level){
  let t = 0;
  for (let n = 1; n < Math.max(1, level | 0); n++) t += needFor(n);
  return t;
}
// where a raw experience total puts you
export function levelFor(xp){
  let level = 1, rest = Math.max(0, Math.floor(xp || 0));
  while (level < 999){
    const need = needFor(level);
    if (rest < need) break;
    rest -= need; level++;
  }
  return { level, into: rest, need: needFor(level) };
}

/* ------------------------------------------------------------------ xp
   Weighted, per the rule that beating a person is worth more than beating a
   bot and beating an Archmage is worth more than beating an Apprentice —
   so solo play still pays, but farming Apprentices is the slow road. */

const RIVAL_WEIGHT = [0.8, 1.15, 1.5];   // Apprentice, Adept, Archmage
const HUMAN_WEIGHT = 2.0;

export function xpForResult(r){
  if (!r || typeof r !== "object") return 0;
  if (r.mode === "escalation"){
    const waves = clampInt(r.waves, 0, 200), kills = clampInt(r.kills, 0, 999);
    return Math.min(XP_PER_RESULT_CAP, 15 + waves * 14 + kills * 5);
  }
  const rivals = Array.isArray(r.opponents) ? r.opponents.slice(0, 5) : [];
  if (!rivals.length) return 0;
  let weight = 0;
  for (const o of rivals){
    weight += (o && o.human) ? HUMAN_WEIGHT
                             : RIVAL_WEIGHT[clampInt(o && o.level, 0, 2)];
  }
  weight /= rivals.length;
  const crowd = 1 + 0.22 * (rivals.length - 1);
  const base = 18 + (r.won ? 55 : 0) + clampInt(r.roundsWon, 0, 9) * 6;
  return Math.min(XP_PER_RESULT_CAP, Math.round(base * weight * crowd));
}

function clampInt(v, lo, hi){
  const n = Math.floor(Number(v) || 0);
  return n < lo ? lo : n > hi ? hi : n;
}

/* ------------------------------------------------------------------ crypto */

const enc = new TextEncoder();

function b64(bytes){
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function bytes(n){ return crypto.getRandomValues(new Uint8Array(n)); }

async function sha256(text){
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return b64(new Uint8Array(d));
}
async function derive(pass, salt, iter){
  const key = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: iter, hash: "SHA-256" }, key, 256);
  return b64(new Uint8Array(bits));
}
// constant-time-ish compare, so a wrong password cannot be narrowed by timing
function same(a, b){
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ helpers */

export function cleanName(raw){
  return String(raw == null ? "" : raw).trim().replace(/\s+/g, " ").slice(0, NAME_MAX);
}
export function nameProblem(name){
  if (name.length < NAME_MIN) return "Names need at least " + NAME_MIN + " characters.";
  if (name.length > NAME_MAX) return "Names stop at " + NAME_MAX + " characters.";
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.'-]*$/.test(name)) return "Letters, numbers, spaces and - _ . ' only.";
  return null;
}
export function passProblem(pass){
  const p = String(pass == null ? "" : pass);
  if (p.length < PASS_MIN) return "Passwords need at least " + PASS_MIN + " characters.";
  if (p.length > PASS_MAX) return "That password is too long.";
  return null;
}
export function lower(name){ return cleanName(name).toLowerCase(); }

function freshAccount(name){
  return {
    v: 1,
    name, lower: name.toLowerCase(),
    created: 0,
    pass: null,
    profile: {
      xp: 0, duels: 0, wins: 0, losses: 0, roundsWon: 0,
      bestEsc: 0, bestWave: 0, lastAt: 0,
      // rolling daily cap bookkeeping
      dayKey: 0, dayXp: 0
    },
    // Nothing is unlocked yet on purpose — the wardrobe lands later, and this
    // is the shape it will land into, so no profile needs migrating for it.
    cosmetics: { unlocked: [], hat: null, cape: null }
  };
}

// what the client is allowed to see about itself
export function publicProfile(acct){
  const p = acct.profile, lv = levelFor(p.xp);
  return {
    name: acct.name,
    level: lv.level, into: lv.into, need: lv.need, xp: p.xp,
    duels: p.duels, wins: p.wins, losses: p.losses,
    bestEsc: p.bestEsc, bestWave: p.bestWave,
    cosmetics: acct.cosmetics
  };
}

/* ------------------------------------------------------------------ sessions */

async function issue(store, now){
  const raw = b64(bytes(24));
  await store.put("sess:" + await sha256(raw), { exp: now + SESSION_MS });
  await trimSessions(store, now);
  return raw;
}
async function trimSessions(store, now){
  const keys = await store.keys("sess:");
  const live = [];
  for (const k of keys){
    const s = await store.get(k);
    if (!s || s.exp <= now) await store.delete(k);
    else live.push({ k, exp: s.exp });
  }
  if (live.length > MAX_SESSIONS){
    live.sort((a, b) => a.exp - b.exp);
    for (const s of live.slice(0, live.length - MAX_SESSIONS)) await store.delete(s.k);
  }
}
async function sessionOk(store, token, now){
  if (typeof token !== "string" || !token) return false;
  const rec = await store.get("sess:" + await sha256(token));
  return !!(rec && rec.exp > now);
}

/* ------------------------------------------------------------------ handler
   One entry point. `path` is the bare action; `body` is the parsed JSON.
   Returns { status, body } — no Request/Response, so it is trivial to test. */

export async function handle(store, path, body, now){
  now = now || Date.now();
  body = body && typeof body === "object" ? body : {};
  const acct = await store.get("acct");

  switch (path){

    case "register": {
      const name = cleanName(body.name);
      const bad = nameProblem(name) || passProblem(body.pass);
      if (bad) return fail(400, bad);
      if (acct) return fail(409, "That name is taken. Try another, or sign in.");
      const a = freshAccount(name);
      const salt = b64(bytes(16));
      a.created = now;
      a.pass = { salt, iter: PBKDF2_ITER, hash: await derive(body.pass, salt, PBKDF2_ITER) };
      await store.put("acct", a);
      return { status: 200, body: { token: await issue(store, now), profile: publicProfile(a) } };
    }

    case "login": {
      const name = cleanName(body.name);
      if (!name || typeof body.pass !== "string") return fail(400, "Name and password, please.");
      // Same message either way: whether a name exists is not worth leaking.
      const no = () => fail(401, "That name and password do not match.");
      if (!acct || !acct.pass) return no();
      const got = await derive(body.pass, acct.pass.salt, acct.pass.iter);
      if (!same(got, acct.pass.hash)) return no();
      return { status: 200, body: { token: await issue(store, now), profile: publicProfile(acct) } };
    }

    case "me": {
      if (!acct || !await sessionOk(store, body.token, now)) return fail(401, "Signed out.");
      return { status: 200, body: { profile: publicProfile(acct) } };
    }

    case "signout": {
      if (typeof body.token === "string" && body.token) {
        await store.delete("sess:" + await sha256(body.token));
      }
      return { status: 200, body: { ok: true } };
    }

    case "result": {
      if (!acct || !await sessionOk(store, body.token, now)) return fail(401, "Signed out.");
      const p = acct.profile, r = body.result || {};
      // too soon after the last one: accepted, but worth nothing
      if (now - (p.lastAt || 0) < RESULT_GAP_MS){
        return { status: 200, body: { profile: publicProfile(acct), gained: 0, leveled: 0, throttled: true } };
      }
      const before = levelFor(p.xp).level;

      const day = Math.floor(now / 86400000);
      if (p.dayKey !== day){ p.dayKey = day; p.dayXp = 0; }
      const room = Math.max(0, XP_PER_DAY_CAP - p.dayXp);
      const gained = Math.min(room, xpForResult(r));

      p.xp += gained;
      p.dayXp += gained;
      p.lastAt = now;
      if (r.mode === "escalation"){
        p.bestEsc = Math.max(p.bestEsc, clampInt(r.score, 0, 9999999));
        p.bestWave = Math.max(p.bestWave, clampInt(r.waves, 0, 200));
      } else {
        p.duels++;
        if (r.won) p.wins++; else p.losses++;
        p.roundsWon += clampInt(r.roundsWon, 0, 9);
      }
      await store.put("acct", acct);
      const after = levelFor(p.xp).level;
      return { status: 200, body: {
        profile: publicProfile(acct), gained, leveled: Math.max(0, after - before)
      } };
    }
  }
  return fail(404, "No such action.");
}

function fail(status, error){ return { status, body: { error } }; }
