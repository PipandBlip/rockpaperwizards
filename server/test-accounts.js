// Accounts and profiles — end to end, without Cloudflare.
//
// cloudflare/worker/src/accounts.js is deliberately free of Workers imports:
// it takes a tiny async key/value store and returns {status, body}. So the
// real handler — the same code the Durable Object runs — can be driven here
// over a Map, including the routing the Pages function does in front of it.
//
//   node server/test-accounts.js

import {
  handle, needFor, totalFor, levelFor, xpForResult,
  cleanName, nameProblem, passProblem
} from "../cloudflare/worker/src/accounts.js";
import { readFileSync } from "node:fs";

let pass = 0, failed = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { failed++; console.log("  FAIL " + name); }
};
const eq = (name, got, want) =>
  ok(name + (got === want ? "" : "   (got " + JSON.stringify(got) + ", wanted " + JSON.stringify(want) + ")"),
     got === want);

/* --------------------------------------------------------------- the world
   One Map per account, plus the name-routing the Pages function performs, so
   what these tests drive is the whole request path and not just one object. */

const world = new Map();   // lower-name -> Map(key -> value)

function storeFor(who){
  if (!world.has(who)) world.set(who, new Map());
  const m = world.get(who);
  return {
    get: async k => structuredClone(m.get(k)),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async k => { m.delete(k); },
    keys: async prefix => [...m.keys()].filter(k => k.startsWith(prefix))
  };
}

// mirrors cloudflare/pages/functions/api/[[route]].js
async function api(action, body, now = Date.now()){
  let who = "", inner = { ...body };
  if (action === "register" || action === "login"){
    who = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 14).toLowerCase();
  } else {
    const token = String(body.token || ""), dot = token.indexOf(".");
    if (dot > 0){ who = token.slice(0, dot); inner.token = token.slice(dot + 1); }
  }
  if (!who) return { status: 401, body: { error: "Signed out." } };
  const out = await handle(storeFor(who), action, inner, now);
  if (out.body && out.body.token) out.body.token = who + "." + out.body.token;
  return out;
}

/* --------------------------------------------------------------- the levels */

console.log("levels");
eq("level 1 starts at zero experience", totalFor(1), 0);
eq("the first level costs 120", needFor(1), 120);
eq("levels get dearer as you climb", needFor(5) > needFor(4) && needFor(4) > needFor(3), true);
eq("119 experience is still level 1", levelFor(119).level, 1);
eq("120 experience is level 2", levelFor(120).level, 2);
eq("a level boundary reports nothing banked into it", levelFor(120).into, 0);
eq("part way up reports how far in you are", levelFor(150).into, 30);
eq("and what the level costs", levelFor(150).need, needFor(2));
ok("the curve and the totals agree at every level to 100", (() => {
  for (let n = 1; n <= 100; n++){
    const at = levelFor(totalFor(n));
    if (at.level !== n || at.into !== 0) return false;
    if (levelFor(totalFor(n + 1) - 1).level !== n) return false;
  }
  return true;
})());

/* --------------------------------------------------------------- the payout */

console.log("\nexperience");
const bot = l => ({ human: false, level: l });
const human = () => ({ human: true });
const duel = (o, extra) => ({ mode: "duel", opponents: o, ...extra });

ok("a win pays more than a loss",
   xpForResult(duel([bot(1)], { won: true })) > xpForResult(duel([bot(1)], { won: false })));
ok("an Archmage pays more than an Apprentice",
   xpForResult(duel([bot(2)], { won: true })) > xpForResult(duel([bot(0)], { won: true })));
ok("an Adept sits between the two", (() => {
  const a = xpForResult(duel([bot(0)], { won: true })),
        b = xpForResult(duel([bot(1)], { won: true })),
        c = xpForResult(duel([bot(2)], { won: true }));
  return a < b && b < c;
})());
ok("a person pays more than any bot",
   xpForResult(duel([human()], { won: true })) > xpForResult(duel([bot(2)], { won: true })));
ok("a crowded room pays more than a one on one",
   xpForResult(duel([human(), human(), human()], { won: true })) >
   xpForResult(duel([human()], { won: true })));
ok("rounds won add to the payout",
   xpForResult(duel([bot(1)], { won: true, roundsWon: 5 })) >
   xpForResult(duel([bot(1)], { won: true, roundsWon: 2 })));
