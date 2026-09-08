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
const fs = require("fs");
const pathM = require("path");
const { boot } = require("./determinism");
const feel = require("./cape-feel");

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

/* The test above looks only at the SPINE. A spine can be perfectly smooth while
   the outline drawn around it is not: offsetting a curve outwards by more than
   its radius of curvature turns the inside edge inside out, and what you get is
   a notch — a little concave bite out of the cloth, right where it bends most.

   That is a fold, it is what a person actually sees, and no test that reads
   joint angles can find it. This one walks the drawn edge instead: every step
   along it must still go the way the cape goes. A step that goes backwards is
   the outline eating itself. */
/* The measurement that actually catches it. When the spine bends to a radius
   near the cloth's own half-width, the INSIDE edge's radius approaches zero and
   its points pile up on one another — the edges never cross, so every test
   phrased around crossing passes, and the cape is drawn with a bite out of it.
   Spacing is the tell: an inside edge that is still a curve keeps a real
   fraction of a segment between its points. A collapsed one goes to zero. */
function tightestEdgeSpacing(c){
  let worst = Infinity, at = -1, side = "";
  for (const [name, E] of [["left", c.left], ["right", c.right]])
    for (let i = 1; i < E.length; i++){
      const d = Math.hypot(E[i].x - E[i - 1].x, E[i].y - E[i - 1].y) / (c.segs[i - 1] || 1);
      if (d < worst){ worst = d; at = i; side = name; }
    }
  return { worst, at, side };
}
function edgeBacktrack(c){
  let worst = 0, at = -1, side = "";
  for (const [name, E] of [["left", c.left], ["right", c.right]]){
    for (let i = 1; i < E.length; i++){
      const dx = E[i].x - E[i - 1].x, dy = E[i].y - E[i - 1].y;
      // the way the cape itself runs between these two nodes
      const sx = c.nodes[i].x - c.nodes[i - 1].x, sy = c.nodes[i].y - c.nodes[i - 1].y;
      const sl = Math.hypot(sx, sy) || 1;
      const along = (dx * sx + dy * sy) / sl;
      if (along < worst){ worst = along; at = i; side = name; }
    }
  }
  return { worst, at, side };
}

test("the drawn edge never doubles back on itself", () => {
  for (const r of LADDER){
    const rig = wearing([r.at, r.at, r.at, r.at, r.at, r.at], 300);
    for (const seat of [0, 1, 2, 3, 4, 5]){
      const c = rig.RPW.capeOf(seat);
      if (!c) continue;
      const b = edgeBacktrack(c);
      assert.ok(b.worst > -0.15,
        `level ${r.at} seat ${seat}: the ${b.side} edge runs ${b.worst.toFixed(2)}px BACKWARDS ` +
        `at node ${b.at} — that is a notch bitten out of the cloth, not a curve`);
    }
  }
});

test("and the inside of a bend never collapses to a point", () => {
  for (const r of LADDER){
    const rig = wearing([r.at, r.at, r.at, r.at, r.at, r.at], 300);
    for (const seat of [0, 1, 2, 3, 4, 5]){
      const c = rig.RPW.capeOf(seat);
      if (!c) continue;
      const g = tightestEdgeSpacing(c);
      assert.ok(g.worst > 0.18,
        `level ${r.at} seat ${seat}: the ${g.side} edge keeps only ` +
        `${g.worst.toFixed(2)} of a segment between points at node ${g.at} — ` +
        "the inside of the bend has folded up into itself");
    }
  }
});

