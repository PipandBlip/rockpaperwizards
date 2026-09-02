/*
 * Input responsiveness.
 *
 * The simulation samples the keyboard once per fixed step, and steps only run
 * when a frame runs. A press and release that both land between two frames used
 * to be invisible — the spell never cast, the step never happened. At sixty
 * frames a second that window is 16ms; in a busy six-wizard fight it is several
 * times that, which is an ordinary quick tap.
 *
 * These drive the real game in a stubbed DOM and fire key events exactly where
 * they hurt: between frames.
 *
 *   node tools/input-test.js
 */
"use strict";
const { boot } = require("./determinism.js");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ok  " + name + (extra ? "   " + extra : "")); }
  else { fail++; console.log("  FAIL " + name + "   " + extra); }
};

// a rig sitting in the fight, past the countdown
function fighting(opts){
  const rig = boot(Object.assign({ seed: 4, diff: 0 }, opts));
  for (let i = 0; i < 200 && rig.RPW.phase() !== "fight"; i++) rig.step();
  return rig;
}
const me = rig => rig.RPW.where().find(w => w.human);
const run = (rig, n) => { for (let i = 0; i < n; i++) rig.step(); };

console.log("a tap that lands between two frames");
{
  const rig = fighting();
  const before = me(rig).mana;
  // no step between these two: the key is down and up inside one frame
  rig.fire("keydown", "y");
  rig.fire("keyup", "y");
  run(rig, 4);
  const spent = before - me(rig).mana;
  ok("still casts the spell", spent > 6, "spent " + spent.toFixed(1) + " mana");
}
{
  const rig = fighting();
  const y0 = me(rig).y;
  run(rig, 8);
  const drift = me(rig).y - y0;          // control: nothing pressed
  const y1 = me(rig).y;
  rig.fire("keydown", "s");
  rig.fire("keyup", "s");
  run(rig, 8);
  const moved = me(rig).y - y1;
  ok("still moves the wizard", moved > 0.1 && Math.abs(drift) < 0.001,
     "moved " + moved.toFixed(2) + "px against " + drift.toFixed(2) + "px of drift");
}
{
  const rig = fighting();
  const before = me(rig).mana;
  rig.fire("keydown", "y");
  rig.fire("keyup", "y");
  run(rig, 3);
  const spent = before - me(rig).mana;
  ok("and casts it exactly once, not twice", spent > 6 && spent < 14,
     "spent " + spent.toFixed(1) + " mana");
}

console.log("\nheld keys still behave");
{
  const rig = fighting();
  const y0 = me(rig).y;
  rig.fire("keydown", "s");
  run(rig, 30);
  const moved = me(rig).y - y0;
  ok("holding S walks you down", moved > 20, "moved " + moved.toFixed(1) + "px");
  rig.fire("keyup", "s");
  run(rig, 2);
  ok("releasing it stops the intent", me(rig).my === 0, "my=" + me(rig).my);
  let settled = -1;
  for (let i = 0; i < 60; i++){
    const a = me(rig).y; rig.step();
    if (Math.abs(me(rig).y - a) < 0.02){ settled = i; break; }
  }
  ok("and you coast briefly, then stop", settled >= 0 && settled < 30,
     settled < 0 ? "never came to rest" : "at rest after " + settled + " frames");
}
{
  // every direction, and every modifier a player might be holding with it
  const DIRS = { w: ["my", -1], s: ["my", 1], a: ["mx", -1], d: ["mx", 1] };
  const WITH = [[], ["shift"], ["y"], ["j"], ["shift", "y"]];
  const bad = [];
  for (const [key, [axis, want]] of Object.entries(DIRS)){
    for (const extra of WITH){
      const rig = fighting();
      for (const k of extra) rig.fire("keydown", k);
      rig.fire("keydown", key);
      run(rig, 3);
      if (me(rig)[axis] !== want) bad.push(key + " with [" + extra.join("+") + "] -> " + axis + "=" + me(rig)[axis]);
    }
  }
  ok("all twenty direction and modifier combinations register", bad.length === 0,
     bad.join(" | ") || "20/20");
}

console.log("\nand nothing leaks in from before the fight");
{
  const rig = boot({ seed: 4, diff: 0 });
  ok("a fresh match starts in the countdown", rig.RPW.phase() === "count", rig.RPW.phase());
  rig.fire("keydown", "y");
  rig.fire("keyup", "y");
  for (let i = 0; i < 200 && rig.RPW.phase() !== "fight"; i++) rig.step();
  const before = me(rig).mana;
  run(rig, 6);
  ok("a spell tapped during it does not fire when the wands come up",
     me(rig).mana >= before, "mana " + before + " -> " + me(rig).mana);
}

console.log("\n" + pass + " passing" + (fail ? ", " + fail + " FAILED" : ""));
process.exitCode = fail ? 1 : 0;
