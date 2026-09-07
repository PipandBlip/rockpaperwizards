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

console.log("\noverlapping action");

/* Drive a wizard hard one way, then hard the other, and watch where each joint
   is sideways. In cloth that overlaps itself every joint reaches its extreme
   LATER than the one above it — a staircase of peak times running from collar
   to hem. Cloth that moves as one board does not.

   The old chain read each segment's neighbour as it had ALREADY been updated
   this frame, so a turn crossed the whole length in one step and the top of the
   cape was effectively nailed to the wizard: joints 1 and 2 peaked at frames 8
   and 9 and stopped dead, while the tail was still swinging forty frames later.
   Reading last frame's neighbour instead is what spreads it out. */
function whipTrace(level, frames = 150){
  const rig = boot({ seed: 5, diff: 0, room: 2, humans: 1, opts: { mapPreset: "arena" } });
  rig.RPW.startMatch({ mode: "match", seed: 5, difficulty: 0, total: 2, humans: 1,
                       seat: 0, levels: [level, level], opts: { mapPreset: "arena" } });
  for (let i = 0; i < 200; i++) rig.step();       // into the fight
  rig.fire("keydown", "d");
  for (let i = 0; i < 70; i++) rig.step();        // run one way
  rig.fire("keyup", "d"); rig.fire("keydown", "a");
  const trace = [];
  for (let i = 0; i < frames; i++){
    rig.step();
    const c = rig.RPW.capeOf(0);
    if (c) trace.push({ lat: c.nodes.map(n => n.lateral), turns: c.turns });
  }
  rig.fire("keyup", "a");
  return trace;
}
function peaksOf(trace){
  const N = trace[0].lat.length, out = [];
  for (let n = 0; n < N; n++){
    let at = 0, best = -Infinity;
    trace.forEach((s, i) => { const v = Math.abs(s.lat[n]); if (v > best){ best = v; at = i; } });
    out.push({ node: n, at, swing: +best.toFixed(2) });
  }
  return out;
}

test("the collar itself moves — it is not nailed to the wizard", () => {
  const peaks = peaksOf(whipTrace(11));
  assert.ok(peaks[0].swing > 0.4,
    "the cloth's root swung " + peaks[0].swing + "px — it is pinned to the wizard, " +
    "so the top of the cape can only ever be as rigid as the body");
});

test("and the swing takes real time to travel down the cloth", () => {
  /* The tell is the TOP of the chain, not the bottom. A cape pinned at the
     collar still flaps at the hem, so a lagging tip proves nothing; what says
     the cloth moves as one board is the upper joints all reaching their extreme
     within a frame or two of each other. */
  const peaks = peaksOf(whipTrace(11));
  const spread = peaks[4].at - peaks[1].at;
  assert.ok(spread >= 8,
    `joints 1 to 4 peak at frames ${peaks.slice(1, 5).map(p => p.at).join(", ")} — ` +
    "the top of the cape is swinging as one piece");
});

test("and every joint still swings further than the one above it", () => {
  const peaks = peaksOf(whipTrace(11));
  for (let i = 2; i < peaks.length; i++)
    assert.ok(peaks[i].swing >= peaks[i - 1].swing - 0.01,
      `joint ${i} swings ${peaks[i].swing} but joint ${i - 1} swings ${peaks[i - 1].swing}`);
});

test("and none of it folds through itself while whipping", () => {
  for (const lv of [1, 8, 14]){
    for (const s of whipTrace(lv, 110))
      for (const t of s.turns)
        assert.ok(Math.abs(t) <= 0.6, `level ${lv} kinked by ${t} mid-whip`);
  }
});

console.log(`\n${pass} passing`);
