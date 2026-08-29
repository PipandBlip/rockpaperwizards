/*
 * Determinism check — the assumption the netcode is built on.
 *
 * Runs the same match twice: same seed, same scripted input, and compares a
 * checksum of the whole simulation every 30 frames. If these two runs ever
 * disagree, lockstep multiplayer cannot work, because two players' machines
 * would drift apart in exactly the same way.
 *
 *   node tools/determinism.js            # a few seeds and modes
 *   SEEDS=20 node tools/determinism.js   # a longer sweep
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const code = fs.readFileSync(path.join(__dirname, "..", "src", "game.js"), "utf8");

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
function run({ seed, diff, room, frames, every = 30 }) {
  const els = {};
  const listeners = {};
  let frameCb = null;
  let clock = 1000;
  const rng = mulberry32(seed);
  const SMath = Object.create(Math);
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
  sandbox.window.matchMedia = () => ({ matches: false });
  sandbox.window.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
  sandbox.addEventListener = sandbox.window.addEventListener;

  els.pips = fakeEl("pips");
  for (let i = 0; i < 2; i++) els.pips.appendChild(fakeEl("pip"));
  els.diffRow = fakeEl("diffRow");
  for (let i = 0; i < 4; i++) els.diffRow.appendChild(fakeEl("d" + i));

  vm.createContext(sandbox);
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
    humans: 1
  });

  const SPELLS = [["y", .42, [2, 10]], ["u", .24, [6, 30]], ["i", .13, [20, 70]],
                  ["h", .11, [2, 8]], ["k", .06, [10, 40]], ["j", .04, [70, 170]]];
  const release = new Map();
  let moveKeys = [], moveUntil = 0;
  const marks = [];

  for (let i = 0; i < frames; i++) {
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

    clock += 16;
    frameCb(clock);
    if (i % every === 0) marks.push(sandbox.window.RPW.hash());
  }
  return marks;
}

const SEEDS = +(process.env.SEEDS || 6);
const FRAMES = +(process.env.FRAMES || 2400);
let bad = 0;

for (let seed = 1; seed <= SEEDS; seed++) {
  const cases = [
    { name: `duel   seed ${seed}`, opts: { seed, diff: 1, frames: FRAMES } },
    { name: `room 4 seed ${seed}`, opts: { seed, diff: 2, room: 4, frames: FRAMES } }
  ];
  for (const c of cases) {
    const a = run(c.opts);
    const b = run(c.opts);
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
