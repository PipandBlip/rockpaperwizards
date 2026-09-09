/*
 * The touch pad's arithmetic, without a browser.
 *
 * Most of the touch layer needs a pointer, a canvas and a phone-shaped window,
 * and tools/phone-check.js drives all of that in a real browser. But the two
 * pieces most able to be quietly wrong — which spell a direction means, and
 * which movement keys a push stands for — are pure maths, and pure maths should
 * not need a browser to be checked. A sector table off by one rotation ships a
 * game where pushing up casts the wrong spell, and nothing else here would say
 * a word about it.
 *
 *   node tools/touch-test.js
 */
"use strict";
const assert = require("assert");
const { boot } = require("./determinism");

let pass = 0;
function test(name, fn){
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e){ console.error("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; }
}

const rig = boot({ seed: 1, diff: 1 });
const RPW = rig.sandbox.window.RPW;
const at = deg => RPW.padAt(deg);

console.log("\nthe pad's arithmetic");

test("the headless rig is not a touch device, so none of this is switched on", () => {
  assert.strictEqual(RPW.touch(), false,
    "the rig has no pointer and no matchMedia; detecting touch here means the " +
    "detection is guessing, and a desktop would get thumb sticks");
});

/* The layout is not arbitrary: it copies the keyboard so that knowing one
   teaches the other. y u i are the top row left-to-right, h j k the bottom. */
test("the six sectors mirror the keyboard's two rows", () => {
  assert.strictEqual(at(210).spell, "y", "upper-left should be Spark (y)");
  assert.strictEqual(at(270).spell, "u", "straight up should be Rive (u)");
  assert.strictEqual(at(330).spell, "i", "upper-right should be Hexstone (i)");
  assert.strictEqual(at(150).spell, "h", "lower-left should be Ward (h)");
  assert.strictEqual(at(90).spell,  "j", "straight down should be Beam (j)");
  assert.strictEqual(at(30).spell,  "k", "lower-right should be Grasp (k)");
});

test("every angle picks exactly one spell, and all six are reachable", () => {
  const seen = {};
  for (let d = 0; d < 360; d++){
    const s = at(d).spell;
    assert.ok(s, "angle " + d + " picked nothing");
    seen[s] = (seen[s] || 0) + 1;
  }
  assert.deepStrictEqual(Object.keys(seen).sort(), ["h","i","j","k","u","y"],
    "not every spell can be reached: " + JSON.stringify(seen));
  for (const k in seen)
    assert.strictEqual(seen[k], 60, `spell ${k} owns ${seen[k]} degrees, not an even sixth`);
});

test("a sector is centred on its label, not straddling it", () => {
  // 25 degrees either side of a centre must still be that spell, or the label
  // is drawn somewhere the thumb does not actually select
  for (const [deg, key] of [[210,"y"],[270,"u"],[330,"i"],[150,"h"],[90,"j"],[30,"k"]]){
    assert.strictEqual(at(deg - 25).spell, key, `${key} fails 25deg anticlockwise of centre`);
    assert.strictEqual(at(deg + 25).spell, key, `${key} fails 25deg clockwise of centre`);
  }
});

test("the sector maths survives angles outside 0-360", () => {
  assert.strictEqual(at(-90).spell, at(270).spell);
  assert.strictEqual(at(630).spell, at(270).spell);
});

console.log("\nthe movement stick");

test("the four cardinals press exactly one key each", () => {
  const only = (d, k) => {
    const x = at(d).dirs;
    for (const n of ["up","down","left","right"])
      assert.strictEqual(x[n], n === k, `pushing ${d}deg: ${n} is ${x[n]}, wanted ${n === k}`);
  };
  only(0, "right"); only(90, "down"); only(180, "left"); only(270, "up");
});

test("the diagonals press two, which is what makes eight directions", () => {
  const d = at(45).dirs;
  assert.ok(d.right && d.down && !d.left && !d.up, "down-right: " + JSON.stringify(d));
  const e = at(225).dirs;
  assert.ok(e.left && e.up && !e.right && !e.down, "up-left: " + JSON.stringify(e));
});

test("no push ever presses two opposite keys, which would cancel to standing still", () => {
  for (let deg = 0; deg < 360; deg++){
    const d = at(deg).dirs;
    assert.ok(!(d.left && d.right), "angle " + deg + " presses left and right at once");
    assert.ok(!(d.up && d.down), "angle " + deg + " presses up and down at once");
    assert.ok(d.left || d.right || d.up || d.down, "angle " + deg + " presses nothing");
  }
});

console.log(`\n${pass} passing`);
