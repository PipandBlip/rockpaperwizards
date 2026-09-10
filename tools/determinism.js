/*
 * Determinism check — the assumption the netcode is built on.
 *
 * Runs the same match twice: same seed, same scripted input, and compares a
 * checksum of the whole simulation every 30 frames. If these two runs ever
 * disagree, lockstep multiplayer cannot work, because two players' machines
 * would drift apart in exactly the same way.
 *
 *   node tools/determinism.js            # a few seeds and modes
 *   SEEDS=20 node tools/determinism.js               # a longer sweep
 *   SEED_FROM=4 SEEDS=6 node tools/determinism.js  # just seeds 4 to 6
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

/* RPW_GAME_SRC points the rig at a different copy of the game — the only use is
   booting an OLD build beside the current one to compare them frame for frame,
   which is the only honest way to answer "does this look less stiff than it
   did". Unset, it is exactly the file the site ships. */
const code = fs.readFileSync(process.env.RPW_GAME_SRC || path.join(__dirname, "..", "src", "game.js"), "utf8");
/* The account script comes with it. Without RPWA there is no cloak ladder, so
   every cape in the rig sat on rung 1 and none of the higher rungs' cloth,
   seams or tail shapes were ever executed — a crash from level 8 up could pass
   this whole suite. It touches no seeded RNG and makes no network call unless
   asked, so loading it changes nothing the simulation can see. */
const acctCode = fs.readFileSync(path.join(__dirname, "..", "src", "account.js"), "utf8");

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function ctxStub() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === "createRadialGradient" || p === "createLinearGradient") return () => grad;
      if (p === "canvas") return { width: 960, height: 620 };
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; }
  });
}

function fakeEl(id) {
  const children = [];
  const el = {
    id, style: { setProperty() {} }, textContent: "", innerHTML: "", value: "",
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    dataset: {}, hidden: false, children,
    appendChild(c) { children.push(c); return c; },
    _ls: {},
    addEventListener(t, fn) { (el._ls[t] ||= []).push(fn); },
    dispatch(t, ev) { for (const fn of (el._ls[t] || [])) fn(ev || {}); },
    focus() {}, play() { return { catch() {} }; }, pause() {}, setAttribute() {},
    volume: 1, currentTime: 0, closest() { return null; },
    getContext() { return ctxStub(); }, width: 960, height: 620
  };
  el[Symbol.iterator] = function* () { yield* children; };
  Object.defineProperty(el, "length", { get: () => children.length });
  return el;
}

/** run one match, returning a checksum every `every` frames */
/* Boot the game in a stubbed DOM and hand back the controls.
   Split out of run() so other rigs — tools/input-test.js — can drive the same
   sandbox instead of keeping a second copy of these stubs in step with this one. */
/* A Math whose engine-approximated functions are one unit in the last place out.

   The spec pins down +, -, *, / and sqrt; it does NOT pin down sin, cos, tan,
   atan2, hypot, exp, pow or log, and real engines differ in the last bit. This
   models "the other player is on a different browser" exactly, and lets a test
   assert the thing that matters: that the SIMULATION cannot tell. */
const _skF = new Float64Array(1), _skU = new BigUint64Array(_skF.buffer);
function skewedMath(base) {
  const M = Object.create(base);
  for (const fn of ["sin","cos","tan","atan2","atan","asin","acos","hypot","exp","log","pow","cbrt","sinh","cosh","tanh","log2","log10","expm1","log1p"]) {
    if (typeof base[fn] !== "function") continue;
    const f = base[fn];
    M[fn] = function (...a) {
      const v = f.apply(base, a);
      if (!Number.isFinite(v) || v === 0) return v;
      _skF[0] = v; _skU[0] += (v > 0 ? 1n : -1n); return _skF[0];
    };
  }
  return M;
}

