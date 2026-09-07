/*
 * The cloak ladder, rendered.
 *
 * Capes are view-only: no seeded RNG, nothing in the hash. That is what makes
 * them free, and it is also why every other suite here is structurally blind to
 * them — determinism, golden and the relay tests would all pass with a cape
 * renderer that threw on every frame from level 8 up.
 *
 * That is not hypothetical. Changing the tail silhouette left one call reaching
 * for a point that no longer existed; it crashed the draw loop for any wizard
 * above level 7 and nothing in the repo noticed. This file drives the real draw
 * loop with a wizard on every rung of the ladder.
 *
 *   node tools/cape-test.js
 */

"use strict";

const assert = require("assert");
const { boot } = require("./determinism");

let pass = 0;
function test(name, fn){
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e){ console.error("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; }
}

/** six seats wearing the given levels, run far enough to be drawing capes */
function wearing(levels, frames = 240){
  const rig = boot({ seed: 3, diff: 1, room: 6, humans: 6,
                     opts: { mapPreset: "arena" } });
  rig.RPW.startMatch({ mode: "match", seed: 3, difficulty: 1, total: 6, humans: 6,
                       seat: 0, levels, opts: { mapPreset: "arena" } });
  for (let i = 0; i < frames; i++) rig.step();
  return rig;
}
const LADDER = (() => {
  const rig = boot({ seed: 1, diff: 1 });
  return rig.sandbox.window.RPWA.track(99).rows;
})();

console.log("\ndrawing every rung");

test("the ladder is fourteen rungs long", () => {
  assert.strictEqual(LADDER.length, 14);
});

/* One case per rung rather than one case for all of them: a crash on rung 11
   should say "rung 11", not "some cape somewhere". */
for (const rung of LADDER){
  test(`level ${rung.at} — ${rung.name} — draws`, () => {
    const rig = wearing([rung.at, rung.at, rung.at, rung.at, rung.at, rung.at]);
    assert.strictEqual(rig.RPW.phase(), "fight", "the match got past the countdown");
    const c = rig.RPW.capeOf(1);
    assert.ok(c, "seat 1 has cloth");
    assert.strictEqual(c.rung, rung.at, "and it is wearing the right rung");
    assert.strictEqual(c.emblem, rung.emblem);
    assert.strictEqual(c.seams, rung.seams);
  });
}

console.log("\nthe shape of it");

test("all fourteen rungs can share one arena", () => {
  // The crash that prompted this file only appeared with mixed levels on screen
  const rig = wearing([1, 4, 7, 8, 11, 14], 400);
  assert.strictEqual(rig.RPW.phase(), "fight");
  const rungs = [1, 2, 3, 4, 5].map(s => rig.RPW.capeOf(s).rung);
  assert.deepStrictEqual(rungs, [4, 7, 8, 11, 14]);
});

test("the cloth gets broader as it climbs, and never narrower", () => {
  const widths = LADDER.map(r => {
    const rig = wearing([r.at, r.at, 1, 1, 1, 1], 200);
    return Math.round(Math.max(...rig.RPW.capeOf(1).widths) * 100) / 100;
  });
  for (let i = 1; i < widths.length; i++)
    assert.ok(widths[i] >= widths[i - 1] - 0.001,
              `level ${i + 1} is narrower than level ${i}: ${widths[i - 1]} -> ${widths[i]}`);
  assert.ok(widths[13] > widths[0] * 1.1,
            `the top of the ladder should be broader (${widths[0]} -> ${widths[13]})`);
});

/* The hem silhouette is the loudest signal on the cape — readable across an
   arena long before an emblem is. It must actually change, and it must change
   in one direction, or the ladder is just fourteen shades of the same cloak. */
test("the hem changes shape as it climbs, in ladder order", () => {
  const seen = [];
  for (const r of LADDER){
    const rig = wearing([r.at, r.at, 1, 1, 1, 1], 160);
    const t = rig.RPW.capeOf(1).tail;
    assert.ok(t, `level ${r.at} has no tail shape`);
    if (seen[seen.length - 1] !== t) seen.push(t);
  }
  assert.deepStrictEqual(seen, ["chevron", "kite", "rhombus", "split"],
    "the hem should go chevron, kite, rhombus, split and never double back");
});

test("no cloth ever folds through itself, on any rung", () => {
  for (const r of LADDER){
    const rig = wearing([r.at, r.at, r.at, r.at, r.at, r.at], 300);
    for (const seat of [0, 1, 2, 3, 4, 5]){
      const c = rig.RPW.capeOf(seat);
      if (!c) continue;
      for (const t of c.turns)
        assert.ok(Math.abs(t) <= 0.6, `level ${r.at} seat ${seat} kinked by ${t}`);
    }
  }
});

console.log(`\n${pass} passing`);
