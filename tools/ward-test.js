/*
 * Scenario rig for the ward.
 *
 *   node tools/ward-test.js
 *
 * The ward is a bank of damage: it eats as much of any blow as it is still
 * holding, passes only the remainder through, and shatters on the blow that
 * empties it. These cases pin that down for each thing that can hit you —
 * a shot, a hurled prop, a beam — and for the frontal arc it only covers.
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
  "globalThis.__RPW = { SPELLS, byId, cast, strike, wardFacing, hurt, breakWard," +
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
const { byId, cast, strike, wardFacing, WARD_R } = G;

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
  w.x = 480; w.y = 310; w.ward = 0; w.wardMax = 0; w.wardT = 0; w.wardTick = 0;
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

// --- it eats what it can and passes the rest
{
  const w = subject(); cast(w, 3, 0);              // bank of 20
  strike(w, 8, ...inFront(w), false);
  check("a small blow is eaten whole", near(w.ward, 12) && w.hp === w.hpMax,
        "ward=" + w.ward + " hp=" + w.hp);
  strike(w, 30, ...inFront(w), false);
  check("an oversized blow is eaten down to the bank, remainder lands",
        w.ward === 0 && near(w.hp, w.hpMax - 18), "hp=" + w.hp);
  check("emptying the bank shatters the wall", w.wardT === 0 && w.ward === 0);
}

// --- the exact-fit case: the wall dies but nothing gets through
{
  const w = subject(); cast(w, 3, 0);
  strike(w, w.ward, ...inFront(w), false);
  check("a blow that exactly empties it costs no health",
        w.ward === 0 && w.hp === w.hpMax, "hp=" + w.hp);
}

// --- direction still matters
{
  const w = subject(); cast(w, 3, 1);
  check("the wall faces where the wizard faces", wardFacing(w, ...inFront(w)));
  check("nothing guards your back", !wardFacing(w, ...behind(w)));
  const before = w.ward;
  strike(w, 25, ...behind(w), false);
  check("a blow from behind ignores the wall entirely",
        w.ward === before && near(w.hp, w.hpMax - 25), "hp=" + w.hp);
}

// --- a beam grinds it down rather than skipping it
{
  const w = subject(); cast(w, 3, 1);
  const bank = w.ward, dps = byId.beam.dmg, dt = 1/60;
  let frames = 0;
  while (w.ward > 0 && frames < 1000){ strike(w, dps*dt, w.x + 200, w.y, true); frames++; }
  // the frame that empties the bank leaks its remainder, and nothing before it does
  check("a beam drains the wall before it touches the wizard",
        w.hpMax - w.hp < dps*dt, "lost " + (w.hpMax - w.hp).toFixed(3));
  check("the wall lasts about bank/dps seconds under a beam",
        Math.abs(frames/60 - bank/dps) < .05, (frames/60).toFixed(2) + "s vs " + (bank/dps).toFixed(2) + "s");
  strike(w, dps*dt, w.x + 200, w.y, true);
  check("once it is gone the beam burns normally", w.hp < w.hpMax);
}

// --- a beam is stopped short at the wall, not at the robe
{
  const a = subject();
  const b = G.foe;
  b.dead = false; b.hp = b.hpMax; b.ward = 0; b.wardT = 0;
  b.x = 200; b.y = 310; b.facing = 0;
  a.x = 500; a.y = 310; a.facing = Math.PI;   // a faces b
  cast(a, 3, 1);
  const reach = Math.hypot(a.x - b.x, a.y - b.y);
  check("a raised ward stands off the wizard", near(WARD_R, 40) || WARD_R > a.r,
        "WARD_R=" + WARD_R);
  check("the ward covers the line the beam would take", wardFacing(a, b.x, b.y),
        "reach=" + reach.toFixed(0));
}

// --- no ward, no change
{
  const w = subject();
  strike(w, 17, ...inFront(w), false);
  check("with no wall up a blow lands in full", near(w.hp, w.hpMax - 17), "hp=" + w.hp);
}

console.log("\n" + (fails ? fails + " of " + ran + " failed" : "all " + ran + " ward checks pass"));
process.exit(fails ? 1 : 0);
