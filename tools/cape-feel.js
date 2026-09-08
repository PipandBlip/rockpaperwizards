/*
 * How stiff is the cloth, in numbers.
 *
 * tools/cape-test.js already proves the cape LAGS — every joint peaks later
 * than the one above it. That is necessary and not sufficient, and mistaking
 * one for the other is how a cape can pass every test and still read as a
 * board: a plank bolted to a wizard's back through a slow hinge also lags.
 *
 * What separates cloth from a plank is what happens AFTER the wizard stops:
 *   - it overshoots its rest angle and comes back (follow-through)
 *   - it crosses that rest angle more than once (it rings, it does not creep)
 *   - it keeps moving when nothing is driving it (idle life)
 *   - it bends, rather than swinging rigidly about the collar (curvature)
 *
 * This prints those four. It is a measuring instrument, not a pass/fail suite:
 *   node tools/cape-feel.js
 */
"use strict";
const { boot } = require("./determinism");

function drive(level = 11, runFrames = 70, coastFrames = 150){
  const rig = boot({ seed: 5, diff: 0, room: 2, humans: 1, opts: { mapPreset: "arena" } });
  rig.RPW.startMatch({ mode: "match", seed: 5, difficulty: 0, total: 2, humans: 1,
                       seat: 0, levels: [level, level], opts: { mapPreset: "arena" } });
  for (let i = 0; i < 200; i++) rig.step();
  rig.fire("keydown", "d");
  for (let i = 0; i < runFrames; i++) rig.step();
  rig.fire("keyup", "d");                       // stop driving: everything after is the cloth's own
  const trace = [];
  for (let i = 0; i < coastFrames; i++){
    rig.step();
    const c = rig.RPW.capeOf(0);
    if (c) trace.push({ lat: c.nodes.map(n => n.lateral), turns: c.turns.slice() });
  }
  return trace;
}

function idle(level = 11, frames = 240){
  const rig = boot({ seed: 5, diff: 0, room: 2, humans: 1, opts: { mapPreset: "arena" } });
  rig.RPW.startMatch({ mode: "match", seed: 5, difficulty: 0, total: 2, humans: 1,
                       seat: 0, levels: [level, level], opts: { mapPreset: "arena" } });
  for (let i = 0; i < 260; i++) rig.step();
  const trace = [];
  for (let i = 0; i < frames; i++){ rig.step(); const c = rig.RPW.capeOf(0); if (c) trace.push(c.nodes.map(n => n.lateral)); }
  return trace;
}

/* Where the tip settles, and how it got there. Rest is taken as the tail of the
   coast, so "overshoot" means past where it ends up, not past zero. */
function ringing(series){
  const rest = series.slice(-25).reduce((a, b) => a + b, 0) / 25;
  const dev = series.map(v => v - rest);
  let peak = 0, peakAt = 0;
  dev.forEach((v, i) => { if (Math.abs(v) > Math.abs(peak)){ peak = v; peakAt = i; } });
  // crossings of rest AFTER the first peak: each one is a swing back
  let crossings = 0;
  for (let i = peakAt + 1; i < dev.length; i++)
    if (Math.sign(dev[i]) !== Math.sign(dev[i - 1]) && Math.abs(dev[i]) > 0.05) crossings++;
  // the biggest excursion the OTHER way after the peak — the follow-through
  let back = 0;
  for (let i = peakAt; i < dev.length; i++)
    if (Math.sign(dev[i]) === -Math.sign(peak) && Math.abs(dev[i]) > Math.abs(back)) back = dev[i];
  const settle = (() => {
    for (let i = dev.length - 1; i >= 0; i--) if (Math.abs(dev[i]) > Math.abs(peak) * 0.1) return i;
    return 0;
  })();
  return { peak: +peak.toFixed(2), back: +back.toFixed(2),
           overshoot: +(Math.abs(back) / (Math.abs(peak) || 1)).toFixed(3),
           crossings, settle };
}

const N = s => (s >= 0 ? " " : "") + s.toFixed(2);

/* ---- the four numbers, as functions, so tools/cape-test.js asserts on exactly
   what this report prints rather than on a second implementation of it. ---- */
