/*
 * Headless rig for src/game.js.
 *
 * Stubs just enough DOM and canvas for the game to run with no browser, drives
 * it with a scripted player, and seeds Math.random so a run is reproducible:
 *
 *   SEED=7 DIFF=2 SECS=120 node tools/sim-harness.js
 *
 * Env: SEED, SECS, DIFF (0-2 tiers, 3 escalation), ROOM=<2-6>, HUMANS=<1-2>,
 * BEAMY=1 for a beam-heavy player, FOG=1 for fog of war (with ROOM).
 * HUMANS>1 stands in for the extra human seats
 * a networked match creates — there is no local co-op in the menu any more.
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const code = fs.readFileSync(path.join(__dirname, "..", "src", "game.js"), "utf8");

const gradStub = { addColorStop(){} };
function ctxStub(){
  const target = {};
  return new Proxy(target, {
    get(t, p){
      if (p in t) return t[p];
      if (p === "createRadialGradient" || p === "createLinearGradient") return () => gradStub;
      if (p === "canvas") return { width: 960, height: 620 };
      return () => {};
    },
    set(t, p, v){ t[p] = v; return true; }
  });
}
function fakeEl(id){
  const style = { setProperty(){}, };
  const children = [];
  const el = {
    id, style, textContent: "", innerHTML: "",
    classList: { toggle(){}, add(){}, remove(){}, contains(){ return false; } },
    dataset: {},
    hidden: false,
    children,
    appendChild(c){ children.push(c); return c; },
    _ls: {},
    addEventListener(t, fn){ (el._ls[t] ||= []).push(fn); },
    dispatch(t, ev){ for (const fn of (el._ls[t]||[])) fn(ev||{}); },
    focus(){},
    play(){ return { catch(){} }; },
    pause(){},
    setAttribute(){},
    volume: 1,
    currentTime: 0,
    closest(){ return null; },
    getContext(){ return ctxStub(); },
    width: 960, height: 620
  };
  Object.defineProperty(el, "length", { get: () => children.length });
  el[Symbol.iterator] = function*(){ yield* children; };
  return el;
}

const els = {};
const listeners = {};
let frameCb = null;

const SEED = +(process.env.SEED || 1);
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const SMath = Object.create(Math);
SMath.random = rng;
let clock = 1000;
const sandbox = {
  process,
  console,
  performance: { now: () => clock },
  requestAnimationFrame(cb){ frameCb = cb; return 1; },
  setTimeout(fn){ if (typeof fn === "function") { try { fn(); } catch(e){} } return 0; },
  Math: SMath, Date, Object, Array, JSON, Symbol, Proxy, Number, String, Boolean, Error,
  document: {
    getElementById(id){ return els[id] || (els[id] = fakeEl(id)); },
    createElement(tag){ return fakeEl(tag); }
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
for (let i = 0; i < 4; i++) els.diffRow.appendChild(fakeEl("d"+i));

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "game.js" });

function fire(type, key){
  for (const fn of listeners[type] || []) fn({ key, preventDefault(){}, target:{ tagName:"BODY" } });
}

// start a match: click handler was registered on button via addEventListener stub (no-op),
// so drive flow directly through the captured frame loop + key events.
// A "reasonable novice" policy: mostly sparks and rive, occasional charge,
// ward when pressed, and the beam only rarely — not a key-masher.
const SPELLS = process.env.BEAMY
  ? [["y",.25,[2,10]],["u",.15,[6,30]],["j",.60,[60,150]]]
  : [["y",.42,[2,10]],["u",.24,[6,30]],["i",.13,[20,70]],["h",.11,[2,8]],["k",.06,[10,40]],["j",.04,[70,170]]];
let errors = 0;
const DIFF = +(process.env.DIFF || 1);
const db = els.diffRow.children[DIFF]; db.dataset.diff = String(DIFF); db.closest = () => db;
els.diffRow.dispatch("click", { target: db });
if (process.env.ROOM){
  // Local co-op is gone from the menu, so a multi-human room can only be reached
  // the way a networked match reaches it — through startMatch. Driving that same
  // entry point here is better coverage than the old widget clicks anyway.
  sandbox.window.RPW.startMatch({
    mode: "match",
    seed: SEED,
    total: +(process.env.ROOM),
    humans: +(process.env.HUMANS || 1),
    seat: 0,
    difficulty: DIFF,
    opts: process.env.FOG ? { fog: 1, mapPreset: "random" } : null
  });
} else {
  els.goBtn.dispatch("click");
}
let foeBeams = 0, youBeams = 0;
els.sfxBeamB.play = () => { foeBeams++; return { catch(){} }; };
els.sfxBeamA.play = () => { youBeams++; return { catch(){} }; };
let clashCount = 0;
els.sfxClash.play = () => { clashCount++; return { catch(){} }; };
let t = Date.now();
const FRAMES = 60 * (+(process.env.SECS||90));
const release = new Map();          // key -> frame index to release on
let moveKeys = [], moveUntil = 0, slideUntil = 0;
const p2move = []; let p2cast = null, p2until = 0;
function pickSpell(){
  let r = rng(), acc = 0;
  for (const [k,p,dur] of SPELLS){ acc += p; if (r <= acc) return [k, dur]; }
  return ["y",[2,10]];
}
for (let i = 0; i < FRAMES; i++){
  // movement: commit to a direction for a while
  if (i >= moveUntil){
    for (const k of moveKeys) fire("keyup", k);
    moveKeys = [];
    const pool = ["w","a","s","d"];
    const n = rng() < .25 ? 0 : (rng() < .6 ? 1 : 2);
    while (moveKeys.length < n){
      const k = pool[(rng()*4)|0];
      if (!moveKeys.includes(k)) { moveKeys.push(k); fire("keydown", k); }
    }
    moveUntil = i + 30 + (rng()*70|0);
  }
  // dash now and then
  if (rng() < 0.004){
    fire("keydown","shift"); fire("keyup","shift");
    if (rng() < .5){ fire("keydown","control"); slideUntil = i + 20 + (rng()*20|0); }
  }
  if (slideUntil && i >= slideUntil){ fire("keyup","control"); slideUntil = 0; }
  // player two (versus mode only; harmless otherwise)
  if (+(process.env.HUMANS||0) > 1){
    if (i % 97 === 0){
      const mk = ["arrowup","arrowdown","arrowleft","arrowright"][(rng()*4)|0];
      fire("keydown", mk); setTimeout;
      p2move.push([mk, i + 40 + (rng()*40|0)]);
    }
    for (let q = p2move.length-1; q >= 0; q--) if (i >= p2move[q][1]){ fire("keyup", p2move[q][0]); p2move.splice(q,1); }
    if (p2cast === null && rng() < 0.04){
      p2cast = ["1","2","3","4","6"][(rng()*5)|0];
      fire("keydown", p2cast);
      p2until = i + 4 + (rng()*30|0);
    }
    if (p2cast !== null && i >= p2until){ fire("keyup", p2cast); p2cast = null; }
  }
  // casting
  if (release.size === 0 && rng() < 0.05){
    const [k, dur] = pickSpell();
    fire("keydown", k);
    release.set(k, i + dur[0] + (rng()*(dur[1]-dur[0])|0));
  }
  for (const [k, at] of [...release]) if (i >= at){ fire("keyup", k); release.delete(k); }

  t += 16; clock = t;
  try {
    frameCb(t);
  } catch (e){
    errors++;
    console.error("FRAME ERROR seed=" + SEED + " @", i, e.stack.split("\n").slice(0,6).join("\n   "));
    if (errors > 4) break;
  }
}
console.log("beam starts -> you:", youBeams, "foe:", foeBeams, "| clashes:", clashCount);
console.log("board html len:", (els.board.innerHTML||"").length, "| rails:", els.rails.children.length);
console.log("outcome:", els.curtainTitle.textContent, "|", els.roundLabel.textContent);
console.log(errors === 0 ? "OK: " + FRAMES + " frames, no exceptions" : "FAILED with " + errors + " errors");
