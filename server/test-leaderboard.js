// The global Escalation leaderboard — end to end, without Cloudflare.
//
// cloudflare/worker/src/leaderboard.js is deliberately free of Workers
// imports: it takes a tiny async key/value store and returns rows. So the
// real ranking logic — the same code the Durable Object runs — can be
// driven here over a Map.
//
//   node server/test-leaderboard.js

import { submit, top, remove, LIMITS } from "../cloudflare/worker/src/leaderboard.js";

let pass = 0, failed = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { failed++; console.log("  FAIL " + name); }
};
const eq = (name, got, want) =>
  ok(name + (got === want ? "" : "   (got " + JSON.stringify(got) + ", wanted " + JSON.stringify(want) + ")"),
     got === want);

function freshStore(){
  const m = new Map();
  return {
    get: async k => structuredClone(m.get(k)),
    put: async (k, v) => { m.set(k, structuredClone(v)); }
  };
}

const run = async () => {
  console.log("the board starts empty");
  let store = freshStore();
  eq("nothing submitted, nothing to show", (await top(store)).length, 0);

  console.log("\none run");
  store = freshStore();
  await submit(store, { name: "Green", s: 4200, w: 6, k: 14, p: 6 });
  let rows = await top(store);
  eq("one row", rows.length, 1);
  eq("the name made it through", rows[0].n, "Green");
  eq("so did the score", rows[0].s, 4200);
  eq("the wave", rows[0].w, 6);
  eq("and the kills", rows[0].k, 14);
  eq("and how many wizards were actually in the run", rows[0].p, 6);

  console.log("\nparty size: how big the run actually was");
  store = freshStore();
  await submit(store, { name: "Solo", s: 500, w: 3, k: 2 });   // no p at all — an old client, or a solo run
  await submit(store, { name: "Crew", s: 900, w: 5, k: 9, p: 4 });
  await submit(store, { name: "Reckless", s: 300, w: 2, k: 1, p: 9999 });   // absurd, gets clamped
  rows = await top(store);
  eq("a run reported with no party size at all defaults to solo",
     rows.find(r => r.n === "Solo").p, 1);
  eq("a real party size comes through as reported",
     rows.find(r => r.n === "Crew").p, 4);
  ok("an absurd party size is clamped to something sane   (" + rows.find(r => r.n === "Reckless").p + ")",
     rows.find(r => r.n === "Reckless").p <= 99);

  console.log("\nthis is what the bug looked like: the same player, six times");
  store = freshStore();
  await submit(store, { name: "Green", s: 100, w: 1, k: 1 });
  await submit(store, { name: "Green", s: 200, w: 2, k: 2 });
  await submit(store, { name: "Green", s: 300, w: 3, k: 3 });
  await submit(store, { name: "Green", s: 400, w: 4, k: 4 });
  rows = await top(store);
  eq("one player only ever occupies one row, however many times they play", rows.length, 1);
  eq("and it is their best run, not their most recent one", rows[0].s, 400);

  console.log("\nmultiple players");
  store = freshStore();
  await submit(store, { name: "Green", s: 900, w: 8, k: 20 });
  await submit(store, { name: "Hermes", s: 1500, w: 10, k: 30 });
  await submit(store, { name: "Callum", s: 300, w: 3, k: 5 });
  rows = await top(store);
  eq("everyone who has played shows up", rows.length, 3);
  eq("ranked highest score first", rows.map(r => r.n).join(","), "Hermes,Green,Callum");
  ok("scores only ever go down the list", rows[0].s >= rows[1].s && rows[1].s >= rows[2].s);

  console.log("\na worse run does not knock a better one off the board");
  store = freshStore();
  await submit(store, { name: "Green", s: 1000, w: 9, k: 25 });
  await submit(store, { name: "Green", s: 50, w: 1, k: 0 });
  rows = await top(store);
  eq("still one row for Green", rows.length, 1);
  eq("still the earlier, better score", rows[0].s, 1000);

  console.log("\nnames are matched without regard to case");
  store = freshStore();
  await submit(store, { name: "Green", s: 500, w: 5, k: 10 });
  await submit(store, { name: "GREEN", s: 600, w: 6, k: 12 });
  rows = await top(store);
  eq("GREEN and Green are the same wizard", rows.length, 1);
  eq("and the better of the two scores won", rows[0].s, 600);

  console.log("\njunk in");
  store = freshStore();
  eq("a zero score is not a run", await submit(store, { name: "Nobody", s: 0, w: 0, k: 0 }), null);
  eq("neither is a negative one", await submit(store, { name: "Nobody", s: -50, w: 0, k: 0 }), null);
  eq("nor no body at all", await submit(store, null), null);
  eq("so the board stays empty", (await top(store)).length, 0);
  await submit(store, { name: "  <script>Rude</script>  ", s: 10, w: 1, k: 1 });
  rows = await top(store);
  eq("an ugly name is cleaned, not rejected outright", rows.length, 1);
  ok("angle brackets do not survive into a row that gets dropped into innerHTML by the caller",
     !rows[0].n.includes("<") && !rows[0].n.includes(">"));
  await submit(store, { name: "Huge", s: 99999999999, w: 99999, k: 99999 });
  rows = await top(store);
  const huge = rows.find(r => r.n === "Huge");
  ok("score, wave and kills are all clamped to sane ceilings",
     huge.s <= 9999999 && huge.w <= 200 && huge.k <= 999);

  console.log("\nremoving a row — moderation/cleanup, not a player action");
  store = freshStore();
  await submit(store, { name: "lbcheckA", s: 9000, w: 20, k: 50 });
  await submit(store, { name: "Green", s: 900, w: 8, k: 20 });
  eq("removing a name that is on the board reports true", await remove(store, "lbcheckA"), true);
  rows = await top(store);
  eq("that row is gone", rows.length, 1);
  eq("the other player's row is untouched", rows[0].n, "Green");
  eq("removing it again reports false — it is already gone", await remove(store, "lbcheckA"), false);
  eq("removing a name that was never on the board reports false", await remove(store, "Nobody"), false);
  eq("matched case-insensitively, like submit()", await remove(store, "GREEN"), true);
  eq("and empty input removes nothing", await remove(store, ""), false);
  eq("nor does junk input", await remove(store, null), false);

  console.log("\nthe board does not grow without bound");
  store = freshStore();
  const EXTRA = 20;
  for (let i = 0; i < LIMITS.MAX_ROWS + EXTRA; i++){
    await submit(store, { name: "Wizard" + i, s: 100 + i, w: 1, k: 1 });   // strictly increasing scores
  }
  const stored = (await store.get("top"));
  ok("storage itself is capped at MAX_ROWS   (" + stored.length + ")", stored.length <= LIMITS.MAX_ROWS);
  eq("and a read never returns more than TOP_N", (await top(store)).length, LIMITS.TOP_N);
  // scores ran 100..(100+MAX_ROWS+EXTRA-1); only the top MAX_ROWS of them should survive
  const lowestKept = Math.min(...stored.map(r => r.s));
  eq("the cap keeps the highest scorers, not the first submitters",
     lowestKept, 100 + EXTRA);

  console.log("\n" + pass + " passing" + (failed ? ", " + failed + " FAILED" : ""));
  process.exit(failed ? 1 : 0);
};
run();