function reversalsPerJoint(trace){
  const jn = trace[0].turns.length, out = [];
  for (let j = 0; j < jn; j++){
    const col = trace.map(s => s.turns[j]);
    let flips = 0;
    for (let i = 2; i < col.length; i++){
      const d1 = col[i] - col[i - 1], d0 = col[i - 1] - col[i - 2];
      if (Math.sign(d1) !== Math.sign(d0) && Math.abs(d1) > 1e-4) flips++;
    }
    out.push(flips);
  }
  return out;
}
function neighbourAgreement(trace){
  const jn = trace[0].turns.length;
  let same = 0, tot = 0;
  for (const s of trace) for (let j = 1; j < jn; j++)
    if (Math.abs(s.turns[j]) > 1e-3 && Math.abs(s.turns[j - 1]) > 1e-3){
      tot++; if (Math.sign(s.turns[j]) === Math.sign(s.turns[j - 1])) same++;
    }
  return tot ? same / tot : 1;
}
function bendSwing(trace){
  const tot = trace.map(s => s.turns.reduce((a, b) => a + b, 0));
  return Math.max(...tot) - Math.min(...tot);
}

module.exports = { drive, idle, ringing, reversalsPerJoint, neighbourAgreement, bendSwing };
if (require.main !== module) return;

console.log("\n=== after the wizard stops: does the cloth ring, or creep? ===");
const tr = drive();
const nodes = tr[0].lat.length;
console.log("node   peak    back  overshoot  crossings  settle(frames)");
for (let n = 1; n < nodes; n++){
  const r = ringing(tr.map(s => s.lat[n]));
  console.log(String(n).padStart(3) + "  " + N(r.peak).padStart(7) + "  " + N(r.back).padStart(6) +
              "     " + r.overshoot.toFixed(3).padStart(6) + "      " + String(r.crossings).padStart(3) +
              "        " + String(r.settle).padStart(4));
}

console.log("\n=== curvature: does it BEND, or swing as one piece? ===");
const totalTurn = tr.map(s => s.turns.reduce((a, b) => a + b, 0));
const spread = Math.max(...totalTurn) - Math.min(...totalTurn);
const perJoint = tr[0].turns.map((_, j) => {
  const col = tr.map(s => s.turns[j]);
  return +(Math.max(...col) - Math.min(...col)).toFixed(3);
});
console.log("total bend swing : " + spread.toFixed(3) + " rad (" + (spread * 57.3).toFixed(1) + " deg)");
console.log("per joint (rad)  : " + perJoint.join(", "));

console.log("\n=== is the shape the physics', or the fold clamp's? ===");
{
  const CAP = 0.26;   // CAPE_MAX_TURN
  const sat = tr[0].turns.map((_, j) => {
    const col = tr.map(s => Math.abs(s.turns[j]));
    const pinned = col.filter(v => v >= CAP * 0.97).length;
    return { j, max: +Math.max(...col).toFixed(3), pinned: Math.round(100 * pinned / col.length) };
  });
  for (const s2 of sat)
    console.log("joint " + s2.j + ": max bend " + s2.max.toFixed(3) + " rad, pinned against the cap " + s2.pinned + "% of frames");
}

console.log("\n=== standing still: is there any life in it? ===");
const idl = idle();
for (const n of [1, 3, 5, 7]){
  const col = idl.map(s => s[n]);
  console.log("node " + n + " travels " + (Math.max(...col) - Math.min(...col)).toFixed(2) + " px while idle");
}

/* Ringing and chattering both cross rest a lot. They look nothing alike: a ring
   is the whole lower cape moving together at about a swing a second, chatter is
   neighbouring joints fighting each other frame to frame. Tell them apart by
   how often the DIRECTION of each joint reverses, and by whether neighbouring
   joints bend the same way or opposite ways. */
console.log("\n=== is it swinging, or vibrating? ===");
{
  const jn = tr[0].turns.length;
  const rev = [];
  for (let j = 0; j < jn; j++){
    const col = tr.map(s => s.turns[j]);
    let flips = 0;
    for (let i = 2; i < col.length; i++){
      const d1 = col[i] - col[i - 1], d0 = col[i - 1] - col[i - 2];
      if (Math.sign(d1) !== Math.sign(d0) && Math.abs(d1) > 1e-4) flips++;
    }
    rev.push(flips);
  }
  console.log("direction reversals per joint over " + tr.length + " frames: " + rev.join(", "));
  console.log("  (a swinging cape reverses a handful of times; one reversing every" +
              " few frames is vibrating)");
  // neighbour agreement: +1 when adjacent joints bend the same way
  let same = 0, tot = 0;
  for (const s2 of tr) for (let j = 1; j < jn; j++){
    if (Math.abs(s2.turns[j]) > 1e-3 && Math.abs(s2.turns[j - 1]) > 1e-3){
      tot++; if (Math.sign(s2.turns[j]) === Math.sign(s2.turns[j - 1])) same++;
    }
  }
  console.log("neighbouring joints bend the same way " + Math.round(100 * same / tot) +
              "% of the time (a smooth curve is high; a zigzag is near 50%)");
}
console.log("");