function boot({ seed = 1, diff = 1, room = 0, opts = null, seat = 0, humans = 1,
                reducedMotion = false, skew = false } = {}) {
  const els = {};
  const listeners = {};
  let frameCb = null;
  let clock = 1000;
  const rng = mulberry32(seed);
  const SMath = Object.create(skew ? skewedMath(Math) : Math);
  SMath.random = rng;

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    performance: { now: () => clock },
    requestAnimationFrame(cb) { frameCb = cb; return 1; },
    setTimeout() { return 0; },
    Math: SMath, Date, Object, Array, JSON, Symbol, Proxy, Number, String, Boolean, Error,
    document: {
      getElementById(id) { return els[id] || (els[id] = fakeEl(id)); },
      createElement() { return fakeEl("div"); }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  /* The operating system's "reduce motion" setting. It is a PER-MACHINE
     preference, so anything the simulation reads from it is a desync between
     two players whose machines disagree — which is exactly what shipped once.
     The rig can boot either way so a test can prove the sim ignores it. */
  sandbox.window.matchMedia = () => ({ matches: !!reducedMotion });
  sandbox.window.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
  sandbox.addEventListener = sandbox.window.addEventListener;

  els.pips = fakeEl("pips");
  for (let i = 0; i < 2; i++) els.pips.appendChild(fakeEl("pip"));
  els.diffRow = fakeEl("diffRow");
  for (let i = 0; i < 4; i++) els.diffRow.appendChild(fakeEl("d" + i));

  vm.createContext(sandbox);
  sandbox.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
  vm.runInContext(acctCode, sandbox, { filename: "account.js" });
  vm.runInContext(code, sandbox, { filename: "game.js" });

  const fire = (type, key) => {
    for (const fn of listeners[type] || []) fn({ key, preventDefault() {}, target: { tagName: "BODY" } });
  };

  // start through the same entry point the network layer uses, with a fixed seed
  sandbox.window.RPW.startMatch({
    mode: room ? "match" : "duel",
    seed,
    difficulty: diff,
    total: room || 2,
    humans,
    seat,
    opts
  });

  return {
    sandbox, fire, rng,
    RPW: sandbox.window.RPW,
    // advance exactly one rendered frame, the way the browser would
    step(ms = 16){ clock += ms; frameCb(clock); },
    now: () => clock
  };
}

function run({ seed, diff, room, frames, every = 30, opts = null, preset = null, seat = 0, humans = 1, idle = false, reducedMotion = false, skew = false }) {
  const rig = boot({ seed, diff, room, opts, seat, humans, reducedMotion, skew });
  /* A fixed layout, started the way an OFFLINE match starts — no NET.active.
     Presets used to be gated on a live network match, which made the arena
     picker do nothing in solo; these runs would have passed anyway and told us
     nothing. Started this way they cover the path a player actually takes, and
     the themed props still draw from the same seeded stream as everything else,
     so they would desync just as loudly if they were wrong. */
  if (preset){
    rig.RPW.startMatch({ mode: "match", seed, difficulty: diff, total: room || 2,
                         humans: 1, opts: Object.assign({}, opts, { mapPreset: preset }) });
  }
  const { fire, rng, sandbox } = rig;

  const SPELLS = [["y", .42, [2, 10]], ["u", .24, [6, 30]], ["i", .13, [20, 70]],
                  ["h", .11, [2, 8]], ["k", .06, [10, 40]], ["j", .04, [70, 170]]];
  const release = new Map();
  let moveKeys = [], moveUntil = 0;
  const marks = [];

  for (let i = 0; i < frames; i++) {
    /* An idle run presses nothing at all. That is the point: two idle runs that
       differ ONLY in which seat is "you" must produce the same hashes, and they
       will not if any line of the simulation reads the local wizard. That is
       precisely the mistake co-op escalation invited — spawn points chosen
       relative to `you`, kills healing `you` — and a same-seat run could never
       have caught it, because `you` is the same wizard in both halves. */
    if (idle) { rig.step(); if (i % every === 0) marks.push(sandbox.window.RPW.hash()); continue; }
    if (i >= moveUntil) {
      for (const k of moveKeys) fire("keyup", k);
      moveKeys = [];
      const pool = ["w", "a", "s", "d"];
      const n = rng() < .25 ? 0 : (rng() < .6 ? 1 : 2);
      while (moveKeys.length < n) {
        const k = pool[(rng() * 4) | 0];
        if (!moveKeys.includes(k)) { moveKeys.push(k); fire("keydown", k); }
      }
      moveUntil = i + 30 + (rng() * 70 | 0);
    }
    if (rng() < 0.004) { fire("keydown", "shift"); fire("keyup", "shift"); }
    if (release.size === 0 && rng() < 0.05) {
      let r = rng(), acc = 0, pick = SPELLS[0];
      for (const sp of SPELLS) { acc += sp[1]; if (r <= acc) { pick = sp; break; } }
      fire("keydown", pick[0]);
      release.set(pick[0], i + pick[2][0] + (rng() * (pick[2][1] - pick[2][0]) | 0));
    }
    for (const [k, at] of [...release]) if (i >= at) { fire("keyup", k); release.delete(k); }

    rig.step();
    if (i % every === 0) marks.push(sandbox.window.RPW.hash());
  }
  return marks;
}

// Also usable as a module, so tools/golden.js can drive the same rig to record
// what the bots actually DO — the check that an optimisation left behaviour
// alone, which this file on its own cannot make (it compares a build against
// itself, not against yesterday's).
module.exports = { run, boot, skewedMath };
if (require.main !== module) return;

const SEEDS = +(process.env.SEEDS || 6);
// SEED_FROM lets the sweep be split across runs — useful when a shell has a
// shorter patience than the whole suite.
const SEED_FROM = +(process.env.SEED_FROM || 1);
const FRAMES = +(process.env.FRAMES || 2400);
let bad = 0;

for (let seed = SEED_FROM; seed <= SEEDS; seed++) {
  const cases = [
    { name: `duel   seed ${seed}`, opts: { seed, diff: 1, frames: FRAMES } },
    { name: `room 4 seed ${seed}`, opts: { seed, diff: 2, room: 4, frames: FRAMES } },
    // Fog changes what the bots are allowed to know, so it is a different
    // simulation — and one every client must still agree on frame for frame.
    { name: `fog    seed ${seed}`, opts: { seed, diff: 2, frames: FRAMES,
                                          opts: { fog: 1, mapPreset: "random" } } },
    { name: `fog r4 seed ${seed}`, opts: { seed, diff: 2, room: 4, frames: FRAMES,
                                          opts: { fog: 1, mapSize: "large", mapPreset: "random" } } },
    { name: `forest seed ${seed}`, opts: { seed, diff: 2, room: 4, frames: FRAMES, preset: "forest" } },
    { name: `castle seed ${seed}`, opts: { seed, diff: 2, room: 4, frames: FRAMES, preset: "castle" } },
    // Escalation: solo, then a party of four sharing team 0 against the waves.
    { name: `esc    seed ${seed}`, opts: { seed, diff: 1, frames: FRAMES } , solo: true },
    { name: `co-op  seed ${seed}`, opts: { seed, diff: 1, room: 4, humans: 4, frames: FRAMES,
                                          opts: { coop: 1, mapPreset: "random" } } }
  ];
  /* The cross-seat pairs are the expensive half of this file — two full rigs
     each — so they run on the first three seeds rather than all six. Three is
     enough: a simulation that reads the local player is wrong on every seed,
     not on unlucky ones. */
  if (seed <= 3){
  // A co-op run is also checked ACROSS SEATS: the same match watched from seat
  // 0 and from seat 3 must agree frame for frame, which is the only shape of
  // test that catches a simulation reading the local player.
  cases.push({
    name: `co-op seats ${seed}`,
    opts: { seed, diff: 1, room: 4, humans: 4, frames: FRAMES, idle: true, seat: 0,
            opts: { coop: 1, mapPreset: "random" } },
    other: { seat: 3 }
  });
  /* And again with a MIXED party: seats 0-1 human (idle), 2-3 ally bots. The
     bots actually kill things, which is what exercises the kill reward — that
     reward used to heal `you`. Both compared seats must be human ones, or both
     rigs resolve `you` to the same wizard and the case proves nothing. */
  /* Two machines that disagree about "reduce motion" must still produce the
     same world. This is not a hypothetical: hit-stop — which scales dt for the
     WHOLE simulation — used to be skipped for reduce-motion players, so a duel
     between one machine with it on and one with it off fell out of sync on the
     first heavy hit, about six seconds in. Every other case in this file boots
     both halves the same way and could never have seen it. */
  /* Driven by the BOTS, with no scripted keypresses. That matters: this rig
     wires Math.random to the same generator the input script draws from, so a
     run with fewer view-only particles would otherwise get different keys
     pressed and fail for a reason that has nothing to do with the game. Idle,
     the only thing that can differ is the simulation itself. */
  cases.push({
    name: `reduce-motion ${seed}`,
    opts: { seed, diff: 2, room: 4, humans: 1, frames: FRAMES, idle: true, reducedMotion: false },
    other: { reducedMotion: true }
  });
  cases.push({
    name: `co-op mixed ${seed}`,
    opts: { seed, diff: 1, room: 4, humans: 2, frames: FRAMES, idle: true, seat: 0,
            opts: { coop: 1, mapPreset: "random" } },
    other: { seat: 1 }
  });
  }

  for (const c of cases) {
    if (c.solo) c.opts.opts = Object.assign({ mapPreset: "random" }, c.opts.opts, { coop: 1 });
    const a = run(c.opts);
    const b = run(c.other ? Object.assign({}, c.opts, c.other) : c.opts);
    const at = a.findIndex((h, i) => h !== b[i]);
    if (at < 0) {
      console.log(`  ok  ${c.name} — ${a.length} checkpoints identical`);
    } else {
      bad++;
      console.error(`FAIL  ${c.name} — diverged at checkpoint ${at} (frame ${at * 30})`);
    }
  }
}

console.log(bad ? `\n${bad} runs diverged` : `\nall runs deterministic`);
process.exitCode = bad ? 1 : 0;
