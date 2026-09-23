/*
 * Bolt vs bolt: who keeps the mana.
 *
 * Two shots of unequal weight already had a rule everyone could see working:
 * the heavier one eats the lighter one and its owner is paid for the counter.
 * The gap was the tie. Same weight, straight into each other, used to pay
 * BOTH owners — a clash nobody really won still handed out two rewards. The
 * fix keeps it to one: whoever cast theirs more recently is treated as the
 * one who did the cancelling, and only that owner is paid. shotSeq is a
 * strict firing order (never reused, never tied) that exists for exactly
 * this comparison, so the winner is not a guess — it is whichever shot has
 * the higher seq.
 *
 * This rig fires two scripted, ally-owned shots at each other down a clear
 * lane (no bot, no rival, nothing else in the air) so the one collision under
 * test is the only thing that can move a mana bar.
 *
 *   node tools/collision-test.js
 */
"use strict";
const assert = require("assert");
const { boot } = require("./determinism");

let pass = 0;
function test(name, fn){
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e){ console.error("FAIL  " + name + "\n      " + (e.stack || e.message).split("\n").slice(0, 4).join("\n      ")); process.exitCode = 1; }
}

/** Two human (non-bot) allies, facing each other down a clear lane, nothing
    else on the floor — full manual control, no bot to muddy a frame. */
function duo(seed){
  const rig = boot({ seed, diff: 1, room: 2, humans: 2, opts: { coop: 1, mapPreset: "random" } });
  for (let i = 0; i < 3000; i++){
    rig.step();
    if (rig.RPW.phase() === "fight" && rig.RPW.waveNow() >= 1) break;
  }
  assert.strictEqual(rig.RPW.phase(), "fight", "the duo reached the fight");
  for (const r of rig.RPW.sides()) if (!r.ally && !r.dead) rig.RPW.smite(r.id);
  rig.RPW.clearScenery();
  for (let i = 0; i < 5; i++) rig.step();
  assert.strictEqual(rig.RPW.sides().filter(w => !w.ally && !w.dead).length, 0, "the floor is clear");
  rig.RPW.clearShots();
  assert.strictEqual(rig.RPW.allShots().length, 0, "nothing already in the air before the test fires a shot");
  const [a, b] = rig.RPW.sides().filter(w => w.ally).sort((x, y) => x.id - y.id);
  rig.RPW.setVitals(a.id, a.hp, 0);
  rig.RPW.setVitals(b.id, b.hp, 0);
  return { rig, aId: a.id, bId: b.id };
}

const manaOf = (rig, id) => rig.RPW.sides().find(w => w.id === id).mana;

/* Both wizards regen mana passively (~17/s, well under 0.3 in a single 1/60
   frame) the moment they are not charging or beaming — real and correct, but
   a slow drift, not what this is looking for. A clash pays out in one frame,
   6 + weight*7 at once, which no amount of passive regen can be mistaken
   for. So this watches for a single-frame jump well past what regen alone
   could produce, and stops the instant one lands. */
function stepUntilManaMoves(rig, aId, bId, maxFrames = 150){
  let prevA = manaOf(rig, aId), prevB = manaOf(rig, bId);
  for (let i = 0; i < maxFrames; i++){
    rig.step();
    const a = manaOf(rig, aId), b = manaOf(rig, bId);
    if (a - prevA > 5 || b - prevB > 5) return true;
    prevA = a; prevB = b;
  }
  return false;
}

console.log("\nbolt vs bolt: the mana on a tie");

/* Both wizards regen at the same passive rate right up to the collision
   frame, so that shared drift cancels out of a straight A-vs-B comparison —
   whichever one is comfortably ahead the instant the jump lands is the one
   the clash paid, independent of how many frames the bolts spent closing. */
test("equal weight, A cast first: B — the later shot — keeps the mana, A gets none", () => {
  const { rig, aId, bId } = duo(1);
  assert.ok(rig.RPW.fireAt(aId, bId, 10, 4), "A's bolt left");     // lower seq: cast first
  assert.ok(rig.RPW.fireAt(bId, aId, 10, 4), "B's bolt left");     // higher seq: cast second
  assert.ok(stepUntilManaMoves(rig, aId, bId), "neither mana bar ever moved — did the bolts collide?");
  const a = manaOf(rig, aId), b = manaOf(rig, bId);
  assert.ok(b - a >= 25, `B (cast second) should be well ahead of A (cast first): A=${a} B=${b}`);
});

test("equal weight, B cast first: the win follows whoever is later, not a fixed seat", () => {
  const { rig, aId, bId } = duo(2);
  assert.ok(rig.RPW.fireAt(bId, aId, 10, 4), "B's bolt left");     // lower seq: cast first
  assert.ok(rig.RPW.fireAt(aId, bId, 10, 4), "A's bolt left");     // higher seq: cast second
  assert.ok(stepUntilManaMoves(rig, aId, bId), "neither mana bar ever moved — did the bolts collide?");
  const a = manaOf(rig, aId), b = manaOf(rig, bId);
  assert.ok(a - b >= 25, `A (cast second) should be well ahead of B (cast first): A=${a} B=${b}`);
});

test("unequal weight still overrides order: the heavier bolt wins even cast first", () => {
  const { rig, aId, bId } = duo(3);
  assert.ok(rig.RPW.fireAt(aId, bId, 10, 6), "A's heavy bolt left");  // lower seq, MORE weight
  assert.ok(rig.RPW.fireAt(bId, aId, 10, 2), "B's light bolt left"); // higher seq, less weight
  assert.ok(stepUntilManaMoves(rig, aId, bId), "neither mana bar ever moved — did the bolts collide?");
  const a = manaOf(rig, aId), b = manaOf(rig, bId);
  assert.ok(a - b >= 10, `A (heavier, cast first) should still win on weight: A=${a} B=${b}`);
});

console.log(`\n${pass} passing`);