ok("an escalation run pays on waves and kills",
   xpForResult({ mode: "escalation", waves: 7, kills: 22 }) >
   xpForResult({ mode: "escalation", waves: 2, kills: 4 }));
eq("a duel against nobody pays nothing", xpForResult(duel([], { won: true })), 0);
ok("nothing pays more than the per-result ceiling",
   xpForResult({ mode: "escalation", waves: 200, kills: 999 }) <= 420 &&
   xpForResult(duel([human(),human(),human(),human(),human()], { won: true, roundsWon: 9 })) <= 420);
ok("junk in pays nothing out",
   xpForResult(null) === 0 && xpForResult({}) === 0 && xpForResult({ mode: "duel" }) === 0);

/* --------------------------------------------------------------- names */

console.log("\nnames and passwords");
eq("surrounding space is trimmed", cleanName("  Merlin  "), "Merlin");
eq("runs of space collapse", cleanName("Old   Man"), "Old Man");
eq("long names are clipped", cleanName("x".repeat(40)).length, 14);
ok("a two letter name is refused", !!nameProblem("ab"));
ok("a normal name is fine", nameProblem("Merlin") === null);
ok("a name with punctuation in it is fine", nameProblem("O'Brien-7") === null);
ok("a name of symbols is refused", !!nameProblem("!!!"));
ok("a short password is refused", !!passProblem("abc"));
ok("an eight character password is fine", passProblem("abcdefgh") === null);

/* --------------------------------------------------------------- accounts */