test("and not while it is whipping either", () => {
  const rig = boot({ seed: 5, diff: 0, room: 2, humans: 1, opts: { mapPreset: "arena" } });
  rig.RPW.startMatch({ mode: "match", seed: 5, difficulty: 0, total: 2, humans: 1,
                       seat: 0, levels: [14, 14], opts: { mapPreset: "arena" } });
  for (let i = 0; i < 200; i++) rig.step();
  rig.fire("keydown", "d");
  for (let i = 0; i < 60; i++) rig.step();
  rig.fire("keyup", "d"); rig.fire("keydown", "a");
  let worst = { worst: 0, at: -1, side: "" }, when = 0;
  let tight = { worst: Infinity, at: -1, side: "" }, tightAt = 0;
  for (let i = 0; i < 150; i++){
    rig.step();
    const c = rig.RPW.capeOf(0);
    if (!c) continue;
    const b = edgeBacktrack(c);
    if (b.worst < worst.worst){ worst = b; when = i; }
    const g = tightestEdgeSpacing(c);
    if (g.worst < tight.worst){ tight = g; tightAt = i; }
  }
  assert.ok(tight.worst > 0.18,
    `mid-whip the ${tight.side} edge collapsed to ${tight.worst.toFixed(2)} of a segment ` +
    `at node ${tight.at} on frame ${tightAt}`);
  assert.ok(worst.worst > -0.15,
    `mid-whip the ${worst.side} edge ran ${worst.worst.toFixed(2)}px backwards at node ` +
    `${worst.at} on frame ${when} — the cloth pinches exactly when it bends most`);
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

console.log("\ncloth, not a hinge");

/* The section above proves the cape LAGS. It is possible to pass every one of
   those tests with something that is not cloth at all, and this project did:
   a plank on a slow hinge lags too.

   What was wrong was a damping ratio. Each joint is a damped spring, and below
   a ratio of 1 it swings past its rest angle and comes back, while at 1 and
   above it can only creep to rest and stop. An earlier version made the hem
   "looser" by lowering its spring rate AND raising its damping — the second
   half undoing the first — which put every joint past the middle of the cape
   above 1. The floppiest part of the cape was the one part that could not
   swing past anything, and the suite was blind to it because the suite only
   asked about lag.

   These four ask about the rest of it. They are the numbers tools/cape-feel.js
   prints, asserted rather than eyeballed. */

test("every joint can physically swing past its rest angle", () => {
  /* The one that was actually wrong, checked where it went wrong: in the
     numbers, not in a trace. A damping ratio at or above 1 makes overshoot
     impossible — no drive, no tuning and no amount of lag can produce
     follow-through from a joint like that.

     It has to be READ from the source rather than inferred from motion,
     because a wizard that is still decelerating drags its cape back towards
     rest and that looks like a swing in any trace. The old build passes a
     trace-based version of this test while being incapable of overshoot,
     which is the whole reason this one reads the constants instead. */
  // the source the RIG booted, not whatever is on disk — otherwise pointing the
  // rig at an old build checks the new build's constants and always passes
  const src = fs.readFileSync(process.env.RPW_GAME_SRC ||
                              pathM.join(__dirname, "..", "src", "game.js"), "utf8");
  const num = (name) => {
    const m = src.match(new RegExp(name + "\\s*=\\s*(-?[\\d.]+)"));
    assert.ok(m, name + " is not stated in src/game.js. The hem's damping must be a " +
                 "named ratio, not a per-frame multiplier — hiding it is how it ended " +
                 "up above 1 with nobody noticing.");
    return +m[1];
  };
  const zTop = num("CAPE_ZETA_TOP"), zTip = num("CAPE_ZETA_TIP");
  const sTop = num("CAPE_STIFF_TOP"), sTip = num("CAPE_STIFF_TIP");
  for (let k = 0; k <= 1.0001; k += 0.125){
    const z = zTop + (zTip - zTop) * k;
    assert.ok(z < 1, `at ${(k * 100).toFixed(0)}% down the cape the damping ratio is ` +
                     `${z.toFixed(2)} — at or above 1 that joint cannot overshoot at all`);
  }
  assert.ok(zTip < zTop,
    `the hem is damped ${zTip} and the collar ${zTop}: the hem is the STIFFER of the two. ` +
    "Looser towards the hem means both numbers falling, not the spring alone");
  assert.ok(sTip < sTop, "the hem's spring rate is not lower than the collar's");
  assert.ok(zTip < 0.6, `a hem damped ${zTip} settles in one swing; there is nothing to see`);
});

test("and the whole cape BENDS rather than swinging about the collar", () => {
  /* The tell for a rigid cape is that its joints move while their SUM does not:
     every bend cancelling its neighbour leaves a fixed arc sliding around. The
     rigid version measured 0.26 rad of total-bend swing — one joint's worth
     spread across six. */
  const swing = feel.bendSwing(feel.drive(11));
  assert.ok(swing > 0.8,
    `the cape's total bend varied by only ${swing.toFixed(2)} rad over the whip; ` +
    "it is holding one shape and swinging it");
});

test("without vibrating — neighbouring joints stay part of one curve", () => {
  const tr = feel.drive(11);
  const agree = feel.neighbourAgreement(tr);
  assert.ok(agree > 0.7,
    `neighbouring joints bend the same way only ${(agree * 100).toFixed(0)}% of the time — ` +
    "that is a zigzag, not a curve");
  const rev = feel.reversalsPerJoint(tr);
  assert.ok(Math.max(...rev) <= 12,
    "a joint reversed direction " + Math.max(...rev) + " times in " + tr.length +
    " frames — the cloth is buzzing, not swinging: " + rev.join(", "));
});

test("and there is life in it while the wizard stands still", () => {
  // not a regression test — the old build passes this too. A guard, so that
  // tuning the ringing down some day does not quietly park the cloth.
  const idl = feel.idle(11);
  const tip = idl.map(s => s[s.length - 1]);
  const travel = Math.max(...tip) - Math.min(...tip);
  assert.ok(travel > 4, `the hem moves ${travel.toFixed(1)}px while idle — it is parked`);
});

console.log(`\n${pass} passing`);
