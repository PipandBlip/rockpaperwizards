/*
 * Does the desync report point at the right thing?
 *
 * The relay can only name a component if the game measures that component
 * separately and if a difference in it actually shows up in that number and
 * not in the others. A report that names "the scenery" when the projectiles
 * diverged is worse than no report at all: it sends the next hour of work into
 * the wrong file. So drive two identical worlds, break exactly one thing in
 * one of them, and check that exactly one name comes back.
 *
 *   node tools/desync-parts-test.js
 */
"use strict";
const assert = require("assert");
const { boot } = require("./determinism");
const { partsSplit, HASH_PARTS } = require("../server/rooms");

let pass = 0;
function test(name, fn){
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e){ console.error("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; }
}

function pair(seed = 7, frames = 240){
  const a = boot({ seed, diff: 1, room: 4, humans: 1 });
  const b = boot({ seed, diff: 1, room: 4, humans: 1 });
  for (let i = 0; i < frames; i++){ a.step(); b.step(); }
  return [a.sandbox.window.RPW, b.sandbox.window.RPW];
}
const split = (A, B) => partsSplit([A.hashParts(), B.hashParts()]);

test("two worlds running the same seed agree on every component", () => {
  const [A, B] = pair();
  assert.strictEqual(A.hash(), B.hash(), "the whole-world checksums must match first");
  assert.deepStrictEqual(split(A, B), [], "nothing should be named when nothing differs");
});

test("a spell that exists in only one world names the spells, and only the spells", () => {
  const [A, B] = pair();
  const ids = A.sides().map(w => w.id);
  assert.ok(A.fireAt(ids[0], ids[1]), "the test hook fired");
  assert.deepStrictEqual(split(A, B), ["spells"]);
});

test("a wizard hurt in only one world names the wizards", () => {
  const [A, B] = pair();
  A.smite(A.sides()[1].id);
  const named = split(A, B);
  assert.ok(named.includes("wizards"), "the wizards differ and must be named: got " + JSON.stringify(named));
  assert.ok(!named.includes("rolls"), "no roll was drawn, so the rolls must not be blamed");
});

test("every component the relay can name is one the game actually measures", () => {
  const [A] = pair();
  const parts = A.hashParts();
  for (const k of HASH_PARTS){
    assert.strictEqual(typeof parts[k], "number", "hashParts() never produced " + k);
  }
  assert.deepStrictEqual(Object.keys(parts).sort(), [...HASH_PARTS].sort(),
    "the game measures a different set of components than the relay can name");
});

test("the sentence a player reads names what broke", () => {
  const [A] = pair();
  const say = A.desyncNote({ frame: 240, parts: ["spells"] });
  assert.ok(/spells/.test(say), "a spells desync must say spells: " + say);
  assert.ok(/240/.test(say), "and say when: " + say);
  const two = A.desyncNote({ frame: 60, parts: ["wizards", "scenery"] });
  assert.ok(/ and /.test(two), "two components read as a list: " + two);
  const none = A.desyncNote({ frame: 60, parts: [] });
  assert.ok(none.length > 0 && !/undefined/.test(none), "an unnamed desync still reads: " + none);
  assert.strictEqual(A.desyncNote(null), "", "and no report at all says nothing");
});

console.log("\n" + pass + " passing");