const T0 = 1_700_000_000_000;
const later = n => T0 + n;
const run = async () => {
  console.log("\naccounts");

  let r = await api("register", { name: "Merlin", pass: "hunter2hunter2" }, T0);
  eq("registering opens an account", r.status, 200);
  const merlin = r.body.token;
  ok("and hands back a session token", typeof merlin === "string" && merlin.includes("."));
  eq("a new wizard starts at level 1", r.body.profile.level, 1);
  eq("with no experience", r.body.profile.xp, 0);
  eq("no duels behind them", r.body.profile.duels, 0);
  ok("and an empty wardrobe waiting for items",
     Array.isArray(r.body.profile.cosmetics.unlocked) && r.body.profile.cosmetics.unlocked.length === 0);

  r = await api("register", { name: "merlin", pass: "somethingelse1" }, T0);
  eq("the same name cannot be taken twice, whatever the case", r.status, 409);

  r = await api("register", { name: "ab", pass: "hunter2hunter2" }, T0);
  eq("a bad name is refused", r.status, 400);
  r = await api("register", { name: "Gandalf", pass: "short" }, T0);
  eq("a weak password is refused", r.status, 400);

  r = await api("login", { name: "Merlin", pass: "hunter2hunter2" }, later(1000));
  eq("the right password signs you in", r.status, 200);
  const second = r.body.token;
  ok("a second sign-in issues its own token", second !== merlin);

  r = await api("login", { name: "Merlin", pass: "hunter3hunter3" }, later(1000));
  eq("the wrong password does not", r.status, 401);
  r = await api("login", { name: "Nobody", pass: "hunter2hunter2" }, later(1000));
  eq("nor does a name that was never registered", r.status, 401);
  eq("and it says the same thing either way, so no name can be probed",
     r.body.error, "That name and password do not match.");

  r = await api("me", { token: merlin }, later(2000));
  eq("a token reads its own profile back", r.body.profile.name, "Merlin");
  r = await api("me", { token: "merlin.notarealtoken" }, later(2000));
  eq("a forged token does not", r.status, 401);
  r = await api("me", { token: "" }, later(2000));
  eq("and neither does no token at all", r.status, 401);

  console.log("\nduels and levelling");
  let t = later(10000);
  r = await api("result", { token: merlin, result: duel([bot(1)], { won: true, roundsWon: 2 }) }, t);
  eq("winning a duel pays experience", r.body.gained > 0, true);
  eq("the duel is counted", r.body.profile.duels, 1);
  eq("as a win", r.body.profile.wins, 1);
  const afterOne = r.body.profile.xp;

  r = await api("result", { token: merlin, result: duel([bot(1)], { won: true }) }, t + 500);
  eq("a second result moments later pays nothing", r.body.gained, 0);
  eq("and says so", r.body.throttled, true);
  eq("and does not double-count the duel", r.body.profile.duels, 1);

  t += 60000;
  r = await api("result", { token: merlin, result: duel([bot(1)], { won: false }) }, t);
  eq("a loss still pays something", r.body.gained > 0, true);
  eq("and is counted as a loss", r.body.profile.losses, 1);
  ok("experience only ever goes up", r.body.profile.xp > afterOne);

  // climb to a level-up
  let leveled = 0, guard = 0;
  while (leveled === 0 && guard++ < 40){
    t += 60000;
    r = await api("result", { token: merlin, result: duel([human()], { won: true, roundsWon: 3 }) }, t);
    leveled = r.body.leveled;
  }
  eq("enough duels and you level up", leveled >= 1, true);
  eq("the profile shows the new level", r.body.profile.level >= 2, true);
  ok("and how far into it you are", r.body.profile.into < r.body.profile.need);

  console.log("\nlimits");
  // Hammer it for a day's worth of wins and the daily ceiling holds. The run
  // has to sit inside ONE calendar day to be a test of the cap rather than a
  // test of the reset, so it starts at 01:00 UTC the following day and the
  // 300 results at a minute apart land five hours later, well before midnight.
  const DAY = 86400000;
  let day = (Math.floor(t / DAY) + 1) * DAY + 3600000;
  let before = r.body.profile.xp;
  for (let i = 0; i < 300; i++){
    day += 60000;
    r = await api("result", { token: merlin, result: duel([human()], { won: true, roundsWon: 9 }) }, day);
  }
  const gainedInADay = r.body.profile.xp - before;
  ok("a day of grinding cannot beat the daily ceiling   (" + gainedInADay + ")", gainedInADay <= 7000);
  ok("and the day's counter resets tomorrow", await (async () => {
    const t2 = day + DAY * 2;
    const res = await api("result", { token: merlin, result: duel([human()], { won: true }) }, t2);
    return res.body.gained > 0;
  })());

  console.log("\nsigning out");
  r = await api("signout", { token: merlin }, day);
  eq("signing out is accepted", r.status, 200);
  r = await api("me", { token: merlin }, day);
  eq("and the token stops working", r.status, 401);
  r = await api("me", { token: second }, day);
  eq("but the other device stays signed in", r.status, 200);

  const old = await api("me", { token: second }, day + 61 * DAY);
  eq("a session older than sixty days has expired", old.status, 401);

  console.log("\nseparate people");
  r = await api("register", { name: "Nimue", pass: "differentpass1" }, day);
  eq("a second wizard registers cleanly", r.status, 200);
  eq("and starts at level 1 with nothing", r.body.profile.xp, 0);
  const nimue = r.body.token;
  r = await api("me", { token: nimue }, day);
  eq("their profile is their own", r.body.profile.name, "Nimue");
  r = await api("me", { token: "nimue." + merlin.split(".")[1] }, day);
  eq("and one wizard's token is no use on another's account", r.status, 401);

  /* ------------------------------------------------------------- the mirror
     The menu draws an experience bar without asking the server, so
     src/account.js carries its own copy of the curve. If the two ever drift
     the bar lies about how close you are to a level. Load the browser file
     against a stub window and compare them outright. */

  console.log("\nthe client's copy of the curve");
  const stub = { window: {}, localStorage: { getItem: () => null, setItem(){}, removeItem(){} } };
  new Function("window", "localStorage", readFileSync("src/account.js", "utf8"))(stub.window, stub.localStorage);
  const client = stub.window.RPWA;
  ok("src/account.js exposes RPWA", !!client);
  ok("the cost of every level to 300 matches the server", (() => {
    for (let n = 1; n <= 300; n++) if (client.needFor(n) !== needFor(n)) return false;
    return true;
  })());
  ok("and so does the level any experience total lands on", (() => {
    for (let xp = 0; xp <= 400000; xp += 37){
      const a = client.levelFor(xp), b = levelFor(xp);
      if (a.level !== b.level || a.into !== b.into || a.need !== b.need) return false;
    }
    return true;
  })());
  eq("a signed-out client calls itself Guest", client.name, "Guest");
  eq("and knows it is signed out", client.signedIn, false);

  console.log("\n" + pass + " passing" + (failed ? ", " + failed + " FAILED" : ""));
  process.exit(failed ? 1 : 0);
};
run();
