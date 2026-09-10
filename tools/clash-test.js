/*
 * The bug Green could reproduce on demand, as a test.
 *
 * Three players across three continents could play for minutes — until two of
 * them pointed the red beam at each other. Then the match came apart, and the
 * report almost always said "the scenery".
 *
 * The cause was not the network. It was Math.sin. The spec pins down +, -, *, /
 * and sqrt; it leaves sin, cos, atan2, hypot, exp and pow "implementation-
 * approximated", and browsers really do differ in the last bit. Most of the
 * game shrugs that off — positions get clamped, hits are threshold tests. The
 * beam clash does the opposite: the orb's position is carried from frame to
 * frame and slid toward a target computed from both wizards' mana, so it is a
 * feedback loop with memory that HOLDS a last-bit difference and grows it, until
 * the two beams are different lengths and burn different props.
 *
 * So this runs a beam duel over a quarter-second link with one client's trig
 * deliberately one unit in the last place out — a different browser, modelled
 * exactly — and requires lockstep to hold. Before the fix these diverged in the
 * scenery within a few hundred frames, every time.
 *
 * Dependency-free: node, and the game's own source.
 *
 *   node tools/clash-test.js
 */
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");

const LAG = path.join(__dirname, "lag-test.js");
let pass = 0; const fails = [];

/* Rarity of the engine disagreement. 4096 is already far more hostile than any
   real pair of browsers; 2 is absurd, and is there to show the simulation is not
   merely tolerant of small differences but independent of these functions. */
const CASES = [
  { name: "a beam duel between two browsers",            env: { MODE: "beam", TOTAL: "2", ULP_B: "4096", SEED: "1" } },
  { name: "six in the arena, beams flying",              env: { MODE: "beam", TOTAL: "6", ULP_B: "4096", SEED: "2" } },
  { name: "and again on another seed",                   env: { MODE: "beam", TOTAL: "6", ULP_B: "4096", SEED: "3" } },
  { name: "an absurdly divergent engine still agrees",   env: { MODE: "beam", TOTAL: "6", ULP_B: "2",    SEED: "1" } },
  { name: "a normal match over the same link",           env: { MODE: "spread", TOTAL: "6", ULP_B: "4096", SEED: "1" } }
];

for (const c of CASES){
  const r = spawnSync(process.execPath, [LAG], {
    env: { ...process.env, FRAMES: "2400", ...c.env },
    encoding: "utf8"
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const good = /\nPASS:/.test(out);
  const why = (out.match(/DIVERGED at sim frame \d+ — .*/) || [])[0]
           || (out.match(/FAIL: .*/) || [])[0] || "no verdict printed";
  if (good){ pass++; console.log("  ok  " + c.name); }
  else { console.log("FAIL  " + c.name + "\n      " + why); fails.push(c.name); }
}

/* A clash test that never produced a clash proves nothing about clashes. */
{
  const r = spawnSync(process.execPath, [LAG], {
    env: { ...process.env, MODE: "beam", TOTAL: "2", SEED: "1", FRAMES: "2400" },
    encoding: "utf8"
  });
  const m = ((r.stdout || "").match(/frames with beams locked: (\d+)/) || [])[1];
  const n = +m || 0;
  if (n > 100){ pass++; console.log("  ok  the beams really did lock (" + n + " frames)"); }
  else { console.log("FAIL  the beams never locked (" + n + " frames) — these cases prove nothing");
         fails.push("beams locked"); }
}

console.log("\n" + (fails.length ? fails.length + " FAILING" : pass + " passing"));
process.exitCode = fails.length ? 1 : 0;
