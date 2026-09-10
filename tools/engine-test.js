/*
 * Does the simulation depend on which BROWSER it is running in?
 *
 * The ECMAScript spec requires +, -, *, / and Math.sqrt to be correctly
 * rounded — bit-identical on every engine. It does NOT require that of sin,
 * cos, tan, atan2, hypot, exp, pow or log: those are "implementation-
 * approximated", and V8, SpiderMonkey and JavaScriptCore genuinely return
 * different doubles for the same input.
 *
 * In lockstep that is fatal. It cost Green and a friend in Canada every match
 * they played: fine for minutes, then the moment two beams locked against each
 * other the worlds came apart. The clash is the amplifier — the orb's position
 * is carried frame to frame and slid toward a target computed from both
 * wizards' mana, a feedback loop with memory and no quantisation, so it takes a
 * last-bit difference and grows it until the two beams are burning different
 * props. Hence the report we kept getting: "the scenery", thousands of frames
 * in, right after a beam fight.
 *
 * So: run the same match twice, once with every engine-approximated Math
 * function deliberately one unit in the last place out, and require the
 * simulation checksum to be IDENTICAL. Native Math anywhere in a simulation
 * path fails this immediately.
 *
 *   node tools/engine-test.js
 */
"use strict";
const { run } = require("./determinism");

let pass = 0; const fails = [];
const ok = (name, cond, extra) => {
  if (cond){ pass++; console.log("  ok  " + name); }
  else { console.log("FAIL  " + name + (extra ? "\n      " + extra : "")); fails.push(name); }
};

const sig = marks => marks.join(",");

/* A duel, a crowded room, and co-op — the beam, the bots and the scenery all
   get exercised. Long enough that a divergence has room to grow: in the real
   match it took thousands of frames. */
const CASES = [
  { name: "a duel",            args: { seed: 1, diff: 1, room: 0, frames: 2400 } },
  { name: "six in the arena",  args: { seed: 3, diff: 2, room: 6, frames: 2400 } },
  { name: "co-op against waves", args: { seed: 5, diff: 1, room: 4, frames: 2400,
                                         opts: { coop: true } } },
  { name: "a long duel",       args: { seed: 7, diff: 2, room: 2, frames: 5400 } }
];

for (const c of CASES){
  const plain = run({ ...c.args, every: 60 });
  const skewed = run({ ...c.args, every: 60, skew: true });
  ok(c.name + " plays the same on another engine",
     sig(plain) === sig(skewed),
     firstSplit(plain, skewed));
}

/* And the guard on the guard: the skew must actually be capable of changing an
   answer, or every case above passes for the wrong reason. */
{
  const { skewedMath } = require("./determinism");
  const M = skewedMath(Math);
  ok("the skew really does move a result", M.sin(0.7) !== Math.sin(0.7),
     "nothing was perturbed, so the cases above prove nothing");
  ok("but leaves the exact operations alone", M.sqrt(2) === Math.sqrt(2) && M.min(1,2) === 1);
}

function firstSplit(a, b){
  const every = 60;
  for (let i = 0; i < Math.min(a.length, b.length); i++){
    if (a[i] !== b[i])
      return "first difference around frame " + (i * every) +
             ": " + a[i] + " vs " + b[i] +
             " — a simulation path is still calling native Math";
  }
  return "the runs are different lengths (" + a.length + " vs " + b.length + ")";
}

console.log("\n" + (fails.length ? fails.length + " FAILING" : pass + " passing"));
process.exitCode = fails.length ? 1 : 0;
