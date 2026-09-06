/*
 * Co-op survival: the party is one team, and the game must never let that team
 * hurt or aim at itself.
 *
 * Friendly fire is the kind of rule that looks obviously true when you read the
 * code — every damage path checks `q.team === owner.team` — and quietly stops
 * being true the moment someone adds a path that forgets. So this file does not
 * read the rule, it fires a real shot down the middle of the party and looks at
 * the health bars.
 *
 *   node tools/coop-test.js
 */

"use strict";

const assert = require("assert");
const { boot } = require("./determinism");

let pass = 0;
function test(name, fn){
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e){ console.error("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; }
}

/** a co-op party in the middle of wave 1, however long that takes to arrive */
function party({ seed = 7, humans = 2, room = 4 } = {}){
  const rig = boot({ seed, diff: 1, room, humans,
                     opts: { coop: 1, mapPreset: "random" } });
  // The countdown, then the gap before the first set. Waiting on the state
  // rather than a frame count, because guessing the number is how a test ends
  // up asserting things about a match that has not started.
  for (let i = 0; i < 3000; i++){
    rig.step();
    if (rig.RPW.phase() === "fight" && rig.RPW.waveNow() >= 1) break;
  }
  assert.strictEqual(rig.RPW.phase(), "fight", "the run reached the fight");
  assert.ok(rig.RPW.waveNow() >= 1, "wave 1 arrived");
  return rig;
}
const sides = rig => rig.RPW.sides();
const seatOf = (rig, pred) => sides(rig).find(pred);

console.log("\nthe party");

test("every seat the host opened is in the party", () => {
  const rig = party();
  const allies = sides(rig).filter(w => w.ally);
  assert.strictEqual(allies.length, 4, "four seats, four allies");
  assert.ok(allies.every(w => w.team === 0), "the whole party shares one team");
});

test("and the waves are the only thing on the other side", () => {
  const rig = party();
  const rivals = sides(rig).filter(w => !w.ally);
  assert.ok(rivals.length > 0, "the first set is on the floor");
  assert.ok(rivals.every(w => w.team === 1), "every rival is on team 1");
});

test("a party of one is a solo run", () => {
  const rig = party({ seed: 3, humans: 1, room: 1 });
  assert.strictEqual(sides(rig).filter(w => w.ally).length, 1);
});

console.log("\nfriendly fire");

/* Clearing the floor first matters. With a wave still up, the party's health
   drops for reasons that have nothing to do with the shot under test, and the
   assertion would pass or fail on whatever a rival happened to be doing. */
function clearRivals(rig){
  for (const r of rig.RPW.sides()) if (!r.ally && !r.dead) rig.RPW.smite(r.id);
  for (let i = 0; i < 5; i++) rig.step();
  assert.strictEqual(rig.RPW.sides().filter(w => !w.ally && !w.dead).length, 0,
                     "the floor is clear");
}

test("a shot fired straight at an ally does nothing at all", () => {
  const rig = party();
  clearRivals(rig);
  const idOf = n => rig.RPW.sides().filter(w => w.ally)[n].id;
  const hp = () => rig.RPW.sides().filter(w => w.ally).map(w => w.hp);
  const before = hp();
  for (let k = 0; k < 6; k++){
    assert.ok(rig.RPW.fireAt(idOf(0), idOf(1), 60), "the shot went into the air");
    for (let i = 0; i < 12; i++) rig.step();
  }
  const after = hp();
  assert.deepStrictEqual(after, before,
    `party health moved from ${before} to ${after} — friendly fire is ON`);
});

test("and thrown scenery cannot hit an ally either", () => {
  const rig = party();
  clearRivals(rig);
  const before = rig.RPW.sides().filter(w => w.ally).map(w => w.hp);
  for (let i = 0; i < 240; i++) rig.step();     // allies loose in an empty arena
  const after = rig.RPW.sides().filter(w => w.ally).map(w => w.hp);
  assert.ok(after.every((h, i) => h >= before[i] - 0.001),
    `party health fell with nothing on the floor to hurt it: ${before} -> ${after}`);
});

test("but the same shot aimed at a rival lands", () => {
  const rig = party();
  const rival = rig.RPW.sides().find(w => !w.ally && !w.dead);
  const me = rig.RPW.sides().find(w => w.ally && !w.dead);
  assert.ok(rival, "there is a rival to shoot");
  const before = rival.hp;
  assert.ok(rig.RPW.fireAt(me.id, rival.id, 60));
  let hit = false;
  for (let i = 0; i < 240 && !hit; i++){
    rig.step();
    const now = rig.RPW.sides().find(w => w.id === rival.id);
    if (!now || now.dead || now.hp < before) hit = true;
  }
  assert.ok(hit,
    "the shot never landed on a rival either, so the ally test above proves nothing");
});

console.log("\nfriendly targeting");

test("nobody in the party ever aims at the party", () => {
  const rig = party();
  let checked = 0;
  for (let i = 0; i < 1200; i++){
    rig.step();
    if (i % 7) continue;
    for (const w of sides(rig)){
      if (w.dead) continue;
      checked++;
      if (w.target != null)
        assert.notStrictEqual(w.target, w.team, `seat ${w.seat} is targeting its own side`);
      if (w.lock != null)
        assert.notStrictEqual(w.lock, w.team, `seat ${w.seat} has locked its own side`);
    }
  }
  assert.ok(checked > 500, "the run actually had wizards in it (" + checked + ")");
});

console.log("\nsurviving");

test("a downed ally is back on their feet for the next wave", () => {
  const rig = party();
  const wave = () => rig.RPW.waveNow();
  const start = wave();
  const victim = sides(rig).filter(w => w.ally)[1].id;
  rig.RPW.smite(victim);                             // one of the party goes down
  let i = 0;
  for (; i < 10; i++) rig.step();
  assert.ok(sides(rig).find(w => w.id === victim).dead, "the ally is down");
  // run until the party clears the set and the next one arrives
  for (i = 0; i < 60000 && wave() <= start; i++) rig.step();
  assert.ok(wave() > start, "a new wave arrived within the budget");
  for (i = 0; i < 30; i++) rig.step();
  const back = sides(rig).find(w => w.id === victim);
  assert.ok(!back.dead, "the downed ally came back with the new wave");
  assert.ok(back.hp > 0 && back.hp < 100, "and came back hurt, not fresh (" + back.hp + ")");
});

test("the run only ends when the whole party is down", () => {
  const rig = party();
  const ids = sides(rig).filter(w => w.ally).map(w => w.id);
  for (const id of ids.slice(0, 3)) rig.RPW.smite(id);
  for (let i = 0; i < 30; i++) rig.step();
  assert.notStrictEqual(rig.RPW.phase(), "over", "three down out of four is not a loss");
  rig.RPW.smite(ids[3]);
  for (let i = 0; i < 30; i++) rig.step();
  assert.strictEqual(rig.RPW.phase(), "over", "the last one falling ends it");
});

console.log(`\n${pass} passing`);
