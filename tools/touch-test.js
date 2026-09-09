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

console.log("\nthe dash");

/* Dash is: push the stick out to its outer ring. The rules that matter are the
   arming ones, and they exist because of what went wrong twice before —
   a gesture that fires when you did not ask spends a cooldown you were saving,
   and a gesture you have to discover is a gesture nobody uses.

   padPush(fraction, ready) drives it directly and says what happened. */

test("pushing the stick out to the ring dashes", () => {
  RPW.padDashReset();
  assert.strictEqual(RPW.padPush(0.2), "armed", "coming inside arms it");
  assert.strictEqual(RPW.padPush(0.95), "dash");
});

test("ordinary movement never reaches it", () => {
  RPW.padDashReset();
  RPW.padPush(0.2);
  // everything from the movement deadzone up to just short of the ring is
  // ordinary walking, and none of it may dash
  for (const f of [0.31, 0.45, 0.6, 0.7, 0.8, 0.9])
    assert.notStrictEqual(RPW.padPush(f), "dash",
      `holding the stick at ${f} of the radius dashed — that is normal movement`);
});

test("resting against the ring spends one dash, not a stream of them", () => {
  RPW.padDashReset();
  RPW.padPush(0.2);
  assert.strictEqual(RPW.padPush(1.0), "dash");
  for (let i = 0; i < 40; i++)
    assert.strictEqual(RPW.padPush(1.0), "held",
      "holding at the ring dashed again on repeat " + i);
});

test("and it only counts again after coming back inside", () => {
  RPW.padDashReset();
  RPW.padPush(0.2);
  RPW.padPush(1.0);
  assert.strictEqual(RPW.padPush(0.8), "inside",
    "easing back only to 0.8 must not re-arm — that is still a held push");
  assert.strictEqual(RPW.padPush(1.0), "held", "so the ring does nothing yet");
  assert.strictEqual(RPW.padPush(0.5), "armed", "0.5 is far enough back in");
  assert.strictEqual(RPW.padPush(1.0), "dash", "and then the ring works again");
});

test("a fresh touch starts disarmed, so grabbing the stick wide cannot dash", () => {
  // padDashReset() is what a pointerdown does: whatever the thumb lands on,
  // it has to come inside once before the ring means anything
  RPW.padDashReset();
  assert.strictEqual(RPW.padPush(1.2), "held",
    "landing a thumb outside the ring dashed on contact");
  assert.strictEqual(RPW.padPush(0.4), "armed");
  assert.strictEqual(RPW.padPush(1.0), "dash");
});

test("on cooldown the ring does nothing, and does not save the dash for later", () => {
  RPW.padDashReset();
  RPW.padPush(0.2);
  assert.strictEqual(RPW.padPush(1.0, false), "cooldown", "it should refuse while recharging");
  assert.strictEqual(RPW.padPush(1.0, true), "held",
    "and refusing must still consume the push — otherwise the dash fires by " +
    "itself the moment the cooldown returns, with the thumb never moving");
  RPW.padPush(0.4);
  assert.strictEqual(RPW.padPush(1.0, true), "dash");
});

test("the ring the player sees is the ring the code triggers on", () => {
  /* drawPad() scales the knob's travel against padInfo().dash.rim so that the
     knob's edge meets the drawn ring at exactly the magnitude that dashes. If
     the trigger and the reported rim ever drift apart, the gesture happens
     somewhere other than where the player can see it. */
  const rim = RPW.padInfo().dash.rim;
  assert.ok(rim > 0.5 && rim <= 1, "the rim is at " + rim + " of the radius, which is not a rim");
  RPW.padDashReset(); RPW.padPush(0.2);
  assert.notStrictEqual(RPW.padPush(rim - 0.02), "dash",
    "a push just short of the reported rim dashed");
  RPW.padDashReset(); RPW.padPush(0.2);
  assert.strictEqual(RPW.padPush(rim + 0.01), "dash",
    "a push just past the reported rim did not dash");
});

console.log(`\n${pass} passing`);
