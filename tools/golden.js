/*
 * Behaviour fingerprint.
 *
 * determinism.js proves a build agrees with ITSELF. It cannot tell you that a
 * change left the game playing the same way — two runs of a subtly different
 * build agree with each other perfectly well.
 *
 * This records a digest of the simulation across a spread of seeds, tiers, room
 * sizes and fog settings. Take it before a change that is meant to be a pure
 * optimisation, take it again after, and the two must match exactly. If they
 * do not, the bots are making different decisions and it was not a pure
 * optimisation, whatever the frame times say.
 *
 *   node tools/golden.js              # print the fingerprint
 *   node tools/golden.js saved.txt    # compare against one taken earlier
 */
"use strict";
const fs = require("fs");
const { run } = require("./determinism.js");

const CASES = [];
for (let seed = 1; seed <= 4; seed++){
  CASES.push({ name: `duel d1 s${seed}`,  opts: { seed, diff: 1, frames: 1800 } });
  CASES.push({ name: `duel d2 s${seed}`,  opts: { seed, diff: 2, frames: 1800 } });
  CASES.push({ name: `room4 d2 s${seed}`, opts: { seed, diff: 2, room: 4, frames: 1800 } });
  CASES.push({ name: `room6 d2 s${seed}`, opts: { seed, diff: 2, room: 6, frames: 1800 } });
  CASES.push({ name: `fog6 d2 s${seed}`,  opts: { seed, diff: 2, room: 6, frames: 1800,
                                                  opts: { fog: 1, mapPreset: "random" } } });
}

const lines = CASES.map(c => {
  const marks = run(c.opts);
  // one number for the whole run, so a single differing frame shows up
  let h = 2166136261 >>> 0;
  for (const m of marks){ h ^= m >>> 0; h = Math.imul(h, 16777619) >>> 0; }
  return c.name.padEnd(14) + " " + (h >>> 0).toString(16).padStart(8, "0") +
         "  (" + marks.length + " checkpoints)";
});

const out = lines.join("\n");
const want = process.argv[2];
if (!want){
  console.log(out);
  process.exit(0);
}
const prev = fs.readFileSync(want, "utf8").trim();
if (prev === out.trim()){
  console.log(out);
  console.log("\nidentical to " + want + " — the bots play exactly as before");
  process.exit(0);
}
const a = prev.split("\n"), b = out.split("\n");
console.error("BEHAVIOUR CHANGED against " + want + ":");
for (let i = 0; i < Math.max(a.length, b.length); i++){
  if (a[i] !== b[i]) console.error("  was  " + a[i] + "\n  now  " + b[i]);
}
process.exit(1);
