/*
 * Scenario rig for the ward.
 *
 *   node tools/ward-test.js
 *
 * The ward is light cover with a health bar. It is rated for spark and rive
 * only: it eats as much of one as it is still holding and shatters on the shot
 * that empties it. Anything heavier — a hexstone, a beam, a hurled crate — goes
 * straight through and takes the wall with it. It also thins on its own the
 * whole time it is up. These cases pin all of that down.
 *
 * game.js is a closed IIFE, so the rig appends one line to a copy of the
 * source that hands its internals out through globalThis. Nothing on disk
 * changes and the tested code is otherwise byte-identical.
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

let code = fs.readFileSync(path.join(__dirname, "..", "src", "game.js"), "utf8");
const tail = "\n})();";
if (!code.trimEnd().endsWith("})();")) throw new Error("game.js no longer ends in an IIFE — update this rig");
code = code.trimEnd().slice(0, -"})();".length) +
  "globalThis.__RPW = { SPELLS, byId, cast, strike, wardFacing, hurt, breakWard, WARD_BLOCKS," +
  " WARD_COS, WARD_R, get wizards(){ return wizards; }, get shots(){ return shots; }," +
  " get you(){ return you; }, get foe(){ return foe; } };\n})();";

/* ---- the same DOM stubs the sim harness uses ---- */
const gradStub = { addColorStop(){} };
function ctxStub(){
  return new Proxy({}, {
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
  const children = [];
  const el = {
    id, style:{ setProperty(){} }, textContent:"", innerHTML:"",
    classList:{ toggle(){}, add(){}, remove(){}, contains(){ return false; } },
    dataset:{}, hidden:false, children,
    appendChild(c){ children.push(c); return c; },
    _ls:{}, addEventListener(t, fn){ (el._ls[t] ||= []).push(fn); },
    dispatch(t, ev){ for (const fn of (el._ls[t]||[])) fn(ev||{}); },
    focus(){}, play(){ return { catch(){} }; }, pause(){}, setAttribute(){},
    volume:1, currentTime:0, closest(){ return null; },
    getContext(){ return ctxStub(); }, width:960, height:620
  };
  Object.defineProperty(el, "length", { get: () => children.length });
  el[Symbol.iterator] = function*(){ yield* children; };
  return el;
}
const els = {}, listeners = {};
let frameCb = null, clock = 1000;
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const SMath = Object.create(Math); SMath.random = mulberry32(9);
const sandbox = {
  process, console,
  performance: { now: () => clock },
  requestAnimationFrame(cb){ frameCb = cb; return 1; },
  setTimeout(fn){ if (typeof fn === "function"){ try { fn(); } catch(e){} } return 0; },
  Math: SMath, Date, Object, Array, JSON, Symbol, Proxy, Number, String, Boolean, Error,
  document: {
    getElementById(id){ return els[id] || (els[id] = fakeEl(id)); },
    createElement(tag){ return fakeEl(tag); }
  }
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
sandbox.window.matchMedia = () => ({ matches: false });
sandbox.window.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
sandbox.addEventListener = sandbox.window.addEventListener;
els.pips = fakeEl("pips"); els.pips.appendChild(fakeEl("pip")); els.pips.appendChild(fakeEl("pip"));
els.diffRow = fakeEl("diffRow");
for (let i = 0; i < 4; i++) els.diffRow.appendChild(fakeEl("d"+i));
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "game.js" });

const db = els.diffRow.children[1]; db.dataset.diff = "1"; db.closest = () => db;
els.diffRow.dispatch("click", { target: db });
els.goBtn.dispatch("click");
let t = 1000;
const step = () => { t += 16; clock = t; frameCb(t); };
step();

const G = sandbox.__RPW;
const { byId, cast, strike, wardFacing, WARD_BLOCKS } = G;

/* ---- assertions ---- */
let fails = 0, ran = 0;
const near = (a, b, eps=1e-6) => Math.abs(a-b) <= eps;
function check(name, cond, detail){
  ran++;
  if (cond) console.log("  ok  " + name);
  else { fails++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}
// a clean wizard facing +x, well away from anything
function subject(){
  const w = G.you;
  w.dead = false; w.hp = w.hpMax; w.mana = 100; w.facing = 0;
  w.x = 480; w.y = 310; w.ward = 0; w.wardMax = 0; w.wardFade = 0; w.wardTick = 0;
  w.charge = null; w.chargeT = 0; w.castLock = 0; w.beamOn = false; w.hurt = 0;
  return w;
}
const S = byId.ward;
const inFront = w => [w.x + 60, w.y];
const behind  = w => [w.x - 60, w.y];

console.log("ward");

// --- the bank is sized by charge time
{
  const w = subject(); cast(w, 3, 0);
  check("a tapped ward banks the base absorption",
        near(w.wardMax, S.absorb), "wardMax=" + w.wardMax);
  const f = subject(); cast(f, 3, 1);
  check("a full charge banks base + charge",
        near(f.wardMax, S.absorb + S.chargeA), "wardMax=" + f.wardMax);
  const h = subject(); cast(h, 3, .5);
  check("half a charge banks half the bonus",
        near(h.wardMax, S.absorb + S.chargeA*.5), "wardMax=" + h.wardMax);
}

// --- it holds spark and rive, and passes the overflow
{
  const w = subject(); cast(w, 3, 0);              // bank of 20
  strike(w, 8, ...inFront(w), "spark", false);
  check("a spark inside the bank is eaten whole", near(w.ward, 12) && w.hp === w.hpMax,
        "ward=" + w.ward + " hp=" + w.hp);
  strike(w, 30, ...inFront(w), "rive", false);
  check("an oversized rive is eaten down to the bank, remainder lands",
        w.ward === 0 && near(w.hp, w.hpMax - 18), "hp=" + w.hp);
  check("the shot that empties it shatters the wall", w.ward === 0 && w.wardMax === 0);
}

// --- the exact-fit case: the wall dies but nothing gets through
{
  const w = subject(); cast(w, 3, 0);
  strike(w, w.ward, ...inFront(w), "spark", false);
  check("a shot that exactly empties it costs no health",
        w.ward === 0 && w.hp === w.hpMax, "hp=" + w.hp);
}

// --- and it is rated for nothing else
{
  for (const kind of ["hex", "beam", "prop"]){
    const w = subject(); cast(w, 3, 1);            // a full wall, 60
    const bank = w.ward;
    strike(w, 24, ...inFront(w), kind, false);
    check("a " + kind + " is not something a wall holds — full damage lands",
          near(w.hp, w.hpMax - 24), "hp=" + w.hp);
    check("a " + kind + " shatters the wall on the way through",
          w.ward === 0 && w.wardMax === 0, "ward=" + w.ward + " (was " + bank + ")");
  }
}

// --- what the wall is rated for, stated once
{
  check("only spark and rive are held",
        !!WARD_BLOCKS.spark && !!WARD_BLOCKS.rive &&
        !WARD_BLOCKS.hex && !WARD_BLOCKS.beam && !WARD_BLOCKS.prop,
        JSON.stringify(WARD_BLOCKS));
}

// --- direction still matters
{
  const w = subject(); cast(w, 3, 1);
  check("the wall faces where the wizard faces", wardFacing(w, ...inFront(w)));
  check("nothing guards your back", !wardFacing(w, ...behind(w)));
  const before = w.ward;
  strike(w, 25, ...behind(w), "spark", false);
  check("a spark from behind ignores the wall entirely",
        near(w.ward, before) && near(w.hp, w.hpMax - 25), "hp=" + w.hp);
}

// --- a beam is no longer answered by a wall
{
  const w = subject(); cast(w, 3, 1);
  const dt = 1/60;
  strike(w, byId.beam.dmg*dt, ...inFront(w), "beam", true);
  check("one frame of beam is enough to take the wall down", w.ward === 0);
  check("and that same frame still burns the wizard", w.hp < w.hpMax,
        "lost " + (w.hpMax - w.hp).toFixed(3));
}

// --- the wall thins on its own
{
  const tap = subject(); cast(tap, 3, 0);
  check("a tapped wall bleeds out over its short life",
        near(tap.wardFade, tap.wardMax / 2.4), "fade=" + tap.wardFade.toFixed(2) + "/s");
  const full = subject(); cast(full, 3, 1);
  check("a charged wall banks more but also stands longer",
        near(full.wardFade, full.wardMax / 3.8), "fade=" + full.wardFade.toFixed(2) + "/s");
  // drain it with nothing hitting it, exactly as the frame loop does
  const dt = 1/60; let secs = 0;
  while (full.ward > 0 && secs < 20){ full.ward -= full.wardFade*dt; secs += dt; }
  check("left alone it is gone in about its stated life",
        Math.abs(secs - 3.8) < .05, secs.toFixed(2) + "s");
  const half = subject(); cast(half, 3, 1);
  for (let i = 0; i < 114; i++) half.ward -= half.wardFade*dt;   // 1.9s, half its life
  check("a wall raised early is already half gone when the shot lands",
        Math.abs(half.ward - half.wardMax/2) < 1, "ward=" + half.ward.toFixed(1));
}

// --- no ward, no change
{
  const w = subject();
  strike(w, 17, ...inFront(w), "spark", false);
  check("with no wall up a shot lands in full", near(w.hp, w.hpMax - 17), "hp=" + w.hp);
}

console.log("\n" + (fails ? fails + " of " + ran + " failed" : "all " + ran + " ward checks pass"));
process.exit(fails ? 1 : 0);
