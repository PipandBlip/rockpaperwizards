(() => {
"use strict";

const W = 960, H = 620;
const cvs = document.getElementById("game");
let ctx = cvs.getContext("2d");
// spells and sparks are drawn into their own light layer that only partly clears
// each frame, so fast things leave a streak instead of teleporting.
const fx = document.createElement("canvas");
fx.width = W; fx.height = H;
const fxc = fx.getContext("2d");
// the fog shroud is built on its own layer so the sight radius can be cut out of
// the darkness and then painted back in wherever a wall casts a shadow
const fogCv = document.createElement("canvas");
fogCv.width = W; fogCv.height = H;
const fogC = fogCv.getContext("2d");
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ============================================ deterministic simulation maths

   Two players on different browsers had matches fall apart after a few minutes,
   always just after two beams locked against each other. It was not the network
   and not the netcode: it was Math.sin.

   The ECMAScript spec requires +, -, *, / and Math.sqrt to be correctly rounded
   — those give bit-identical answers on every engine, forever. It does NOT
   require that of sin, cos, tan, atan2, hypot, exp, pow or log. Those are
   "implementation-approximated": V8, SpiderMonkey and JavaScriptCore are each
   free to return a slightly different double for the same input, and they do.

   In a lockstep game that is fatal, because every client must compute the same
   world from the same inputs. Most of the time a last-bit difference washes out
   — positions get clamped, hits are threshold tests. The BEAM CLASH does the
   opposite. The orb's position along the line between two wizards is carried
   from frame to frame and slid toward a target computed from both wizards' mana;
   it is a feedback loop with memory and no quantisation, so it holds a tiny
   difference and grows it. A few seconds later the two beams are different
   lengths, they burn different props, and the scenery hashes stop matching. That
   is exactly the report we kept getting: "the scenery", several thousand frames
   in, right after a beam fight.

   So the simulation does its own trigonometry, built only from the operations
   the spec pins down. These are within about one unit in the last place of the
   native versions — accuracy was never the problem, agreement was.

   Drawing may still use Math.*: nothing outside this client depends on where a
   spark was painted. Anything that touches simulation state must use these. */
const PI = 3.141592653589793, PI_2 = 1.5707963267948966;
const _dmF = new Float64Array(2), _dmU = new Uint32Array(_dmF.buffer);
function ldexp(x, k){                       // x * 2^k without pow()
  if (x === 0 || !Number.isFinite(x)) return x;
  let r = x;
  while (k > 1000){ r *= 8.98846567431158e307; k -= 1023; }
  while (k < -1000){ r *= 2.2250738585072014e-308; k += 1022; }
  _dmF[0] = 1; _dmU[1] = (1023 + k) << 20; _dmU[0] = 0;
  return r * _dmF[0];
}
const PIO2_HI = 1.5707963267341256, PIO2_LO = 6.077100506506192e-11;
const _S1=-1.66666666666666324348e-01, _S2=8.33333333332248946124e-03,
      _S3=-1.98412698298579493134e-04, _S4=2.75573137070700676789e-06,
      _S5=-2.50507602534068634195e-08, _S6=1.58969099521155010221e-10;
const _C1=4.16666666666666019037e-02, _C2=-1.38888888888741095749e-03,
      _C3=2.48015872894767294178e-05, _C4=-2.75573143513906633035e-07,
      _C5=2.08757232129817482790e-09, _C6=-1.13596475577881948265e-11;
function _kSin(x){ const z=x*x, w=z*z, r=_S2+z*(_S3+z*_S4)+z*w*(_S5+z*_S6); return x+z*x*(_S1+z*r); }
function _kCos(x){ const z=x*x, w=z*z, r=z*(_C1+z*(_C2+z*_C3))+w*w*(_C4+z*(_C5+z*_C6)); return 1-(0.5*z-z*r); }
/* Cody-Waite: pi/2 as an exact high part plus a low correction, so subtracting
   n*pi/2 does not throw away the bits that decide the answer. */
function _quad(x){
  const n = Math.round(x * 0.6366197723675814);
  return [((n % 4) + 4) % 4, (x - n * PIO2_HI) - n * PIO2_LO];
}
function SIN(x){
  if (!Number.isFinite(x)) return NaN;
  const q = _quad(x), r = q[1];
  return q[0] === 0 ? _kSin(r) : q[0] === 1 ? _kCos(r) : q[0] === 2 ? -_kSin(r) : -_kCos(r);
}
function COS(x){
  if (!Number.isFinite(x)) return NaN;
  const q = _quad(x), r = q[1];
  return q[0] === 0 ? _kCos(r) : q[0] === 1 ? -_kSin(r) : q[0] === 2 ? -_kCos(r) : _kSin(r);
}
const _T0=3.33333333333329318027e-01, _T1=-1.99999999998764832476e-01,
      _T2=1.42857142725034663711e-01, _T3=-1.11111104054623557880e-01,
      _T4=9.09088713343650656196e-02, _T5=-7.69187620504482999495e-02,
      _T6=6.66107313738753120669e-02, _T7=-5.83357013379057348645e-02,
      _T8=4.97687799461593236017e-02, _T9=-3.65315727442169155270e-02,
      _T10=1.62858201153657823623e-02;
/* One polynomial across the whole range is not good enough near |x| = 1 — the
   first version of this was 3e-3 out there, which is not a last-bit difference,
   it is a different answer. The interval split with an exact hi/lo constant per
   interval brings every input back to about one ulp. */
const _ATHI = [4.63647609000806093515e-01, 7.85398163397448278999e-01,
               9.82793723247329054082e-01, 1.57079632679489655800e+00];
const _ATLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17,
               1.39033110312309984516e-17, 6.12323399573676603587e-17];
function _atPoly(x){
  const z=x*x, w=z*z;
  const s1 = z*(_T0+w*(_T2+w*(_T4+w*(_T6+w*(_T8+w*_T10)))));
  const s2 = w*(_T1+w*(_T3+w*(_T5+w*(_T7+w*_T9))));
  return x*(s1+s2);
}
function ATAN(x){
  if (!Number.isFinite(x)) return x !== x ? NaN : (x > 0 ? PI_2 : -PI_2);
  const neg = x < 0;
  let a = neg ? -x : x, id;
  if (a < 0.4375) id = -1;
  else if (a < 0.6875){ id = 0; a = (2*a - 1) / (2 + a); }
  else if (a < 1.1875){ id = 1; a = (a - 1) / (a + 1); }
  else if (a < 2.4375){ id = 2; a = (a - 1.5) / (1 + 1.5*a); }
  else { id = 3; a = -1 / a; }
  const p = _atPoly(a);
  const r = id < 0 ? a - p : _ATHI[id] - ((p - _ATLO[id]) - a);
  return neg ? -r : r;
}
function ATAN2(y, x){
  if (x === 0 && y === 0) return 0;
  if (x === 0) return y > 0 ? PI_2 : -PI_2;
  const a = ATAN(y / x);
  if (x > 0) return a;
  return y >= 0 ? a + PI : a - PI;
}
function HYPOT(x, y){
  x = x < 0 ? -x : x; y = y < 0 ? -y : y;
  if (x < y){ const t = x; x = y; y = t; }
  if (x === 0) return 0;
  const r = y / x;
  return x * Math.sqrt(1 + r*r);       // sqrt is exact on every engine
}
const _LN2HI = 6.93147180369123816490e-01, _LN2LO = 1.90821492927058770002e-10;
const _G1=6.666666666666735130e-01, _G2=3.999999999940941908e-01,
      _G3=2.857142874366239149e-01, _G4=2.222219843214978396e-01,
      _G5=1.818357216161805012e-01, _G6=1.531383769920937332e-01,
      _G7=1.479819860511658591e-01;
function LN(x){
  if (x <= 0) return x === 0 ? -Infinity : NaN;
  if (!Number.isFinite(x)) return x;
  _dmF[0] = x;
  let e = ((_dmU[1] >>> 20) & 0x7ff) - 1023;
  _dmU[1] = (_dmU[1] & 0x000fffff) | (1023 << 20);
  let m = _dmF[0];
  if (m > 1.4142135623730951){ m *= 0.5; e += 1; }
  const f = m - 1, s = f / (2 + f), z = s*s, w = z*z;
  const R = w*(_G2+w*(_G4+w*_G6)) + z*(_G1+w*(_G3+w*(_G5+w*_G7)));
  const hf = 0.5*f*f;
  return e*_LN2HI - ((hf - (s*(hf+R) + e*_LN2LO)) - f);
}
const _P1=1.66666666666666019037e-01, _P2=-2.77777777770155933842e-03,
      _P3=6.61375632143793436117e-05, _P4=-1.65339022054652515390e-06,
      _P5=4.13813679705723846039e-08;
function EXP(x){
  if (x !== x) return NaN;
  if (x > 709.78) return Infinity;
  if (x < -745.2) return 0;
  const k = Math.round(x * 1.4426950408889634);
  const xx = (x - k*_LN2HI) - k*_LN2LO, t = xx*xx;
  const c = xx - t*(_P1+t*(_P2+t*(_P3+t*(_P4+t*_P5))));
  return ldexp(1 + (xx*c/(2-c) + xx), k);
}
function POW(x, y){
  if (y === 0) return 1;
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x < 0) return NaN;
  return EXP(y * LN(x));
}

/* ---------------------------------------------------------- spells */
const SPELLS = [
  { key:"y", id:"spark", name:"Spark",    color:"#3fe7ff", cost:9,  weight:1, chargeW:1, speed:640, dmg:7,  radius:6,  cast:.07, maxChg:.75 },
  { key:"u", id:"rive",  name:"Rive",     color:"#a97cff", cost:12, weight:1, chargeW:4, speed:430, dmg:15, radius:9,  cast:.14, maxChg:1.0 },
  { key:"i", id:"hex",   name:"Hexstone", color:"#ff8f3a", cost:30, weight:3, chargeW:3, speed:270, dmg:24, radius:14, cast:.26, maxChg:1.4 },
  { key:"h", id:"ward",  name:"Ward",     color:"#5dffab", cost:20, weight:2, chargeW:3, speed:0,   dmg:0,  radius:0,  cast:.16, maxChg:1.1, absorb:20, chargeA:40 },
  { key:"j", id:"beam",  name:"Beam",     color:"#ff3f7a", cost:31, weight:9, chargeW:0, speed:0,   dmg:23, radius:0,  cast:1.0, maxChg:0 },
  { key:"k", id:"grasp", name:"Grasp",    color:"#ffd24a", cost:14, weight:3, chargeW:0, speed:520, dmg:22, radius:0,  cast:.2,  maxChg:0 }
];
const byId = {}; SPELLS.forEach(s => byId[s.id] = s);
// The ward is a wall held in front of the wizard: a cone a little wider than
// half the world, standing off the robe by WARD_R. Both numbers are read by the
// simulation and by the drawing code, so the wall you see is the wall that eats.
const WARD_COS = 0.2, WARD_R = 40;
// A ward is light cover, not a shield. It is rated for the two small spells and
// nothing else: a hexstone, a beam or a hurled crate goes through it and takes
// the wall with it. WARD_FADE is how long a full wall takes to bleed out on its
// own with nothing hitting it.
const WARD_BLOCKS = { spark:1, rive:1, swarm:1, needle:1 };
/* Is this a touch device? Declared HERE, at the top, rather than beside the rest
   of the pad code at the bottom: fitCurtain() and show() both consult it, both
   are defined hundreds of lines above the pad, and a `const` read before its
   declaration has run is a ReferenceError rather than undefined. Detection
   itself only needs `window`, so it costs nothing to settle early. */
const TOUCH = (() => {
  try {
    if (typeof window === "undefined" || !window.matchMedia || !window.navigator) return false;
    // An explicit choice always wins: detection is a guess, and a guess that
    // cannot be overridden is a bug report you can do nothing with. Handy for
    // testing the phone layout on a desktop, too.
    const q = String(window.location && window.location.search || "");
    if (/[?&]touch=1/.test(q)) return true;
    if (/[?&]touch=0/.test(q)) return false;
    return window.matchMedia("(pointer: coarse)").matches &&
           (window.navigator.maxTouchPoints || 0) > 0;
  } catch (e) { return false; }
})();

const KEYMAP = {"y":0,"u":1,"i":2,"h":3,"j":4,"k":5};
const KEYMAP2 = {"1":0,"2":1,"3":2,"4":3,"5":4,"6":5};   // player two, top row or numpad
// Input is sampled once per simulation step into a bit mask. Local play reads the
// keyboard; a networked match reads the same mask off the wire instead.
const BIT = { up:1, down:2, left:4, right:8, spell:16, dash:1024, tab:2048 };
function localMask(w){
  const C = w.pad;
  let m = 0;
  if (keyDown(C.up)) m |= BIT.up;
  if (keyDown(C.down)) m |= BIT.down;
  if (keyDown(C.left)) m |= BIT.left;
  if (keyDown(C.right)) m |= BIT.right;
  const km = w.seat === localSeat ? KEYMAP : KEYMAP2;
  for (const k in km) if (keyDown(k)) m |= BIT.spell << km[k];
  if (keyDown(C.dash)) m |= BIT.dash;
  if (C.tab && keyDown("tab")) m |= BIT.tab;
  return m;
}
function applyMask(w, m){
  const prev = w.prevMask || 0;
  const ax = ((m & BIT.right) ? 1 : 0) - ((m & BIT.left) ? 1 : 0);
  const ay = ((m & BIT.down) ? 1 : 0) - ((m & BIT.up) ? 1 : 0);
  for (let i = 0; i < 6; i++){
    const bit = BIT.spell << i;
    if ((m & bit) && !(prev & bit)) beginCharge(w, i);
    else if (!(m & bit) && (prev & bit)) releaseCharge(w, i);
  }
  if ((m & BIT.dash) && !(prev & BIT.dash)) tryDash(w, ax, ay);
  if ((m & BIT.tab) && !(prev & BIT.tab)) cycleTarget(w);
  w.prevMask = m;
  w.moveX = ax; w.moveY = ay;
}
function pumpInput(){
  for (const w of wizards){
    if (!w.human) continue;
    if (phase !== "fight" || w.dead){ w.prevMask = 0; w.moveX = 0; w.moveY = 0; continue; }
    applyMask(w, NET.active ? NET.maskFor(w.seat) : localMask(w));
  }
  // This step has now seen whatever was pressed since the last one. In a
  // networked match the masks come off the wire instead, and the latch is
  // cleared by RPW.localMask() when net.js samples the keyboard to send.
  if (!NET.active) clearTaps();
}

/* ---------------------------------------------------------- helpers */
// Two streams, and the wall between them is what makes netplay possible.
//
// rand() is the simulation's, seeded per round. Two machines fed the same seed
// and the same inputs must walk it in lockstep, so every draw from it has to
// happen in the simulation and nowhere else.
//
// vrand() is the view's, unseeded, for anything only the eye or the ear meets:
// particles, screen shake, wand flourishes, which sample of a sound to play.
// These MUST NOT come from rand(). draw() runs a variable number of times per
// simulation step depending on the machine, and reduced-motion is a per-user
// setting, so a cosmetic draw from the seeded stream pulls the two clients out
// of alignment and the worlds silently diverge. That bug shipped once and cost
// an afternoon; the split is the fix.
let rngState = 0x9e3779b9;
function seedRng(seed){ rngState = (seed >>> 0) || 1; }
function rand(){
  rngState |= 0; rngState = rngState + 0x6D2B79F5 | 0;
  let t = Math.imul(rngState ^ rngState >>> 15, 1 | rngState);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
seedRng((Date.now() ^ 0x5f3759df) >>> 0);
function vrand(){ return Math.random(); }
const STEP = 1/60;                       // the simulation only ever advances in these
const rnd  = (a,b) => a + rand()*(b-a);    // simulation
const vrnd = (a,b) => a + vrand()*(b-a);   // view only — never inside the sim
const clamp = (v,a,b) => v < a ? a : v > b ? b : v;
const dist2 = (a,b) => (a.x-b.x)*(a.x-b.x) + (a.y-b.y)*(a.y-b.y);
const dist = (a,b) => HYPOT(a.x-b.x, a.y-b.y);
const TAU = Math.PI*2;

function rayCircle(ox,oy,dx,dy,cx,cy,r){
  const fx = ox-cx, fy = oy-cy;
  const b = 2*(fx*dx + fy*dy);
  const c = fx*fx + fy*fy - r*r;
  const disc = b*b - 4*c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t1 = (-b - s)/2, t2 = (-b + s)/2;
  if (t1 > 0) return t1;
  if (t2 > 0) return t2;
  return -1;
}
function segCircle(ax,ay,bx,by,cx,cy,r){
  const dx = bx-ax, dy = by-ay;
  const len2 = dx*dx + dy*dy || 1;
  let t = ((cx-ax)*dx + (cy-ay)*dy)/len2;
  t = clamp(t,0,1);
  const px = ax + dx*t, py = ay + dy*t;
  return (px-cx)*(px-cx) + (py-cy)*(py-cy) <= r*r;
}

/* ---------------------------------------------------------- state */
let debris = [], shots = [], bits = [], rings = [], ghosts = [], floor = null;
// A strict, deterministic firing order. Every shot gets the next number when it
// is created, never reused, so "which of these two bolts was cast more
// recently" is a plain integer compare — no clock, no floating point, safe for
// lockstep. It rides alongside simFrame: same lifetime, same reset point.
let shotSeq = 0;
let shake = 0, msg = null, phase = "menu", phaseT = 0, clashPrev = false;
let hitStop = 0, flash = 0, flashColor = "#ffffff";
let clashes = [], clashNowFlag = false;
let simFrame = 0, matchSeed = 1;
// Replaced by src/net.js when a networked match is running. Offline it is inert.
const NET = {
  active: false,
  maskFor(){ return 0; },
  ready(){ return true; },
  onStep(){}
};
let difficulty = 1, roundNo = 1;
let mode = "duel";                 // "duel" | "escalation" | "match"
let p2 = null;
let runScore = 0, kills = 0, survT = 0;
let waveNo = 0, waveLive = false, waveGap = 0;
let bossAlerted = false;            // has this run's boss alert sounded yet (view-only: nothing in the simulation reads it)
let bossTest = false;            // the menu's "Boss test" run: escalation, starting at the boss
const TIER_TINT = ["#5dffab", "#4aa3ff", "#c58cff"];
const TINTS = ["#7ee9ff", "#ffd24a", "#ff9d6b", "#c58cff", "#5dffab", "#ff6b9d"];
let playerName = "Wizard";
const PAD1 = { up:"w", down:"s", left:"a", right:"d", dash:"shiftL", tab:true };
const PAD2 = { up:"arrowup", down:"arrowdown", left:"arrowleft", right:"arrowright", dash:"shiftR", tab:false };

/* Every wizard gets a stable id. Seats only number the party — wave rivals all
   shared seat 0, so nothing could name one of them: not a test, not a log line.
   The counter is reset per match and only ever incremented in makeWizard, so it
   is the same on every client. */
let nextWizId = 0;
function makeWizard(x,y,friendly){
  return {
    id: nextWizId++,
    x, y, vx:0, vy:0, r:15, friendly,
    team: friendly ? 0 : 1, human: false, D: null, target: null, pad: PAD1,
    name: "Wizard", tint: "#7ee9ff", wins: 0, seat: 0, lock: null, surge: 0,
    prevMask: 0, moveX: 0, moveY: 0,
    hp:100, hpMax:100, mana:100, facing:0,
    charge:null, chargeT:0, castLock:0, fizzle:0,
    ward:0, wardMax:0, wardFade:0, wardTick:0,
    seenX:null, seenY:null, seenT:9,   // last place this wizard saw its mark
    stuckT:0, stuckFor:0, lastPX:null, lastPY:null,   // "am I actually getting anywhere?"
    beamOn:false, beamWind:0, beamT:0,
    held:null, holdT:0,
    hurt:0, dead:false, lives: 3, spawnSafe: 0,
    // per-wizard match stats (deterministic — pure arithmetic on sim values)
    kills:0, deaths:0, dmg:0, counters:0, lastBy:null,
    // ai
    think:0, react:0, goal:null, strafe:1, panic:0, dodge:0, aiChargeTo:null, beamCool:0, wasBeam:false, beamReact:0, hitCool:0, beamBurn:0, dashT:0, dashCool:0, dashVX:0, dashVY:0,
    swish:0, swishDir:1, swishColor:"#fff", swishKind:"cast", swishT0:.19, beamSounding:false, beamCharging:false, clash:false, beamLen:0
  };
}
let wizards = [];
let you = makeWizard(140,H/2,true);
let foe = makeWizard(W-140,H/2,false);
you.human = true;
wizards = [you, foe];
function nearestEnemy(w){
  let best = null, bd = Infinity, any = null, ad = Infinity;
  for (const o of wizards){
    if (o.dead || o.team === w.team) continue;
    const d = dist2(w, o);
    if (d < ad){ ad = d; any = o; }
    if (perceives(w, o) && d < bd){ bd = d; best = o; }
  }
  // fall back to the nearest enemy at all, so nobody is ever left without a
  // target — but the aim code below will not track one it cannot see
  return best || any;
}
function livingOf(team){ return wizards.filter(o => !o.dead && o.team === team); }
function enemiesOf(w){ return wizards.filter(o => !o.dead && o.team !== w.team); }
function cycleTarget(w){
  const list = enemiesOf(w);
  if (!list.length) { w.lock = null; return; }
  const at = list.indexOf(w.lock);
  w.lock = list[(at + 1) % list.length];
  rings.push({ x:w.lock.x, y:w.lock.y, r:18, max:40, t:0, life:.3, color:w.tint, width:2 });
}

/* ---------------------------------------------------------- map */
// Everything scattered around the arena is one of these. The flags decide what
// it stops, whether you can walk through it, and whether Grasp can pick it up.
const PROPS = {
  stone:   { solid:1, stopsShot:1, stopsBeam:1, hp:Infinity, lift:0, r:[24,40], chip:"#6b6188" },
  pillar:  { solid:1, stopsShot:1, stopsBeam:1, hp:Infinity, lift:0, r:[14,20], chip:"#7d7396" },
  lattice: { solid:1, stopsShot:0, stopsBeam:1, hp:6,        lift:0, r:[22,34], chip:"#9a7f4e" },
  crate:   { solid:1, stopsShot:1, stopsBeam:1, hp:3,        lift:1, r:[17,23], chip:"#c9a06a" },
  barrel:  { solid:1, stopsShot:1, stopsBeam:1, hp:2,        lift:1, r:[15,20], chip:"#b0824e" },
  table:   { solid:1, stopsShot:1, stopsBeam:1, hp:4,        lift:0, r:[24,32], chip:"#a9825a" },
  shelf:   { solid:1, stopsShot:1, stopsBeam:1, hp:5,        lift:0, r:[26,36], chip:"#8f6b45" },
  urn:     { solid:1, stopsShot:1, stopsBeam:0, hp:1,        lift:1, r:[11,15], chip:"#9fb6c9" },
  chair:   { solid:0, stopsShot:0, stopsBeam:0, hp:1,        lift:1, r:[11,14], chip:"#c09566" },
  stool:   { solid:0, stopsShot:0, stopsBeam:0, hp:1,        lift:1, r:[9,12],  chip:"#c09566" },

  /* Scenery for the two themed maps. Deliberately NOT added to SPAWN below —
     the random scatter keeps exactly the props it always had, so every existing
     map generates identically and the behaviour fingerprint does not move.

     Each one earns its place by playing differently, not just by looking
     different: a tree is cover you cannot break, a bush hides you without
     stopping a shot, a log is a heavy thing to throw, a brazier is a barrel
     that lights the room. */
  // forest
  tree:    { solid:1, stopsShot:1, stopsBeam:1, hp:Infinity, lift:0, r:[26,34], chip:"#4a6b3a" },
  bush:    { solid:0, stopsShot:0, stopsBeam:1, hp:3,        lift:0, r:[20,27], chip:"#5f8a46" },
  log:     { solid:1, stopsShot:1, stopsBeam:1, hp:4,        lift:1, r:[18,24], chip:"#7a5a38" },
  stump:   { solid:1, stopsShot:1, stopsBeam:1, hp:6,        lift:0, r:[14,19], chip:"#6b523a" },
  // castle
  statue:  { solid:1, stopsShot:1, stopsBeam:1, hp:Infinity, lift:0, r:[18,24], chip:"#8e93b8" },
  brazier: { solid:1, stopsShot:1, stopsBeam:0, hp:2,        lift:0, r:[13,17], chip:"#ffb457" },
  chest:   { solid:1, stopsShot:1, stopsBeam:1, hp:3,        lift:1, r:[16,21], chip:"#c8a24e" },
  rubble:  { solid:0, stopsShot:0, stopsBeam:0, hp:2,        lift:1, r:[11,15], chip:"#7c7490" }
};
const SPAWN = [["stone",.15],["pillar",.09],["lattice",.09],["crate",.15],["barrel",.11],
               ["table",.08],["shelf",.06],["urn",.10],["chair",.11],["stool",.08]];
function pickProp(){
  let r = rand(), acc = 0;
  for (const [t, p] of SPAWN){ acc += p; if (r <= acc) return t; }
  return "crate";
}
function makeProp(type, x, y){
  const P = PROPS[type];
  return { type, x, y, r: rnd(P.r[0], P.r[1]), hp: P.hp, chip: P.chip,
           solid: P.solid, stopsShot: P.stopsShot, stopsBeam: P.stopsBeam,
           lift: P.lift,
           vx:0, vy:0, thrown:0, owner:null,
           seed: rand()*TAU, spin: rnd(-.4,.4), a: rnd(0,TAU),
           tint: rnd(-.12,.12) };
}
function makeMap(){
  debris = [];
  const s = mapScale();
  // The chosen arena, in EVERY mode. This used to be gated on NET.active, which
  // meant picking Forest or Castle did nothing unless a stranger had actually
  // joined your room — the picker looked broken because it was. matchCfg is now
  // set explicitly at the start of every match (solo picker, host options, or
  // the relay's start message), so there is no stale preset left to leak.
  const preset = MAP_PRESETS[matchCfg.mapPreset] || null;
  if (preset){
    // a fixed layout — identical on every machine, no RNG touched
    for (const [type, fx, fy] of preset){
      const d = makeProp(type, W*fx, H*fy);
      debris.push(d);
    }
    bakeFloor();
    buildNav();
    return;
  }
  const spawnA = {x:140,y:H/2}, spawnB = {x:W-140,y:H/2};
  const count = 11 + Math.floor(rand()*7);
  let guard = 0;
  // Scale a random placement in around the arena centre. These each take ONE
  // argument: py was written (a,b) but reads b, so every call — all of which
  // pass a single value — made b undefined and every prop's y NaN. Props with a
  // NaN coordinate simply do not draw, which is why the random scatter vanished
  // from every mode that uses it (solo AND a multiplayer Random map).
  const px = a => W/2 + (a - W/2)*s, py = b => H/2 + (b - H/2)*s;
  while (debris.length < count && guard++ < 1400){
    const d = makeProp(pickProp(), px(rnd(90, W-90)), py(rnd(70, H-70)));
    if (dist(d,spawnA) < 120 || dist(d,spawnB) < 120) continue;
    const pad = d.solid ? 26 : 12;
    let ok = true;
    for (const o of debris) if (dist(d,o) < d.r + o.r + pad) { ok = false; break; }
    if (ok) debris.push(d);
  }
  // every arena owes you something to throw and something to hide behind
  let lifts = debris.filter(d => d.lift).length;
  while (lifts < 3 && guard++ < 2000){
    const d = makeProp(rand() < .5 ? "crate" : "barrel", px(rnd(W*.28, W*.72)), py(rnd(70, H-70)));
    if (debris.every(o => dist(d,o) > d.r + o.r + 24)){ debris.push(d); lifts++; }
  }
  let walls = debris.filter(d => d.stopsBeam).length;
  while (walls < 4 && guard++ < 2600){
    const d = makeProp(rand() < .6 ? "stone" : "pillar", px(rnd(W*.2, W*.8)), py(rnd(70, H-70)));
    if (dist(d,spawnA) > 120 && dist(d,spawnB) > 120 &&
        debris.every(o => dist(d,o) > d.r + o.r + 26)){ debris.push(d); walls++; }
  }
  bakeFloor();
  buildNav();
}

/* ------------------------------------------------- getting around
 * Bots used to walk straight at wherever they wanted to be, which is fine in the
 * open and useless the moment a crate is in the way — they would grind into it,
 * slide along it, and end up jittering in a corner making no progress at all.
 * So the arena carries a coarse grid of walkable cells and they follow a route
 * through it instead. Breadth-first over ~400 cells: cheap, and pure geometry,
 * so every client computes the same route and lockstep holds.
 */
const NAV = 40;                                  // cell size in pixels
let navW = 0, navH = 0, navBlocked = null;
function buildNav(){
  navW = Math.ceil(W / NAV); navH = Math.ceil(H / NAV);
  navBlocked = new Uint8Array(navW * navH);
  for (let cy = 0; cy < navH; cy++){
    for (let cx = 0; cx < navW; cx++){
      const px = cx*NAV + NAV/2, py = cy*NAV + NAV/2;
      let blocked = px < 30 || py < 30 || px > W-30 || py > H-30;
      if (!blocked){
        for (const d of debris){
          if (d.gone || d.owner || !d.solid) continue;
          // a wizard needs its own width of room, not just the cell centre
          if (dist2({x:px,y:py}, d) < (d.r + 20) * (d.r + 20)){ blocked = true; break; }
        }
      }
      navBlocked[cy*navW + cx] = blocked ? 1 : 0;
    }
  }
}
const navCX = x => clamp(Math.floor(x / NAV), 0, navW - 1);
const navCY = y => clamp(Math.floor(y / NAV), 0, navH - 1);
function navFree(cx, cy){
  return cx >= 0 && cy >= 0 && cx < navW && cy < navH && !navBlocked[cy*navW + cx];
}
// Nearest walkable cell to a point, so a goal that lands inside a crate still
// gives the search somewhere to aim at.
function navNear(x, y){
  const cx = navCX(x), cy = navCY(y);
  if (navFree(cx, cy)) return cy*navW + cx;
  for (let r = 1; r <= 4; r++){
    for (let dy = -r; dy <= r; dy++){
      for (let dx = -r; dx <= r; dx++){
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (navFree(cx+dx, cy+dy)) return (cy+dy)*navW + (cx+dx);
      }
    }
  }
  return -1;
}
// Breadth-first from the goal outwards, then read the route back from the start.
// Returns the next corner to walk to, or null if there is no way through.
const NAV_STEPS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
function navNext(fromX, fromY, toX, toY){
  if (!navBlocked) return null;
  const start = navNear(fromX, fromY), goal = navNear(toX, toY);
  if (start < 0 || goal < 0) return null;
  if (start === goal) return { x: toX, y: toY };
  const prev = new Int32Array(navW * navH).fill(-1);
  const queue = new Int32Array(navW * navH);
  let head = 0, tail = 0;
  queue[tail++] = goal; prev[goal] = goal;
  let found = false;
  while (head < tail){
    const cur = queue[head++];
    if (cur === start){ found = true; break; }
    const cx = cur % navW, cy = (cur / navW) | 0;
    for (let i = 0; i < NAV_STEPS.length; i++){
      const dx = NAV_STEPS[i][0], dy = NAV_STEPS[i][1];
      const nx = cx + dx, ny = cy + dy;
      if (!navFree(nx, ny)) continue;
      // no cutting a diagonal through the gap between two blocked cells
      if (dx && dy && (!navFree(cx + dx, cy) || !navFree(cx, cy + dy))) continue;
      const ni = ny*navW + nx;
      if (prev[ni] !== -1) continue;
      prev[ni] = cur;
      queue[tail++] = ni;
    }
  }
  if (!found) return null;
  const step = prev[start];
  if (step < 0 || step === start) return { x: toX, y: toY };
  return { x: (step % navW)*NAV + NAV/2, y: ((step / navW) | 0)*NAV + NAV/2 };
}

// A free cell well away from here — what a bot heads for when it has been
// scraping the same wall for two seconds and getting nowhere.
function navPickOpen(w){
  for (let tries = 0; tries < 24; tries++){
    const cx = (rand()*navW)|0, cy = (rand()*navH)|0;
    if (!navFree(cx, cy)) continue;
    const x = cx*NAV + NAV/2, y = cy*NAV + NAV/2;
    if (dist2(w, {x, y}) < 200*200) continue;
    return { x, y };
  }
  return null;
}

function bakeFloor(){
  const f = document.createElement("canvas");
  f.width = W; f.height = H;
  const g = f.getContext("2d");
  /* The ground each map stands on.

     Every mark here is decoration, so it is drawn from vrand() — the view's
     unseeded stream — and never from rand(). The floor is baked once per round
     and two clients disagreeing about where a tuft of grass sits costs nothing,
     whereas a decorative draw from the SEEDED stream shifts every roll that
     follows it and silently desyncs a networked match. */
  const theme = matchCfg.mapPreset || "random";
  if (theme === "forest"){
    g.fillStyle = "#101c14"; g.fillRect(0,0,W,H);
    // earth, mottled in patches rather than tiled in squares
    for (let i = 0; i < 150; i++){
      const x = vrnd(0,W), y = vrnd(0,H), r = vrnd(18,62);
      g.fillStyle = `rgba(${(38+vrand()*22)|0},${(74+vrand()*30)|0},${(44+vrand()*18)|0},0.045)`;
      g.beginPath(); g.arc(x,y,r,0,TAU); g.fill();
    }
    // roots creeping across the floor
    g.strokeStyle = "rgba(74,54,34,.40)";
    for (let i = 0; i < 26; i++){
      const x = vrnd(0,W), y = vrnd(0,H), a = vrnd(0,TAU), L = vrnd(40,150);
      g.lineWidth = vrnd(1,3);
      g.beginPath(); g.moveTo(x,y);
      g.quadraticCurveTo(x + COS(a)*L*.5 + vrnd(-30,30), y + SIN(a)*L*.5 + vrnd(-30,30),
                         x + COS(a)*L, y + SIN(a)*L);
      g.stroke();
    }
    // tufts of grass
    g.strokeStyle = "rgba(112,170,92,.38)"; g.lineWidth = 1.2;
    for (let i = 0; i < 220; i++){
      const x = vrnd(0,W), y = vrnd(0,H), h = vrnd(3,8);
      g.beginPath(); g.moveTo(x,y); g.lineTo(x + vrnd(-2,2), y - h); g.stroke();
    }
  } else if (theme === "castle"){
    g.fillStyle = "#0f0d16"; g.fillRect(0,0,W,H);
    // big flagstones with mortar between them
    const F = 80;
    for (let y = 0; y < H; y += F){
      for (let x = 0; x < W; x += F){
        g.fillStyle = `rgba(255,255,255,${0.010 + vrand()*0.016})`;
        g.fillRect(x+2, y+2, F-4, F-4);
        g.strokeStyle = "rgba(0,0,0,.28)"; g.lineWidth = 1;
        g.strokeRect(x+2.5, y+2.5, F-5, F-5);
      }
    }
    // a runner up the middle of the hall
    g.fillStyle = "rgba(96,26,44,.20)";
    g.fillRect(W*0.5 - 66, 0, 132, H);
    g.strokeStyle = "rgba(200,162,78,.30)"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(W*0.5-58, 0); g.lineTo(W*0.5-58, H);
    g.moveTo(W*0.5+58, 0); g.lineTo(W*0.5+58, H); g.stroke();
    // torchlight pooling down the walls
    for (const [tx,ty] of [[70,H*0.22],[70,H*0.78],[W-70,H*0.22],[W-70,H*0.78]]){
      const grd = g.createRadialGradient(tx,ty,0,tx,ty,150);
      grd.addColorStop(0,"rgba(255,168,72,.10)");
      grd.addColorStop(1,"rgba(255,168,72,0)");
      g.fillStyle = grd; g.beginPath(); g.arc(tx,ty,150,0,TAU); g.fill();
    }
  } else {
    g.fillStyle = "#0c0918"; g.fillRect(0,0,W,H);
    // flagstones
    for (let y = 0; y < H; y += 40){
      for (let x = 0; x < W; x += 40){
        g.fillStyle = `rgba(255,255,255,${0.006 + rand()*0.012})`;
        g.fillRect(x+1, y+1, 38, 38);
      }
    }
  }
  // duelling circle
  g.save();
  g.translate(W/2, H/2);
  const ring = theme === "forest" ? ["rgba(120,190,110,.16)", "rgba(190,225,150,.10)"]
             : theme === "castle" ? ["rgba(214,176,96,.16)", "rgba(255,196,120,.10)"]
             : ["rgba(169,124,255,.14)", "rgba(63,231,255,.10)"];
  g.strokeStyle = ring[0];
  g.lineWidth = 1.4;
  g.beginPath(); g.arc(0,0,190,0,TAU); g.stroke();
  g.beginPath(); g.arc(0,0,168,0,TAU); g.stroke();
  g.strokeStyle = ring[1];
  for (let i = 0; i < 12; i++){
    const a = i/12*TAU;
    g.beginPath();
    g.moveTo(COS(a)*168, SIN(a)*168);
    g.lineTo(COS(a)*190, SIN(a)*190);
    g.stroke();
  }
  g.restore();
  // scorch marks
  for (let i = 0; i < 26; i++){
    const x = rnd(30,W-30), y = rnd(30,H-30), r = rnd(8,40);
    const grd = g.createRadialGradient(x,y,0,x,y,r);
    grd.addColorStop(0,"rgba(0,0,0,.35)");
    grd.addColorStop(1,"rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.beginPath(); g.arc(x,y,r,0,TAU); g.fill();
  }
  /* Unbreakable scenery is painted into the floor and never drawn again.

     A stone, a pillar, a tree, a statue: infinite hit points, never picked up,
     never moved. Redrawing them sixty times a second is pure waste, and in a
     lockstep match waste on ONE machine stalls everybody, because the others
     cannot advance until its inputs arrive. So they are baked here and skipped
     in the draw loop — the themed maps carry more scenery than the old ones and
     still cost less per frame. */
  const ctxWas = ctx;
  ctx = g;
  for (const d of debris) if (bakedProp(d)) drawDebris(d);
  ctx = ctxWas;

  floor = f;
}
// A prop is baked only if nothing can ever change about it.
function bakedProp(d){
  return d.hp === Infinity && !d.lift && !d.owner;
}

/* ---------------------------------------------------------- input */
/* keys[] is what is physically down right now. tapped[] is what has been
   pressed since the simulation last looked, and it is the difference between a
   game that feels sharp and one that eats your inputs.

   The simulation samples the keyboard once per fixed step, and steps only run
   when a frame runs. A press and release that both land between two frames used
   to be invisible: keys[k] went true and back to false with nothing sampling in
   between, so the spell never cast and the step never happened. At sixty frames
   a second that window is 16ms and you would rarely notice; in a busy six-wizard
   fight the window is several times that, which is an ordinary quick tap.

   So a press latches. The next step to run sees the key as held even if the
   finger is already off it, and the latch is cleared once that step has taken
   it — one press, one step, never dropped and never repeated. */
const keys = {};
const tapped = {};
const held = {};   // spell index -> true while key down
function keyDown(k){ return !!(keys[k] || tapped[k]); }
function clearTaps(){ for (const k in tapped) if (tapped[k]) tapped[k] = false; }
function typing(e){
  const t = e.target;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
}
window.addEventListener("keydown", e => {
  if (typing(e)) return;
  const k = e.key.toLowerCase();
  const code = e.code || "";
  if (k === "shift") keys[code === "ShiftRight" ? "shiftR" : "shiftL"] = true;
  if (["w","a","s","d","y","u","i","h","j","k","p","r","shift"," ",
       "1","2","3","4","5","6","tab","arrowup","arrowdown","arrowleft","arrowright"].includes(k)) e.preventDefault();
  if (keys[k]) return;              // an auto-repeat, not a new press
  keys[k] = true;
  tapped[k] = true;                 // hold it for the simulation even if released first
  if (k === "p" && (phase === "fight" || phase === "paused")) togglePause();
  if (k === "r" && phase !== "menu") { newMatch(); }   // same arena, fresh round
});
window.addEventListener("keyup", e => {
  if (typing(e)) return;
  const k = e.key.toLowerCase();
  keys[k] = false;
  if (k === "shift") keys[(e.code || "") === "ShiftRight" ? "shiftR" : "shiftL"] = false;
});
window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; clearTaps(); if (phase === "fight" && !NET.active) togglePause(); });

/* ---------------------------------------------------------- casting */
function beginCharge(w, idx){
  if (w.dead || w.castLock > 0) return;
  const s = SPELLS[idx];
  if (s.id === "beam"){
    if (w.mana < 34 || w.beamBurn > 0) { w.fizzle = .3; return; }
    w.mana -= 18;                       // ignition: you pay to open the channel
    w.beamOn = true; w.beamWind = 0; w.charge = null;
    return;
  }
  if (s.id === "grasp"){
    if (w.held) return;
    if (w.mana < s.cost) { w.fizzle = .3; return; }
    const target = liftable(w);
    if (!target) { w.fizzle = .3; return; }
    w.mana -= s.cost;
    w.held = target; target.owner = w; target.vx = target.vy = 0;
    w.holdT = 0;
    return;
  }
  if (w.charge !== null) return;
  w.charge = idx; w.chargeT = 0;
}
function liftable(w){
  let best = null, bd = 210*210;
  for (const d of debris){
    if (d.gone || !d.lift || d.owner) continue;
    const dd = dist2(w,d);
    if (dd < bd) { bd = dd; best = d; }
  }
  return best;
}
function releaseCharge(w, idx){
  const s = SPELLS[idx];
  if (s.id === "beam"){ stopBeam(w); return; }
  if (s.id === "grasp"){ if (w.held) throwHeld(w); return; }
  if (w.charge !== idx) return;
  const lvl = s.maxChg ? clamp(w.chargeT / s.maxChg, 0, 1) : 0;
  cast(w, idx, lvl);
  w.charge = null; w.chargeT = 0;
}
function cast(w, idx, lvl, ox, oy, aim){
  const s = SPELLS[idx];
  let need = s.cost * (1 + lvl);
  if (w.mana < s.cost * .95){ w.fizzle = .35; puff(w.x,w.y,"#6b6188",6); return; }
  if (w.mana < need) lvl = clamp(w.mana/s.cost - 1, 0, 1), need = s.cost*(1+lvl);
  w.mana -= need;
  w.castLock = s.cast;

  if (s.id === "ward"){
    // How long you held the key is how much punishment the wall can eat. It is
    // a bank of damage now, not a single block, and anything at all draws on it.
    w.wardMax = s.absorb + s.chargeA * lvl;
    w.ward = w.wardMax;
    w.wardTick = 0;
    // it does not stand for a while and then vanish — it thins the whole time,
    // so a wall you raised early is already half gone when the shot arrives
    w.wardFade = w.wardMax / (2.4 + lvl*1.4);
    swish(w, s.color, "cast");
    castSound(w, "ward");
    puff(w.x,w.y,s.color,10);
    return;
  }
  const a = aim != null ? aim : w.facing;
  const fromTip = ox != null;
  if (s.id === "rive"){
    // a fan of light missiles: each one only carries weight 1, but there are
    // more of them the longer you hold, and they weave in on their own.
    const n = s.weight + Math.round(s.chargeW * lvl);
    const arc = 0.11 + 0.05*(n-1);
    for (let i = 0; i < n; i++){
      const off = n === 1 ? 0 : (i/(n-1) - .5) * arc * 2;
      const ang = a + off + rnd(-.02,.02);
      const sp = s.speed * rnd(.9,1.1);
      shots.push({
        x: (fromTip ? ox : w.x + COS(a)*20) - SIN(a)*off*46,
        y: (fromTip ? oy : w.y + SIN(a)*20) + COS(a)*off*46,
        vx: COS(ang)*sp, vy: SIN(ang)*sp,
        weight: 1, w0: 1,
        dmg: 9 * (1 + lvl*0.35) * dmgMul(w),
        r: 6.5,
        color: s.color, kind: s.id, owner: w, life: 3.4, trail: [], spin: 0,
        seek: { turn: .6, wob: .85, vMin: sp, vMax: sp, phase: rand()*TAU },
        glow: 16, lvl, seq: shotSeq++
      });
    }
    swish(w, s.color, "cast");
    castSound(w, "rive");
    shake = Math.min(shake + (REDUCED ? 0 : n*0.35), 9);
    return;
  }
  const weight = s.weight + Math.round(s.chargeW * lvl);
  let speed = s.speed * (1 - lvl*0.18);
  let seek = null, hexR = 0;
  if (s.id === "hex"){
    // heavy stone: leaves the wand slowly, then winds up as it closes on its mark.
    // full charge tracks hard; a tapped stone barely steers and never gets fast.
    speed = 115 + 75*lvl;
    hexR = 6 + 15*lvl + weight*0.6;
    seek = {
      turn: 0.18 + 2.35*POW(lvl, 1.8),
      wob:  (1 - lvl) * 1.35,
      vMin: speed,
      vMax: 265 + 355*lvl,
      phase: rand()*TAU
    };
  }
  shots.push({
    x: fromTip ? ox : w.x + COS(a)*22, y: fromTip ? oy : w.y + SIN(a)*22,
    vx: COS(a)*speed, vy: SIN(a)*speed,
    weight, w0: weight,
    dmg: s.dmg * (1 + lvl*0.9) * dmgMul(w),
    r: hexR || (s.radius + weight*1.6),
    glow: s.id === "hex" ? 8 + 30*lvl : 22,
    color: s.color, kind: s.id, owner: w, life: seek ? 5.2 : 4, trail: [], spin: 0,
    seek, lvl, seq: shotSeq++
  });
  swish(w, s.color, "cast");
  castSound(w, s.id);
  shake = Math.min(shake + (REDUCED ? 0 : weight*0.55), 9);
}
function throwHeld(w){
  const d = w.held; if (!d) return;
  const a = w.facing;
  d.owner = null; d.thrown = 1.6;
  d.vx = COS(a)*520; d.vy = SIN(a)*520;
  d.thrower = w;
  w.held = null;
  swish(w, byId.grasp.color, "cast");
  shake = Math.min(shake + (REDUCED?0:4), 9);
}

const DASH_CD = 3;
function tryDash(w, ax, ay){
  if (w.dead || w.dashCool > 0 || w.dashT > 0 || w.beamOn) return false;
  let dx = ax, dy = ay;
  if (HYPOT(dx, dy) < .01){ dx = COS(w.facing); dy = SIN(w.facing); }
  const L = HYPOT(dx, dy) || 1;
  w.dashT = .17; w.dashCool = DASH_CD;
  w.dashVX = dx/L * 880; w.dashVY = dy/L * 880;
  const tint = w.tint;
  dashSound(w);
  rings.push({ x:w.x, y:w.y, r:6, max:44, t:0, life:.32, color:tint, width:2.2 });
  puff(w.x, w.y, tint, 10);
  return true;
}

/* ---------------------------------------------------------- movement */
function moveWizard(w, ax, ay, dt){
  if (w.dashT > 0){
    w.vx = w.dashVX; w.vy = w.dashVY;
    w.x += w.vx*dt; w.y += w.vy*dt;
    w.x = clamp(w.x, 22, W-22); w.y = clamp(w.y, 22, H-22);
    for (const d of debris){
      if (d.owner || !d.solid) continue;
      const dd = dist(w,d), min = w.r + d.r;
      if (dd < min && dd > 0.001){
        const nx = (w.x-d.x)/dd, ny = (w.y-d.y)/dd;
        w.x = d.x + nx*min; w.y = d.y + ny*min;
        w.dashT = 0;                       // you do not dash through furniture
      }
    }
    if (!REDUCED) ghosts.push({ x:w.x, y:w.y, facing:w.facing, friendly:w.friendly, tint:w.tint, t:0, life:.26, sc: w.boss ? 2.6 : 1 });
    return;
  }
  const beamSlow = (w.beamOn && w.beamWind >= byId.beam.cast) ? .35 : 1;
  const chargeSlow = w.charge !== null ? .55 : 1;
  const holdSlow = w.held ? .82 : 1;
  const spd = 190 * beamSlow * chargeSlow * holdSlow * (w.speedMul || 1);
  const m = HYPOT(ax,ay) || 1;
  const tx = (ax/m)*spd*(HYPOT(ax,ay) > .01 ? 1 : 0);
  const ty = (ay/m)*spd*(HYPOT(ax,ay) > .01 ? 1 : 0);
  w.vx += (tx - w.vx) * Math.min(1, dt*12);
  w.vy += (ty - w.vy) * Math.min(1, dt*12);
  w.x += w.vx*dt; w.y += w.vy*dt;
  w.x = clamp(w.x, 22, W-22); w.y = clamp(w.y, 22, H-22);
  for (const d of debris){
    if (d.gone || d.owner || !d.solid) continue;
    const dd = dist(w,d), min = w.r + d.r;
    if (dd < min && dd > 0.001){
      const nx = (w.x-d.x)/dd, ny = (w.y-d.y)/dd;
      w.x = d.x + nx*min; w.y = d.y + ny*min;
      w.vx *= .5; w.vy *= .5;
    }
  }
}

/* ---------------------------------------------------------- beams */
function blocksBeam(d){ return !d.owner && d.stopsBeam; }
function launchOrb(w, x, y){
  const a = w.facing;
  shots.push({
    x, y, vx: COS(a)*400, vy: SIN(a)*400,
    weight: 9, w0: 9, dmg: 42 * dmgMul(w), r: 17,
    color: byId.beam.color, kind: "orb", owner: w, life: 2.4, trail: [], spin: 0,
    seek: null, glow: 44, lvl: 1, orb: true, seq: shotSeq++
  });
  impact(x, y, 3, byId.beam.color);
}
function explodeOrb(s){
  impact(s.x, s.y, 7, byId.beam.color);
  puff(s.x, s.y, byId.beam.color, 30);
  puff(s.x, s.y, "#ffffff", 14);
  rings.push({ x:s.x, y:s.y, r:10, max:110, t:0, life:.5, color:byId.beam.color, width:3 });
  for (const q of wizards){
    if (q.dead || q === s.owner) continue;
    const d = dist(q, s);
    if (d < 84) hurt(q, 26 * (1 - d/84) * dmgMul(s.owner), s.owner);
  }
  for (const d of debris){
    if (d.gone || d.owner || d.hp === Infinity) continue;
    if (dist(d, s) < 74){ d.hp -= 4; if (d.hp <= 0) breakProp(d); }
  }
}
function beamReach(w, other){
  const dx = COS(w.facing), dy = SIN(w.facing);
  let best = 1400;
  // walls
  if (dx > 0.001) best = Math.min(best, (W-4 - w.x)/dx);
  if (dx < -0.001) best = Math.min(best, (4 - w.x)/dx);
  if (dy > 0.001) best = Math.min(best, (H-4 - w.y)/dy);
  if (dy < -0.001) best = Math.min(best, (4 - w.y)/dy);
  for (const d of debris){
    if (d.gone || !blocksBeam(d)) continue;
    const t = rayCircle(w.x + dx*20, w.y + dy*20, dx, dy, d.x, d.y, d.r);
    if (t > 0 && t + 20 < best) best = t + 20;
  }
  return best;
}
// Closing the channel costs you too: a moment unable to cast and a scorched wand.
function stopBeam(w, quiet){
  // aborting during the wind-up only costs you the ignition; letting go of a
  // beam that actually fired leaves the wand scorched
  const wasFiring = w.beamOn && w.beamWind >= byId.beam.cast;
  w.beamOn = false; w.beamWind = 0; w.beamT = 0;
  if (wasFiring && !quiet){
    w.beamBurn = 1.2;
    w.castLock = Math.max(w.castLock, .6);
    puff(w.x + COS(w.facing)*22, w.y + SIN(w.facing)*22, "#6b6188", 10);
  }
}
function dmgMul(w){ return w && w.D && w.D.dmg ? w.D.dmg : 1; }
function beamPower(w){
  if (w.boss && w.beamTint) return 40;    // the Prism Lance does not haggle over the orb: it simply overwhelms
  return 0.22 + (w.mana/100)*1.15 + Math.min(w.beamT, 3)*0.04;
}

/* ---------------------------------------------------------- AI */
// Escalation has no tiers - the rival simply keeps getting better, and then
// keeps getting company.
// Escalation fields the same three wizards you can duel, in sets that grow:
// one of each, then pairs working up the tiers, then threes, and so on.
function waveComp(i){
  let idx = 0;
  for (let n = 1; n < 60; n++){
    const count = 2*n + 1;
    if (i < idx + count){
      const step = i - idx;
      const arr = new Array(n).fill(0);
      for (let s = 0; s < step; s++){
        let m = 0;
        for (let q = 1; q < n; q++) if (arr[q] < arr[m]) m = q;
        arr[m]++;
      }
      return arr;
    }
    idx += count;
  }
  return [2,2,2];
}
/* The wave a party of `party` wizards faces on set `i`. One wizard gets the
   solo ladder exactly as it always was — waveComp is untouched, so a solo run
   plays identically to before. Every extra ally adds rivals drawn from the
   tiers already in the set, so a bigger party meets a bigger set rather than a
   nastier one, and the total is capped so a six-stack cannot melt a slow
   machine.
   `afterBoss` holds that scaling off entirely: the whole first ladder, boss
   included, is a co-op party's introduction to the game, not a wall — it
   should play exactly like a solo run until the party has actually beaten the
   Alchemist once. Only sets reached after that first boss kill grow with the
   party. */
function waveFor(i, party, afterBoss){
  const base = waveComp(i);
  if (party <= 1 || !afterBoss) return base;
  const out = base.slice();
  const extra = Math.min(14 - base.length, Math.round((party - 1) * base.length * 0.8));
  for (let k = 0; k < extra; k++) out.push(base[k % base.length]);
  return out;
}
const DIFF = [
  { react:1.15,aim:.25, cover:.06, greed:.07, regen:0.34, miss:.88, dash:false, power:0, dmg:.5,  hp:74,  tier:"Easy",   name:"Apprentice" },
  { react:.52, aim:.62, cover:.36, greed:.48, regen:0.66, miss:.48, dash:true,  power:2, dmg:.66, hp:84,  tier:"Medium", name:"Adept" },
  { react:.13, aim:.97, cover:.90, greed:1.3, regen:1.12, miss:.02, dash:true,  power:3, dmg:1,   hp:100, tier:"Hard",   name:"Archmage" }
];

function incomingThreat(w, foeW){
  // `light` is the part of the incoming weight a ward could actually hold —
  // the bots need it to tell a rive fan (raise a wall) from a hexstone (move)
  let weight = 0, light = 0, soonest = 9;
  for (const s of shots){
    if (s.owner !== foeW) continue;
    if (!perceives(w, s)) continue;          // it has not come into sight yet
    const toX = w.x - s.x, toY = w.y - s.y;
    const d = HYPOT(toX,toY) || 1;
    const sp = HYPOT(s.vx,s.vy) || 1;
    const dot = (s.vx*toX + s.vy*toY)/(sp*d);
    if (dot < .86) continue;
    const t = d/sp;
    if (t > 1.6) continue;
    weight += s.weight;
    if (WARD_BLOCKS[s.kind]) light += s.weight;
    soonest = Math.min(soonest, t);
  }
  for (const d of debris){
    if (!d.thrown) continue;
    if (!perceives(w, d)) continue;
    const toX = w.x-d.x, toY = w.y-d.y;
    const dd = HYPOT(toX,toY)||1;
    const sp = HYPOT(d.vx,d.vy)||1;
    if ((d.vx*toX + d.vy*toY)/(sp*dd) > .85 && dd/sp < 1.3){ weight += 3; soonest = Math.min(soonest, dd/sp); }
  }
  return { weight, light, soonest };
}
function lineClear(a, b, forShots, pad = 2){
  for (const d of debris){
    if (d.owner) continue;
    if (forShots ? !d.stopsShot : !d.stopsBeam) continue;
    if (segCircle(a.x,a.y,b.x,b.y,d.x,d.y,d.r+pad)) return false;
  }
  return true;
}
// Fog of war: can `a` see `b`? LOS is a clear beam path plus a soft sight
// radius (scaled with the arena). Pure geometry — never touches RNG.
function canSee(a, b){
  if (!a || !b) return true;
  if (dist(a, b) > FOG_R * mapScale() + 30) return false;
  return lineClear(a, b, false);
}
// The one question everything asks before it is allowed to know something. With
// fog off nobody is blind and every behaviour is exactly what it always was;
// with it on this gates bots and humans alike — no tracking a wand through a
// wall, no reacting to a beam you cannot see. Pure geometry over synced config,
// so every client computes the same answer and lockstep holds.
function perceives(a, b){ return !matchCfg.fog || canSee(a, b); }
function nearestCover(w, from){
  let best = null, bs = -1e9;
  for (const d of debris){
    if (d.owner || !d.stopsShot || d.hp <= 1) continue;
    const ax = d.x - from.x, ay = d.y - from.y;
    const L = HYPOT(ax,ay) || 1;
    const spot = { x: d.x + (ax/L)*(d.r+24), y: d.y + (ay/L)*(d.r+24) };
    if (spot.x < 30 || spot.x > W-30 || spot.y < 30 || spot.y > H-30) continue;
    const score = d.r*1.4 - dist(w,spot)*0.5;
    if (score > bs){ bs = score; best = spot; }
  }
  return best;
}

function ownWeightToward(w, opp){
  let total = 0;
  for (const s of shots){
    if (s.owner !== w) continue;
    const toX = opp.x - s.x, toY = opp.y - s.y;
    const d = HYPOT(toX,toY) || 1;
    const sp = HYPOT(s.vx,s.vy) || 1;
    if ((s.vx*toX + s.vy*toY)/(sp*d) > .8 && d/sp < 1.5) total += s.weight;
  }
  return total;
}
function aiTick(w, opp, dt){
  const D = w.D || DIFF[difficulty];
  // A bot reasons about where it BELIEVES its mark is: the truth while it can see
  // them, the last place it saw them once it cannot. Every use of the opponent's
  // position below goes through bx/by, so a bot in fog hunts rather than cheats.
  const seen = perceives(w, opp);
  if (seen){ w.seenX = opp.x; w.seenY = opp.y; w.seenT = 0; }
  else w.seenT = Math.min(9, (w.seenT || 0) + dt);
  const bx = seen ? opp.x : (w.seenX != null ? w.seenX : opp.x);
  const by = seen ? opp.y : (w.seenY != null ? w.seenY : opp.y);
  const evade = () => {
    if (!D.dash || w.dashCool > 0) return;
    const dx = bx - w.x, dy = by - w.y, L = HYPOT(dx,dy) || 1;
    if (rand() < D.aim) tryDash(w, -dy/L * w.strafe, dx/L * w.strafe);
  };
  w.think -= dt;
  w.beamCool = Math.max(0, w.beamCool - dt);
  w.beamReact = Math.max(0, w.beamReact - dt);
  if (w.wasBeam && !w.beamOn) w.beamCool = rnd(.6, 1.5) * (1.8 - D.greed);
  w.wasBeam = w.beamOn;
  const threat = incomingThreat(w, opp);
  const los = lineClear(w, opp, false) && seen;
  const losShoot = lineClear(w, opp, true) && seen;
  const d = HYPOT(w.x - bx, w.y - by);

  // ---- reaction to threats
  w.react -= dt;
  w.dodge -= dt;
  // ---- a beam is a beam's problem: answer it, or get a wall in the way.
  // this reads the wind-up, not the finished beam, so there is time to do either.
  if (opp.beamOn && los && !w.beamOn && w.beamReact <= 0 && rand() >= D.miss*.6){
    w.beamReact = D.react * rnd(.5,.9);
    if (w.charge !== null){ w.charge = null; w.chargeT = 0; }   // whatever was charging matters less
    if ((D.power|0) >= 2 && w.mana > 26 && rand() < .5 + D.cover*.45){
      w.beamOn = true; w.beamWind = 0;
    } else {
      const spot = nearestCover(w, opp);
      if (spot){ w.goal = spot; w.panic = 1.4; }
      else { w.dodge = .8; w.strafe = rand() < .5 ? 1 : -1; evade(); }
    }
  }
  // losing the clash badly with no mana left to spend: break off rather than die holding it
  if (w.beamOn && w.clash && w.mana < 22 && w.mana < opp.mana * .6){
    stopBeam(w);
    const spot = nearestCover(w, opp);
    if (spot){ w.goal = spot; w.panic = 1.2; }
  }

  const answered = ownWeightToward(w, opp);
  const net = threat.weight - answered;
  if (net > 0 && w.react <= 0 && w.castLock <= 0 && w.charge === null && rand() >= D.miss){
    w.react = D.react * rnd(.85,1.25);
    const urgent = threat.soonest < .5;
    if (net >= 3 && w.mana >= 38 && !urgent && (D.power|0) >= 2 && rand() < D.cover){
      w.charge = 2; w.chargeT = 0;
      w.aiChargeTo = clamp((net-3)/3, 0, 1) * byId.hex.maxChg;
    } else if (net >= 3 && threat.light >= 3 && w.mana >= 24){
      // a wall is rated for spark and rive only — raising one into a hexstone
      // is just dying with the wand up
      cast(w, 3, clamp((net-2)/3, 0, 1));
    } else if (net >= 3 && threat.light < 3){
      w.dodge = .7; w.strafe = rand() < .5 ? 1 : -1; evade();
    } else if (net === 2 && w.mana >= 20){
      cast(w, 1, .55);
    } else if (net >= 1 && w.mana >= 12){
      cast(w, 0, net > 1 ? .6 : 0);
    } else if (w.mana < 14){
      w.dodge = .55; w.strafe = rand() < .5 ? 1 : -1; evade();
    }
    if (urgent && rand() < D.aim * .55){ w.dodge = .45; w.strafe *= -1; evade(); }
  }

  // ---- charging follow-through
  if (w.charge !== null){
    const s = SPELLS[w.charge];
    if (w.chargeT >= (w.aiChargeTo ?? s.maxChg*rnd(.3,1))){
      releaseCharge(w, w.charge);
      w.aiChargeTo = null;
    }
  }

  // ---- beam management
  if (w.beamOn){
    const oppBeaming = opp.beamOn && opp.beamWind >= byId.beam.cast;
    if (w.mana < 12 || (!los && w.beamWind < byId.beam.cast)) stopBeam(w);
    else if (!oppBeaming && !los) stopBeam(w);
    else if (!oppBeaming && !w.beamForced && bossMirrorThreat(opp) && opp.boss.refl) stopBeam(w);     // the glass is up: let go
  }

  // ---- offense
  const calm = threat.weight === 0 || threat.soonest > 0.5;
  if (w.think <= 0 && w.castLock <= 0 && w.charge === null && !w.beamOn && calm){
    w.think = rnd(.3,.85) / (0.35 + D.greed*0.9);
    if (losShoot && w.mana > 18){
      const roll = rand();
      if (w.held && rand() < .5) throwHeld(w);
      else if (roll < .10 && w.mana > 60 && los && w.beamCool <= 0 && (D.power|0) >= 2 && !bossMirrorThreat(opp)) { w.beamOn = true; }
      else if (roll < .28 && w.mana > 40 && los && (D.power|0) >= 2) { w.charge = 2; w.chargeT = 0; w.aiChargeTo = byId.hex.maxChg*rnd(.5,1); }
      else if (roll < .55) { w.charge = 1; w.chargeT = 0; w.aiChargeTo = byId.rive.maxChg*rnd(.1,.8); }
      else cast(w, 0, rand()*.4);
    } else if (!losShoot && rand() < .6){
      // sweep around where they were last seen — in fog this is a search, not a chase
      const spread = seen ? 260 : 150;
      w.goal = { x: clamp(bx + rnd(-spread,spread), 40, W-40),
                 y: clamp(by + rnd(-spread,spread), 40, H-40) };
    }
    if (!w.held && rand() < .16 * D.greed && liftable(w)) beginCharge(w, 5);
  }

  // ---- movement
  w.panic -= dt;
  // Getting nowhere? Sample the distance covered every half second; a bot that has
  // barely moved for a second and a half is stuck on something, so send it
  // somewhere else entirely rather than let it keep scraping the same crate.
  w.stuckT = (w.stuckT || 0) + dt;
  if (w.stuckT >= 0.5){
    const moved = HYPOT(w.x - (w.lastPX == null ? w.x : w.lastPX),
                             w.y - (w.lastPY == null ? w.y : w.lastPY));
    if (moved < 12){
      w.stuckFor = (w.stuckFor || 0) + w.stuckT;
      if (w.stuckFor > 1.5){
        const away = navPickOpen(w);
        if (away){ w.goal = away; w.panic = 1.6; }
        w.stuckFor = 0;
      }
    } else w.stuckFor = 0;
    w.lastPX = w.x; w.lastPY = w.y; w.stuckT = 0;
  }
  let ax = 0, ay = 0;
  const wantD = w.hp < 35 ? 380 : 300;
  // a long walk goes through the nav grid; the last few strides are direct
  const routeTo = (tx, ty) => {
    if (HYPOT(tx - w.x, ty - w.y) < 60) return [tx - w.x, ty - w.y];
    const wp = navNext(w.x, w.y, tx, ty);
    return wp ? [wp.x - w.x, wp.y - w.y] : [tx - w.x, ty - w.y];
  };
  if (w.panic > 0 && w.goal){
    [ax, ay] = routeTo(w.goal.x, w.goal.y);
    if (HYPOT(w.goal.x - w.x, w.goal.y - w.y) < 26) { w.panic = 0; w.goal = null; }
  } else if (w.goal && !losShoot){
    [ax, ay] = routeTo(w.goal.x, w.goal.y);
    if (HYPOT(w.goal.x - w.x, w.goal.y - w.y) < 30) w.goal = null;
  } else if (!seen && w.seenX != null && HYPOT(w.x - bx, w.y - by) > 90){
    // hunting: walk the route to where they were last seen instead of pressing
    // straight at it through whatever happens to be in between
    [ax, ay] = routeTo(bx, by);
  } else {
    const dx = (w.x-bx)/(d||1), dy = (w.y-by)/(d||1);
    const push = d < wantD - 60 ? 1 : d > wantD + 90 ? -1 : 0;
    ax = dx*push; ay = dy*push;
    const sideways = w.dodge > 0 ? 2.2 : 1.1;
    ax += -dy * w.strafe * sideways; ay += dx * w.strafe * sideways;
    if (rand() < dt*0.7) w.strafe *= -1;
  }
  // avoid walls
  if (w.x < 70) ax += 1; if (w.x > W-70) ax -= 1;
  if (w.y < 70) ay += 1; if (w.y > H-70) ay -= 1;
  if (w.charge !== null || (w.beamOn && w.beamWind >= byId.beam.cast)) { ax *= .25; ay *= .25; }
  moveWizard(w, ax, ay, dt);
}

/* ---------------------------------------------------------- the Alchemist
   The boss that stands at the end of wave 8. One wizard on the board — it is a
   real entry in `wizards`, on team 1, with a real hp bar, hurtbox and beam — but
   it wields FOUR wands and only ever has two of them out.

   Its hat is a reading wheel. A ring of six stones sits on the brim, one for each
   spell. Every so often the hat spins, the ring spins with it, and two stones
   settle at the two reading marks: those are the two spells it will use, one
   in each hand, for the next stretch of the fight. While the hat spins the arms
   reach behind its back, put the wands they were holding into their sheaths and
   draw the other pair. Each live wand then charges ITS spell, releases it from
   ITS tip, and reloads with the same one, until the hat spins again.

   Sometimes the two locked spells are a pair that can be fused. It does not always
   fuse them — but when it does, both wands come together, a large star flashes
   round it, and one new spell leaves instead of two.

   Everything in this block is simulation and obeys the simulation's rules: the
   seeded rand()/rnd() only, the deterministic COS/SIN/ATAN2, no clock. The
   drawing code (drawBossBody) reads this state but never writes it. */
const BOSS_AT = 8;                 // the wave whose clearing calls the boss
const BOSS_SCALE = .625;           // the design below is drawn at this fraction: an Alchemist is about the size of two and a half wizards
const BOSS_R = 20;
const BOSS_TINT = "#ff6b9d";
const BOSS_D = { react:.13, aim:.97, cover:.9, greed:1.3, regen:.9, miss:.02, dash:true, power:3,
                 dmg:.6, hp:235, tier:"Boss", name:"The Alchemist" };
/* The Alchemist runs on mana like anyone else. It has the same hundred-point pool
   you do and pays for every cast out of it; the bar under its health shows what is
   left. The prices are its own — a wand that fires all day is worth less than one
   that fires now and then — and a wand that cannot pay simply holds its spell at
   full charge until it can. When more than one wand has been waiting a while, the
   hat turns early and picks something it can afford. */
const BOSS_COST = [16, 24, 40, 24, 30, 14];        // by spell: a burst of sparks, a rive fan, a hexstone, a ward, opening the beam, a grasp
const BOSS_FUSED_COST = { swarm: 44, needle: 32, wheel: 46, prism: 26 };
const BOSS_BEAM_DRAIN = .5;        // its beam drains mana at this fraction of the rate yours does
/* Reflect. A beam aimed at the Alchemist while it has no beam of its own to answer
   with is met by a mirror: a pane of light held out in front of it, turning to face
   whoever is beaming. The beam stops at the pane and comes back out of it, at the
   wizard it came from, for as long as the mirror holds. It costs mana, lasts a
   moment, and then needs a moment to gather itself again — so the beam is answered,
   not made useless. */
const BOSS_REFLECT_COST = 18;      // mana to raise the mirror
const BOSS_REFLECT_LIFE = 1.8;     // most seconds it holds
const BOSS_REFLECT_CD = 4;         // seconds after it drops before it can be raised again
const BOSS_MIRROR_D = 58;          // how far in front of the boss the pane hangs (just past the wand tips)
const BOSS_MIRROR_HALF = 62;       // half the pane's width
const BOSS_MIRROR_TURN = 9;        // how fast the pane swings round to face a beam (rad/s)
const BOSS_MIRROR_SLEW = 1;        // how fast the returned beam can swing after its target (rad/s): the same as its own beam
const BOSS_MIRROR_KICK = .5;       // it leaves the glass this far off the line back to its target, and swings onto them: time to step aside
const BOSS_MIRROR_MUL = 1;         // the returned beam burns exactly as hard as the one that was thrown
/* How the mirror is raised. The front two hands come together in front of it (the
   glass is only a seam, as wide as the boss itself, so a beam that would hit it is
   already answered), then fling apart and the pane stretches out between them. */
const BOSS_MIRROR_CLASP = .34;     // seconds for the hands to meet
const BOSS_MIRROR_OPEN = .16;      // ...and then to draw the pane out to its full width
const BOSS_MIRROR_SEAM = 24;       // half the pane's width while the hands are together
const BOSS_MIRROR_DEPTH = 17;      // half the pane's thickness, as it is drawn (the beam is cut in its middle)
const BOSS_DRY = 1.5;              // seconds a wand may wait for mana (or a clear shot) before the hat turns early
// how far off it likes to stand for each spell: by spell index, and for the fused ones
const BOSS_RANGE = [290, 300, 370, 300, 340, 190];
const BOSS_RANGE_FUSED = { swarm: 380, needle: 300, wheel: 410, prism: 340 };
// how much room a shot needs beside a crate to get past it (about its own radius): by spell, and for the fused ones
const BOSS_PAD = [8, 10, 18, 0, 0, 0];
const BOSS_PAD_FUSED = { swarm: 9, needle: 7, wheel: 20, prism: 0 };
const BOSS_PERIOD = 8;             // casts (a fused cast counts as two) between one spin of the hat and the next
const BOSS_DUR = [.75, 1.0, 1.5, .8, 1.0, .7];       // seconds to charge, by spell index
const BOSS_POOL = [[0,.27],[1,.24],[2,.17],[3,.11],[4,.11],[5,.10]];
const BOSS_BEAM_HOLD = 2.0, BOSS_GRASP_HOLD = .55;
const BOSS_WAND = 24, BOSS_MUZZLE = 82;
const BOSS_SPIN = 1.25;            // the hat spins, the arms are behind its back
const BOSS_HOLSTER = .42, BOSS_DRAW = .5;            // seconds for an arm to put a wand away / bring one out
const BOSS_FUSE_CHARGE = .95, BOSS_FUSE_FLASH = .42; // the two wands come together; the star
const BOSS_FUSE_P = .7, BOSS_FUSE_CD = 2;  // chance it fuses at each chance / seconds between fusions
const BOSS_FUSE_PERIOD_P = .85;             // chance that a stretch is one it will fuse in at all
const BOSS_FUSE_FIRST = .5;                 // seconds after the hat lands before it may first fuse
const BOSS_FUSE_LOOK = .1;                  // while both wands are early in their charge, how often it considers fusing them
const BOSS_FUSE_PICK_P = .8;                // chance the hat, with a full enough pool, sets out to pick two spells that fuse
/* Fused spells, by the two spell indices they are made of (spark 0, rive 1, hex 2,
   ward 3, beam 4, grasp 5). A pair that is not listed does not fuse: the two
   wands just go on casting one each. */
const BOSS_COMBOS = {
  "1+2": { id:"swarm",  name:"Hexswarm",    color:"#c4561e", sound:"rive"  },   // rive + hex: a stream of homing missiles, launched a beat apart
  "0+1": { id:"needle", name:"Needle Rain", color:"#6f8dff", sound:"spark" },   // spark + rive: three quick volleys of fast, thin, homing needles
  "0+2": { id:"wheel",  name:"Sparkwheel",  color:"#ffd36b", sound:"hex"   },   // spark + hex: a spinning homing orb that throws rings of sparks and speeds up as it closes
  "1+4": { id:"prism",  name:"Prism Lance", color:"#e06bff", sound:"rive"  }    // rive + beam: a beam that throws homing missiles from its tip
};
const D2R = Math.PI / 180;
// Where each arm leaves the hat, and where its elbow (E) and hand (H) sit when it
// is out ("live") and when it is folded away ("stow": the hand behind the back,
// wand in its sheath). Local space: +x is the way the boss faces. Pair 0 is
// front-left + rear-right, pair 1 the other two. `side` is which hand it is.
const BOSS_ARMS = [
  { id:"FL", pair:0, side:-1, S:[14,-16], live:{ E:[38,-72], H:[78,-56] }, stow:{ E:[-2,-56],  H:[-50,-24], wa:200 } },
  { id:"RR", pair:0, side: 1, S:[-8,20],  live:{ E:[22,78],  H:[64,66]  }, stow:{ E:[-34,46],  H:[-60,9],   wa:172 } },
  { id:"FR", pair:1, side: 1, S:[14,16],  live:{ E:[38,72],  H:[78,56]  }, stow:{ E:[-2,56],   H:[-50,24],  wa:160 } },
  { id:"RL", pair:1, side:-1, S:[-8,-20], live:{ E:[22,-78], H:[64,-66] }, stow:{ E:[-34,-46], H:[-60,-9],  wa:188 } }
];

const bzLerp = (a, b, t) => a + (b - a) * t;
function bzAng(a, b, t){ return a + angDiff(b, a) * t; }
/* One arm's pose. `k` is how far the arm is out (0: the wand is sheathed behind
   its back, 1: out and working), P the target in the boss's own frame, `foc` how
   far the arm has swept to the centre line to channel the beam, `cf` how far it
   has come in to meet the other hand to fuse a spell. Used by the sim (where the
   shot leaves) and by the drawing (where the wand is) — one function, so the
   spell comes out of the wand you see. */
function bossPose(i, k, P, foc, cf, rc, rw){
  const a = BOSS_ARMS[i], sd = a.side;
  const bulge = SIN(Math.PI * k);        // the hand goes round the side of the body, not through the hat
  let ex = bzLerp(a.stow.E[0], a.live.E[0], k), ey = bzLerp(a.stow.E[1], a.live.E[1], k) + sd * bulge * 14;
  let hx = bzLerp(a.stow.H[0], a.live.H[0], k), hy = bzLerp(a.stow.H[1], a.live.H[1], k) + sd * bulge * 22;
  const aim = ATAN2(P[1] - hy, P[0] - hx);
  let wa = bzAng(a.stow.wa * D2R, aim, k);
  if (cf > 0){
    ex = bzLerp(ex, 34, cf); ey = bzLerp(ey, sd * 46, cf);
    hx = bzLerp(hx, 66, cf); hy = bzLerp(hy, sd * 11, cf);
    wa = bzAng(wa, -sd * .3, cf);
  }
  if (foc > 0){
    ex = bzLerp(ex, 30, foc); ey = bzLerp(ey, sd * 26, foc);
    hx = bzLerp(hx, BOSS_MUZZLE - BOSS_WAND, foc); hy = bzLerp(hy, 0, foc);
    wa = bzAng(wa, 0, foc);
  }
  /* The mirror. `rc`: the hands come together in front of the chest, wands up (a clap);
     `rw`: then the arms fling out to the sides, nearly straight, and the wands point out
     along the pane they are holding open. Only the two front arms are ever asked for it. */
  if (rc > 0){
    ex = bzLerp(ex, 36, rc); ey = bzLerp(ey, sd * 40, rc);
    hx = bzLerp(hx, 70, rc); hy = bzLerp(hy, sd * 6, rc);
    wa = bzAng(wa, -sd * .15, rc);
  }
  if (rw > 0){
    ex = bzLerp(ex, 56, rw); ey = bzLerp(ey, sd * 58, rw);
    hx = bzLerp(hx, 86, rw); hy = bzLerp(hy, sd * 88, rw);
    wa = bzAng(wa, sd * 1.2, rw);
  }
  return { i, id:a.id, S:a.S, E:[ex, ey], H:[hx, hy], w:k, foc,
           T:[hx + COS(wa)*BOSS_WAND, hy + SIN(wa)*BOSS_WAND] };
}
function bossLocalTarget(w){
  const t = w.target;
  if (!t) return [150, 0];
  // in the design's own units (see BOSS_SCALE), so it lines up with bossPose
  const dx = t.x - w.x, dy = t.y - w.y, c = COS(w.facing), s = SIN(w.facing);
  return [(dx*c + dy*s) / BOSS_SCALE, (-dx*s + dy*c) / BOSS_SCALE];
}
function bossInit(w){
  const arms = [];
  for (let i = 0; i < 4; i++)
    arms.push({ spell: 0, t: 0, dur: 1, st: 3, held: 0, burst: 0, bt: 0, foc: 0, cf: 0, rc: 0, rw: 0, k: 0, fired: 0, dry: 0, wait: 0, force: false, blind: 0 });
  w.boss = { pair: 0, phase: "intro", pt: 1.3, fires: 0, wake: 0, next: -1, nextCol: null,
             spinK: 0, spinT: BOSS_SPIN, slots: [0,1,2,3,4,5], prev: [0,1,2,3,4,5], lock: [0,1], lastKey: "", combo: null,
             fuse: null, fuseCd: 0, look: 0, rolled: false, wantFuse: true, flashN: 0, q: [], prism: null,
             strafe: 1, strafeT: 1, goal: null, goalT: 0, arms,
             // the mind: what it has noticed, how long ago, and where it means to go
             alert: 0, lag: .1, dodge: 0, ex: 0, ey: 0, hideT: 0, coverCd: 0, blind: 0, flanking: false, aim: null,
             sense: null, actCd: 0, dashes: 0, dodges: 0, wards: 0,
             refl: null, reflCd: 1, reflN: 0 };
  bossLock(w);
  w.speedMul = .82;
}
/* How much the hat wants each spell right now. This is the Alchemist reading the
   room: it will not pick what it cannot pay for or cannot use from where it
   stands, it goes for the spells that break a ward when you are behind one, it
   keeps its distance-spells for a long shot and its fast ones for close work, and
   when it is hurt it reaches for the wall. All of it is simulation state — the
   target's position, hp, mana and ward — never anything that is drawn. */
function bossWeight(w, sp){
  let k = BOSS_POOL[sp][1];
  const o = w.target;
  if (w.mana < BOSS_COST[sp] * 2.4) k *= .3;             // it could not keep that up
  if (!o) return k;
  const d = HYPOT(o.x - w.x, o.y - w.y), hurtBad = w.hp < w.hpMax * .5;
  const los = lineClear(w, o, true, BOSS_PAD[sp]);
  if (!los && sp !== 3) k *= .35;                        // nothing it throws goes through a crate
  const walled = o.ward > 8;
  if (sp === 0){ if (d < 250) k *= 1.4; if (walled) k *= .55; }
  else if (sp === 1){ if (walled) k *= .55; }
  else if (sp === 2){ if (walled) k *= 2.2; if (d < 170) k *= .6; if (d > 330) k *= 1.2; }
  else if (sp === 3){ if (hurtBad) k *= 2.2; if (w.ward > 0) k *= .3; }
  else if (sp === 4){
    if (!lineClear(w, o, false)) k *= .15;
    if (walled) k *= 2;
    if (d > 380) k *= 1.3;
    if (o.dashCool <= 0) k *= .75;                       // they can still step out of it
    if (o.mana < 25) k *= 1.6;
  }
  else if (sp === 5){ if (d < 260) k *= 1.8; else k *= .5; }
  return Math.max(.02, k);
}
// One draw from the boss's own spell pool. No grasp with nothing to grab.
function bossPickOne(w, not){
  for (let tries = 0; tries < 10; tries++){
    let tot = 0;
    const ws = [];
    for (let sp = 0; sp < 6; sp++){ const k = (sp === 5 && !liftable(w)) || sp === not ? 0 : bossWeight(w, sp); ws.push(k); tot += k; }
    let r = rand() * tot, pick = 0;
    for (let sp = 0; sp < 6; sp++){ r -= ws[sp]; if (r < 0){ pick = sp; break; } }
    if (pick === 5 && !liftable(w)) continue;
    if (pick === not) continue;
    return pick;
  }
  return not === 0 ? 1 : 0;
}
const bossKey = (a, b) => (a < b ? a : b) + "+" + (a < b ? b : a);
/* The hat chooses. Two different spells, one for each hand; half the time the
   second is picked to fuse with the first. The ring's six stones are then laid
   out so that the two chosen ones end up under the two reading marks (slots 0
   and 2) when the ring comes to rest, and the other four fill in the rest. */
function bossLock(w){
  const B = w.boss;
  let a = 0, b = 1, set = false;
  // With the mana for it, the hat mostly sets out to pick a pair that fuses (one it can pay for, and not the one it just made if there is another)
  if (rand() < (w.mana >= 55 ? BOSS_FUSE_PICK_P : w.mana >= 36 ? .5 : .15)){
    const opts = [];
    for (const k in BOSS_COMBOS){
      const id = BOSS_COMBOS[k].id;
      if (k === B.lastKey || w.mana < BOSS_FUSED_COST[id] + (id === "prism" ? 26 : 4)) continue;      // the price it will be asked for a moment later
      if (id === "prism" && (w.beamOn || w.beamBurn > 0)) continue;
      opts.push(k);
    }
    if (opts.length){
      let tot = 0;
      for (const k of opts) tot += k === "1+4" ? .6 : 1;
      let r = rand() * tot, pick = opts[0];
      for (const k of opts){ r -= k === "1+4" ? .6 : 1; if (r < 0){ pick = k; break; } }
      const ab = pick.split("+");
      a = +ab[0]; b = +ab[1]; set = true;
    }
  }
  for (let tries = 0; !set && tries < 6; tries++){
    a = bossPickOne(w, -1);
    const mates = [];
    for (let s = 0; s < 6; s++) if (s !== a && BOSS_COMBOS[bossKey(a, s)]) mates.push(s);
    // a full pool wants to fuse; a thin one does not have the mana to
    if (mates.length && rand() < (w.mana >= 55 ? .6 : .3)) b = mates[(rand() * mates.length) | 0];
    else b = bossPickOne(w, a);
    if (bossKey(a, b) !== B.lastKey) break;
  }
  if (rand() < .5){ const t = a; a = b; b = t; }
  B.lock = [a, b]; B.lastKey = bossKey(a, b); B.combo = BOSS_COMBOS[B.lastKey] || null;
  for (let i = 0; i < 4; i++) B.arms[i].spell = BOSS_ARMS[i].side < 0 ? a : b;
  const rest = [];
  for (let s = 0; s < 6; s++) if (s !== a && s !== b) rest.push(s);
  for (let i = rest.length - 1; i > 0; i--){ const j = (rand() * (i + 1)) | 0; const t = rest[i]; rest[i] = rest[j]; rest[j] = t; }
  B.prev = B.slots;
  B.slots = [a, rest[0], b, rest[1], rest[2], rest[3]];
}
function bossTip(w, i){
  const B = w.boss, A = B.arms[i], p = bossPose(i, A.k, bossLocalTarget(w), A.foc, A.cf, A.rc, A.rw);
  const c = COS(w.facing), s = SIN(w.facing);
  const tx = p.T[0] * BOSS_SCALE, ty = p.T[1] * BOSS_SCALE;
  return { x: w.x + c*tx - s*ty, y: w.y + s*tx + c*ty };
}
/* Where to aim so a shot of this speed meets the target rather than where the
   target was. It leads a walking target and does not lead a dash (which is over
   before the shot arrives), and never turns the aim more than half a radian. */
function bossLead(w, x, y, speed){
  const t = w.target;
  if (!t) return w.facing;
  const direct = ATAN2(t.y - y, t.x - x);
  if (t.dashT > 0) return direct;
  let px = t.x, py = t.y;
  for (let k = 0; k < 2; k++){
    const tt = clamp(HYPOT(px - x, py - y) / speed, 0, .8);
    px = t.x + (t.vx || 0) * tt * .9; py = t.y + (t.vy || 0) * tt * .9;
  }
  return direct + clamp(angDiff(ATAN2(py - y, px - x), direct), -.5, .5);
}
// cast() charges the standard price and refuses below it; the Alchemist pays its own
// (BOSS_COST), so the wand casts for free and the price comes off the bar here.
function bossFreeCast(w, spell, lvl, x, y, ang){
  const m = w.mana;
  w.mana = 999;
  cast(w, spell, lvl, x, y, ang);
  w.mana = m;
}
function bossShoot(w, i, spell, lvl){
  const tip = bossTip(w, i);
  const ang = spell === 0 ? bossLead(w, tip.x, tip.y, byId.spark.speed)
            : w.target ? ATAN2(w.target.y - tip.y, w.target.x - tip.x) : w.facing;
  bossFreeCast(w, spell, lvl, tip.x, tip.y, ang);
}
/* A homing missile out of one wand tip: the shared body of the fused spells.
   `o` carries how it flies (see bossCombo); `o.off` fans it off the aim. */
function bossMissile(w, i, o){
  const tip = bossTip(w, i);
  const base = w.target ? ATAN2(w.target.y - tip.y, w.target.x - tip.x) : w.facing;
  const ang = base + o.off + rnd(-.03, .03);
  const sp = o.v0 * rnd(.92, 1.08);
  shots.push({ x: tip.x, y: tip.y, vx: COS(ang)*sp, vy: SIN(ang)*sp, weight: 1, w0: 1,
               dmg: o.dmg * dmgMul(w), r: o.r, color: o.color, kind: o.kind, owner: w, life: o.life, trail: [], spin: 0,
               seek: { turn: o.turn, wob: o.wob, vMin: sp, vMax: o.v1 ? o.v1 * (sp / o.v0) : sp, phase: rand()*TAU },
               glow: o.glow || 16, lvl: 0, seq: shotSeq++ });
  swish(w, o.color, "cast");
}
function bossLive(B, i){ return BOSS_ARMS[i].pair === B.pair; }
function bossTempo(w){ return w.hp < w.hpMax * .4 ? .78 : 1; }
// the hat spins: pick two spells, and the arms go round behind the back
function bossSpin(w, flip){
  const B = w.boss;
  if (flip) B.pair ^= 1;
  B.phase = "spin"; B.spinT = BOSS_SPIN * (w.hp < w.hpMax * .4 ? .82 : 1); B.pt = B.spinT; B.spinK = 0; B.wake = 0;
  B.fuse = null; B.q = []; B.prism = null;
  for (let i = 0; i < 4; i++){ const A = B.arms[i]; A.st = 3; A.t = 0; A.held = 0; A.burst = 0; A.dry = 0; A.wait = 0; A.force = false; A.blind = 0; }
  bossLock(w);
  B.wantFuse = rand() < BOSS_FUSE_PERIOD_P;                 // some stretches it never fuses at all, even with a pair that could
  spinSound(true);
}
// the spin is over: the live pair draws its wands and goes to work, the second a beat behind the first
function bossBegin(w){
  const B = w.boss, tempo = bossTempo(w);
  let n = 0;
  for (let i = 0; i < 4; i++){
    const A = B.arms[i];
    if (!bossLive(B, i)){ A.st = 3; A.t = 0; continue; }
    A.st = 0; A.t = -(BOSS_DRAW * .7 + .45 * n++); A.dur = BOSS_DUR[A.spell] * tempo;
  }
  B.phase = "live"; B.fires = 0; B.wake = 0; B.spinK = 0; B.fuseCd = BOSS_FUSE_FIRST; B.rolled = false; B.look = 0;
  spinSound(false);
  lockSound();
}
// A wand has spent its spell: the same spell goes back in, and either it goes
// again or, once the pair has cast enough, the hat starts to turn.
function bossReload(w, i){
  const B = w.boss, A = B.arms[i], tempo = bossTempo(w);
  A.fired = .3;
  B.fires++; B.rolled = false;
  A.dur = BOSS_DUR[A.spell] * tempo;
  A.t = -rnd(.12, .35);
  if (A.spell === 3 && w.ward > 0) A.t -= rnd(.6, 1.4);      // its wall is still standing: no hurry to raise another
  A.st = B.phase === "live" ? 0 : 3;
  if (B.phase === "live" && B.fires >= BOSS_PERIOD){ B.phase = "warn"; B.pt = .7; }
  else if (B.phase === "live") bossTryFuse(w, i);
}
// two wands that are both winding up, holding spells that fuse, may come together instead
function bossTryFuse(w, i){
  const B = w.boss, A = B.arms[i], P = B.arms[i ^ 1];
  if (!B.combo || !B.wantFuse || B.fuse || B.fuseCd > 0 || B.fires > BOSS_PERIOD - 2) return;
  if (A.st !== 0 || P.st !== 0 || A.t > A.dur * .5 || P.t > P.dur * .5) return;
  if (B.combo.id === "prism" && (w.beamOn || w.beamBurn > 0)) return;
  if (w.mana < BOSS_FUSED_COST[B.combo.id] + (B.combo.id === "prism" ? 26 : 4)) return;     // it will not start what it cannot finish
  if (w.target && !lineClear(w, w.target, B.combo.id !== "prism", BOSS_PAD_FUSED[B.combo.id])) return;                  // nor throw one into a crate
  if (B.rolled) return;                       // one roll for each time the wands wind up: not one every look
  if (rand() >= BOSS_FUSE_P){ B.rolled = true; return; }
  B.fuse = { t: 0, stage: 0, flash: 0 };
  A.st = 4; P.st = 4; A.t = P.t = 0;
}
/* The fused spell leaves. Both wands are spent; the star has already flashed. */
function bossCombo(w){
  const B = w.boss, C = B.combo, tempo = bossTempo(w);
  const aL = B.arms.findIndex((A, i) => bossLive(B, i) && BOSS_ARMS[i].side < 0);
  const aR = B.arms.findIndex((A, i) => bossLive(B, i) && BOSS_ARMS[i].side > 0);
  B.fuse = null; B.fuseCd = BOSS_FUSE_CD; B.fires += 2; B.rolled = false;
  const arm = n => n & 1 ? aR : aL;
  w.mana = Math.max(0, w.mana - BOSS_FUSED_COST[C.id]);
  if (C.id === "swarm"){
    // a stream of ten, alternating hands, each a little further off the line than the last:
    // they leave a beat apart, so they land a beat apart
    for (let n = 0; n < 10; n++){
      const sgn = n & 1 ? 1 : -1;
      B.q.push({ t: n * .075, arm: arm(n), off: sgn * (.1 + .09 * (n >> 1)), kind: "swarm", color: C.color,
                 v0: 200, v1: 430, turn: 1.7, wob: .7, dmg: 7, r: 7.5, life: 4.6, glow: 20 });
    }
  } else if (C.id === "needle"){
    for (let v = 0; v < 3; v++) for (let k = 0; k < 5; k++)
      B.q.push({ t: v * .16, arm: arm(k), off: (k - 2) * .12, kind: "needle", color: C.color,
                 v0: 560, turn: .55, wob: .3, dmg: 4.5, r: 5, life: 3.2, glow: 14 });
  } else if (C.id === "wheel"){
    // one heavy spinning orb. It homes like a hexstone, and like a hexstone it
    // comes on faster the nearer it gets; every third of a second it throws a ring of
    // sparks out from its rim, the ring turning a half-gap each time so the holes
    // in it wander. The rings come faster as it closes.
    const tip = bossTip(w, aL), a = w.target ? ATAN2(w.target.y - tip.y, w.target.x - tip.x) : w.facing;
    shots.push({ x: tip.x, y: tip.y, vx: COS(a)*95, vy: SIN(a)*95, weight: 7, w0: 7,
                 dmg: 32 * dmgMul(w), r: 16, glow: 32, color: C.color, kind: "wheel", owner: w, life: 6.2, trail: [], spin: 0,
                 seek: { turn: 1.5, wob: .3, vMin: 95, vMax: 620, phase: rand()*TAU },
                 ring: { t: .22, every: .36, n: 9, k: 0, v: 230 }, lvl: .7, seq: shotSeq++ });
    swish(w, C.color, "cast");
  } else if (C.id === "prism"){
    const bi = B.arms.findIndex((A, i) => bossLive(B, i) && A.spell === 4);
    // the Prism Lance does not wind up like an ordinary beam: it is already live the
    // instant the wands fuse, so beamWind starts at the ordinary beam's own cast time
    // rather than at zero
    w.beamOn = true; w.beamWind = byId.beam.cast; w.charge = null; w.beamTint = C.color;
    B.arms[bi].st = 1; B.arms[bi].held = 0; B.arms[bi ^ 1].st = 5;
    B.prism = { arm: bi, t: .2 };
  }
  // (the orb has its own sound, played as it is launched and only then: not as the wands come together, not at the star)
  if (C.id === "wheel") cue("hexspark", hexsparkSfx, HEXSPARK_VOL);
  else if (C.id === "needle") cue("sparkrive", sparkriveSfx, SPARKRIVE_VOL);
  else if (C.id === "swarm") cue("hexrive", hexriveSfx, HEXRIVE_VOL);
  else if (C.id === "prism") cue("prismlance", prismlanceSfx, PRISMLANCE_VOL, { tail: .3 });
  else castSound(w, C.sound);
  shake = Math.min(shake + (REDUCED ? 0 : 5), 9);
  if (C.id !== "prism"){
    for (const i of [aL, aR]){
      const A = B.arms[i];
      A.fired = .3; A.dur = BOSS_DUR[A.spell] * tempo; A.t = -rnd(.6, 1); A.st = 0;      // (a longer breather after a fused spell: it is the one you have to answer)
    }
    if (B.fires >= BOSS_PERIOD){ B.phase = "warn"; B.pt = .7; }
  }
}
function bossPrismEnd(w){
  const B = w.boss, tempo = bossTempo(w);
  fadeOutCue("prismlance", PRISMLANCE_FADE);   // cut off sharply, not left ringing like a held beam
  stopBeam(w, true); w.beamTint = null; B.prism = null;
  for (let i = 0; i < 4; i++){
    const A = B.arms[i];
    if (!bossLive(B, i) || A.st === 3) continue;
    A.fired = .3; A.dur = BOSS_DUR[A.spell] * tempo; A.t = -rnd(.25, .6); A.st = 0; A.held = 0;
  }
  if (B.fires >= BOSS_PERIOD){ B.phase = "warn"; B.pt = .7; }
}
// what wand `i` has to have in the bar to let go of its spell
function bossNeed(w, i){
  const sp = w.boss.arms[i].spell;
  if (sp === 4) return w.beamOn ? 0 : BOSS_COST[0];     // the beam was paid for when it opened
  if (sp === 5 && (w.held || !liftable(w))) return BOSS_COST[0];
  return BOSS_COST[sp];
}
function bossRelease(w, i){
  const B = w.boss, A = B.arms[i];
  let sp = A.spell;
  A.wait = 0; A.dry = 0; A.force = false;
  if (sp === 4 && !w.beamOn) sp = 0;                   // beam is armed when its charge starts; this is the fallback
  if (sp === 5){
    if (!w.held && liftable(w)){ w.castLock = 0; beginCharge(w, 5); A.st = 1; A.held = 0; return; }   // beginCharge takes grasp's own price
    sp = 0;
  }
  if (sp === 4){ A.st = 1; A.held = 0; A.blind = 0; return; }       // the beam is now open: hold it
  w.mana = Math.max(0, w.mana - BOSS_COST[sp]);
  if (sp === 0){ bossShoot(w, i, 0, 0); A.burst = 2; A.bt = .1; A.st = 2; return; }
  if (sp === 1) bossShoot(w, i, 1, .5);
  else if (sp === 2) bossShoot(w, i, 2, .6);
  else if (sp === 3){ bossShoot(w, i, 3, .6); B.wards++; }
  bossReload(w, i);
}
/* ---- the mirror
   Simulation, like everything here: positions, the seeded stream (not even that —
   nothing below rolls anything), the deterministic trig. The glitter it throws off
   goes to the view-only particle list with vrand(), as a clashing beam's does. */
// is the beam one of the two spells it is holding right now, or already open?
function bossBeamUp(w){
  const B = w.boss;
  if (w.beamOn) return true;
  return B.arms.some((A, i) => bossLive(B, i) && A.spell === 4 && A.st !== 3 && A.st !== 5);
}
/* The AI's view of the mirror: is aiming a beam at this wizard about to be a mistake? A bot
   that knows the Alchemist has a mirror does not open a beam on it while the mirror is up or
   is about to be ready, and lets go of one it has open when the glass goes up. (Anything that
   is not the Alchemist has no mirror; a beam at it is as good an idea as ever.) */
function bossMirrorThreat(b){
  if (!b || !b.boss || b.dead) return false;
  const B = b.boss;
  if (B.refl) return true;
  return b.mana >= BOSS_REFLECT_COST && !bossBeamUp(b) && B.reflCd < 2.5;
}
function bossReflectReady(w){
  const B = w.boss;
  return !w.dead && !B.refl && B.phase !== "intro" && B.reflCd <= 0 && w.mana >= BOSS_REFLECT_COST && !bossBeamUp(w);
}
// how far the pane has been drawn out (0 while the hands are still coming together, 1 at full width)
function bossMirrorOpenK(R){
  const k = clamp((R.t - BOSS_MIRROR_CLASP) / BOSS_MIRROR_OPEN, 0, 1);
  return 1 - (1 - k) * (1 - k) * (1 - k);
}
function bossMirrorHalf(R){ return BOSS_MIRROR_SEAM + (BOSS_MIRROR_HALF - BOSS_MIRROR_SEAM) * bossMirrorOpenK(R); }
function bossReflectOpen(w, src){
  const B = w.boss;
  w.mana = Math.max(0, w.mana - BOSS_REFLECT_COST);
  const a = src ? ATAN2(src.y - w.y, src.x - w.x) : w.facing;
  B.refl = { t: 0, ang: a, want: a, quiet: 0, out: [], burn: 0, half: BOSS_MIRROR_SEAM, snapped: false, bounced: false };
  B.reflN++;
  const cx = w.x + COS(a) * BOSS_MIRROR_D * .8, cy = w.y + SIN(a) * BOSS_MIRROR_D * .8;
  rings.push({ x: cx, y: cy, r: 22, max: 6, t: 0, life: BOSS_MIRROR_CLASP, color: "#bff4ff", width: 1.6 });   // a ring gathering in on the hands
  puff(cx, cy, "#bff4ff", 6);
  cue("reflect", reflectSfx, REFLECT_SND.vol, { tail: .6 });     // (the file starts a moment before its big hit, which lands as the hands come apart)
}
function bossReflectClose(w){
  const B = w.boss, R = B.refl;
  if (!R) return;
  const c = COS(R.ang), s = SIN(R.ang), cx = w.x + c * BOSS_MIRROR_D, cy = w.y + s * BOSS_MIRROR_D;
  // the pane comes apart: a spray of glitter along its length
  for (let k = 0; k < (REDUCED ? 4 : 22); k++){
    const u = vrnd(-1, 1), sp = vrnd(30, 150);
    bits.push({ x: cx - s * u * R.half, y: cy + c * u * R.half, vx: c * sp * .6 - s * vrnd(-60, 60), vy: s * sp * .6 + c * vrnd(-60, 60),
                life: vrnd(.25, .6), t: 0, color: vrand() < .5 ? "#ffffff" : "#8fe9ff", r: vrnd(1, 2.6) });
  }
  rings.push({ x: cx, y: cy, r: 10, max: 60, t: 0, life: .28, color: "#8fe9ff", width: 1.6 });
  fadeOutCue("reflect", REFLECT_SND.out); fadeOutCue("reflect3", REFLECT_SND.out);       // the glass is gone: its sound dies away, it does not stop dead
  B.refl = null;
  B.reflCd = BOSS_REFLECT_CD;
}
// where along a→b the segment c→d is crossed (0..1), or -1
function segSegT(ax, ay, bx, by, cx, cy, dx, dy){
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (den > -1e-9 && den < 1e-9) return -1;
  const qx = cx - ax, qy = cy - ay;
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}
// how far a beam that leaves (x, y) at angle a gets: to a wall, or to a crate that stops it
function beamReachAt(x, y, a){
  const dx = COS(a), dy = SIN(a);
  let best = 1400;
  if (dx > 0.001) best = Math.min(best, (W-4 - x)/dx);
  if (dx < -0.001) best = Math.min(best, (4 - x)/dx);
  if (dy > 0.001) best = Math.min(best, (H-4 - y)/dy);
  if (dy < -0.001) best = Math.min(best, (4 - y)/dy);
  for (const d of debris){
    if (d.gone || !blocksBeam(d)) continue;
    const t = rayCircle(x + dx*4, y + dy*4, dx, dy, d.x, d.y, d.r);
    if (t > 0 && t + 4 < best) best = t + 4;
  }
  return best;
}
/* One tick of the mirror, run once the beams' lengths are known and before anything
   is burnt. With no mirror up it looks for the beam that is burning the boss and was
   not seen coming (the mind raises the mirror early when it does see one). With a
   mirror up it turns the pane to face the beam, cuts every enemy beam that reaches
   it off at the glass, and sends each one back out of the point where it landed. */
function bossMirrorStep(w, dt){
  const B = w.boss;
  B.reflCd = Math.max(0, B.reflCd - dt);
  if (w.dead){ B.refl = null; return; }
  const cast = byId.beam.cast;
  if (!B.refl){
    if (!bossReflectReady(w)) return;
    for (const f of wizards){
      if (f.dead || f.team === w.team || !f.beamOn || f.beamWind < cast) continue;
      if (segCircle(f.x, f.y, f.x + COS(f.facing)*f.beamLen, f.y + SIN(f.facing)*f.beamLen, w.x, w.y, w.r + 4)){ bossReflectOpen(w, f); break; }
    }
    if (!B.refl) return;
  }
  const R = B.refl;
  R.t += dt;
  R.half = bossMirrorHalf(R);
  if (!R.snapped && R.t >= BOSS_MIRROR_CLASP){
    // the hands meet, and fling apart: a flash, a ring, the pane's edges shooting out
    R.snapped = true;
    const c0 = COS(R.ang), s0 = SIN(R.ang), mx = w.x + c0 * BOSS_MIRROR_D, my = w.y + s0 * BOSS_MIRROR_D;
    impact(mx, my, 2.6, "#ffffff");
    rings.push({ x: mx, y: my, r: 8, max: 96, t: 0, life: .32, color: "#bff4ff", width: 2.6 });
    rings.push({ x: mx, y: my, r: 4, max: 60, t: 0, life: .22, color: "#ffffff", width: 1.8 });
    puff(mx, my, "#ffffff", 10);
    if (!REDUCED) for (let k = 0; k < 16; k++){
      const side = k & 1 ? 1 : -1, sp = vrnd(200, 420);
      bits.push({ x: mx, y: my, vx: -s0 * side * sp + c0 * vrnd(-40, 40), vy: c0 * side * sp + s0 * vrnd(-40, 40),
                  life: vrnd(.2, .45), t: 0, color: vrand() < .5 ? "#ffffff" : "#8fe9ff", r: vrnd(1, 2.6) });
    }
    shake = Math.min(shake + (REDUCED ? 0 : 3), 9);
  }
  // whoever is beaming most nearly along the line to the boss is the one it faces
  let feed = false, best = 1e9, pick = null;
  for (const f of wizards){
    if (f.dead || f.team === w.team || !f.beamOn) continue;
    feed = true;
    const fx = COS(f.facing), fy = SIN(f.facing), rx = w.x - f.x, ry = w.y - f.y;
    const across = rx*fx + ry*fy > 0 ? Math.abs(-rx*fy + ry*fx) : 1e8;
    if (across < best){ best = across; pick = f; }
  }
  R.quiet = feed ? 0 : R.quiet + dt;
  if (pick) R.want = ATAN2(pick.y - w.y, pick.x - w.x);
  R.ang += clamp(angDiff(R.want, R.ang), -BOSS_MIRROR_TURN*dt, BOSS_MIRROR_TURN*dt);
  const ca = COS(R.ang), sa = SIN(R.ang);
  const cx = w.x + ca * BOSS_MIRROR_D, cy = w.y + sa * BOSS_MIRROR_D;
  const p1x = cx + sa * R.half, p1y = cy - ca * R.half;
  const p2x = cx - sa * R.half, p2y = cy + ca * R.half;
  const prev = R.out;
  R.out = [];
  for (const f of wizards){
    if (f.dead || f.team === w.team || !f.beamOn || f.beamWind < cast || !(f.beamLen > 0)) continue;
    const bx = f.x + COS(f.facing) * f.beamLen, by = f.y + SIN(f.facing) * f.beamLen;
    const t = segSegT(f.x, f.y, bx, by, p1x, p1y, p2x, p2y);
    if (t < 0) continue;
    const px = f.x + (bx - f.x) * t, py = f.y + (by - f.y) * t;
    f.beamLen *= t;                                               // the beam goes no further than the glass
    const want = ATAN2(f.y - py, f.x - px);
    let o = prev.find(q => q.id === f.id), fresh = false;
    if (!o){
      // off the glass a little to the side its beam was aimed off the boss's centre, then round onto its target
      const side = angDiff(f.facing, ATAN2(w.y - f.y, w.x - f.x)) >= 0 ? 1 : -1;
      o = { id: f.id, ang: want + side * BOSS_MIRROR_KICK, x: px, y: py, len: 0 }; fresh = true;
    }
    else o.ang += clamp(angDiff(want, o.ang), -BOSS_MIRROR_SLEW*dt, BOSS_MIRROR_SLEW*dt);
    o.x = px; o.y = py;
    o.len = beamReachAt(px, py, o.ang);
    const ex = px + COS(o.ang) * o.len, ey = py + SIN(o.ang) * o.len;
    for (const q of wizards){
      if (q.dead || q.team === w.team) continue;
      if (segCircle(px, py, ex, ey, q.x, q.y, q.r + 4))
        strike(q, byId.beam.dmg * dt * dmgMul(f) * BOSS_MIRROR_MUL, px, py, "beam", true, w);
    }
    R.out.push(o);
    if (fresh){
      if (!R.bounced){ R.bounced = true; cue("reflect3", reflect3Sfx, REFLECT_SND.vol3, { tail: .5 }); }     // a beam has come back off the glass: once per mirror
      impact(px, py, 3.2, "#ffffff");
      rings.push({ x: px, y: py, r: 6, max: 70, t: 0, life: .3, color: "#ffffff", width: 2.4 });
      puff(px, py, "#ffffff", 10);
    }
    if (!REDUCED) for (let k = 0; k < 2; k++){                    // sparks thrown off the point of reflection, back the way it came
      const a = R.ang + Math.PI + vrnd(-1.1, 1.1), sp = vrnd(120, 300);
      bits.push({ x: px, y: py, vx: COS(a) * sp, vy: SIN(a) * sp, life: vrnd(.15, .4), t: 0, color: vrand() < .5 ? "#ffffff" : "#8fe9ff", r: vrnd(1, 2.6) });
    }
  }
  // the glass glitters
  if (!REDUCED && vrand() < .85){
    const u = vrnd(-1, 1), sp = vrnd(15, 70);
    bits.push({ x: cx - sa * u * R.half, y: cy + ca * u * R.half, vx: ca * sp + vrnd(-20, 20), vy: sa * sp + vrnd(-20, 20),
                life: vrnd(.25, .55), t: 0, color: vrand() < .5 ? "#ffffff" : "#8fe9ff", r: vrnd(.8, 2) });
  }
  if (!R.hold && (R.t >= BOSS_REFLECT_LIFE || (R.t > .25 && R.quiet > .3))) bossReflectClose(w);
}
/* ---- the Alchemist's mind
   Everything below is simulation: it reads positions, velocities, hp and mana
   of things in the world and the seeded rand(); it never reads `you` and never
   anything that is only drawn. */

/* What is coming at it. For each hostile shot it finds the moment the shot passes
   closest to the boss and whether that pass is a hit; a homing shot gets a wider
   net, since it will bend in. `ex, ey` (a unit vector, or zero) is the way to
   step that takes it out of the most dangerous lanes. A beam that is winding up
   or firing along a line through the boss is a threat too, and the way out of
   a beam is at right angles to it. */
function bossSense(w){
  const S = { hit: 0, weight: 0, light: 0, soonest: 9, beam: false, beamSrc: null, ex: 0, ey: 0 };
  const R = w.r + 8;
  const lane = (px, py, vx, vy, r, weight, kind, seeks) => {
    const sp2 = vx*vx + vy*vy;
    if (sp2 < 1) return;
    const rx = w.x - px, ry = w.y - py;
    const t = (rx*vx + ry*vy) / sp2;                       // when the shot is nearest to the boss
    if (t < 0 || t > 1.5) return;                          // going away, or too far off to matter yet
    const m = HYPOT(px + vx*t - w.x, py + vy*t - w.y);
    if (m > r + R + (seeks ? 22 + 30*t : 0)) return;       // it misses
    S.hit++; S.weight += weight;
    if (WARD_BLOCKS[kind]) S.light += weight;
    if (t < S.soonest) S.soonest = t;
    const sp = HYPOT(vx, vy), nx = -vy/sp, ny = vx/sp;     // the shot's own normal: sidestep along it
    const side = (rx*nx + ry*ny) >= 0 ? 1 : -1;
    const g = weight / (.25 + t);
    S.ex += nx*side*g; S.ey += ny*side*g;
  };
  for (const s of shots){
    if (!s.owner || s.owner.team === w.team) continue;
    lane(s.x, s.y, s.vx, s.vy, s.r, s.weight, s.kind, !!s.seek);
  }
  for (const d of debris)
    if (d.thrown > 0 && !d.gone) lane(d.x, d.y, d.vx, d.vy, d.r, 3, "debris", false);
  for (const f of wizards){
    if (f.dead || f.team === w.team || !f.beamOn || f.beamWind < byId.beam.cast * .35) continue;
    const fx = COS(f.facing), fy = SIN(f.facing), rx = w.x - f.x, ry = w.y - f.y;
    if (rx*fx + ry*fy <= 0) continue;                      // behind the wand
    const across = -rx*fy + ry*fx;                         // signed distance from the beam's line
    if (Math.abs(across) > 64 || !lineClear(f, w, false)) continue;
    S.beam = true;
    if (!S.beamSrc) S.beamSrc = f;
    const sg = across >= 0 ? 1 : -1;
    S.ex += -fy*sg*9; S.ey += fx*sg*9;
  }
  const L = HYPOT(S.ex, S.ey);
  if (L > .001){ S.ex /= L; S.ey /= L; } else { S.ex = S.ey = 0; }
  return S;
}
// A dash goes 150 px. Is there room along this direction (not a wall, not a crate)?
// A shot's line can be crossed the wrong way, so a shot only allows the one side;
// a beam is fine to leave either way.
function bossDashDir(w, ex, ey, both){
  const L = HYPOT(ex, ey);
  if (L < .01) return null;
  ex /= L; ey /= L;
  for (let pass = 0; pass < (both ? 2 : 1); pass++){
    const sx = pass ? -ex : ex, sy = pass ? -ey : ey;
    let ok = true;
    for (let k = 1; k <= 3 && ok; k++){
      const px = w.x + sx*50*k, py = w.y + sy*50*k;
      if (px < 34 || px > W - 34 || py < 34 || py > H - 34){ ok = false; break; }
      for (const d of debris)
        if (d.solid && !d.gone && !d.owner && HYPOT(px - d.x, py - d.y) < d.r + w.r + 6){ ok = false; break; }
    }
    if (ok) return [sx, sy];
  }
  return null;
}
// Somewhere at fighting range from `opp` that it can see them from and that is open ground
function bossFlank(w, opp, range){
  let best = null, bd = 1e9;
  const a0 = ATAN2(w.y - opp.y, w.x - opp.x);
  for (let k = 0; k < 12; k++){
    const a = a0 + (k - 5.5) * (TAU / 12);
    const c = { x: opp.x + COS(a)*range, y: opp.y + SIN(a)*range };
    if (c.x < 80 || c.x > W - 80 || c.y < 80 || c.y > H - 80) continue;
    if (debris.some(d => d.solid && !d.gone && !d.owner && HYPOT(c.x - d.x, c.y - d.y) < d.r + BOSS_R + 26)) continue;
    if (!lineClear(c, opp, true, 16)) continue;
    const dd = HYPOT(c.x - w.x, c.y - w.y);
    if (dd < bd){ bd = dd; best = c; }
  }
  return best;
}
// how far off it wants to stand: what its wands are holding, and how the fight is going
function bossRange(w){
  const B = w.boss;
  let r = (BOSS_RANGE[B.lock[0]] + BOSS_RANGE[B.lock[1]]) / 2;
  if (B.combo && B.wantFuse) r = (r + BOSS_RANGE_FUSED[B.combo.id]) / 2;
  if (w.hp < w.hpMax * .35) r += 50;                        // hurt: keep away
  if (w.target && w.target.mana < 22) r -= 50;              // they are dry: close in
  return r;
}
/* Threat response. It does not react at the frame the shot appears: it notices
   after a short lag (.06 - .16 s), then chooses, at most every quarter-second:
   drop the ward if the wand holding it can and what is coming is light enough to
   hold; dash out of the lane if it is heavy, unblockable or close and the dash is
   ready; otherwise sidestep. */
function bossReact(w, S, dt){
  const B = w.boss;
  B.dodge = Math.max(0, B.dodge - dt);
  B.coverCd = Math.max(0, B.coverCd - dt);
  B.hideT = Math.max(0, B.hideT - dt);
  B.actCd = Math.max(0, B.actCd - dt);
  if (!S || (!S.hit && !S.beam)){ B.alert = 0; return; }
  if (B.alert === 0) B.lag = rnd(.06, .16);
  B.alert += dt;
  if (B.alert < B.lag || B.actCd > 0) return;
  // a beam coming and no beam of its own to answer it: a mirror, not a sidestep
  if (S.beam && S.beamSrc && bossReflectReady(w)){ bossReflectOpen(w, S.beamSrc); B.dodge = 0; B.actCd = .3; return; }
  if (S.beam && !S.hit && B.refl){ B.dodge = 0; return; }        // and it stands behind it while it holds
  const t = S.beam ? Math.min(.5, S.soonest) : S.soonest;
  const heavy = S.weight - S.light >= 1 || S.weight >= 4;
  if (!S.beam && w.ward <= 3 && S.light >= 2 && S.light >= S.weight * .7 && t > .1 && w.mana >= BOSS_COST[3]){
    const wi = B.arms.findIndex((A, i) => bossLive(B, i) && A.spell === 3 && A.st === 0);
    if (wi >= 0){ B.arms[wi].force = true; B.arms[wi].t = Math.max(B.arms[wi].t, B.arms[wi].dur); B.actCd = .3; return; }
  }
  const dir = bossDashDir(w, S.ex, S.ey, S.beam);
  if (dir && w.dashCool <= 0 && !w.beamOn && t < (S.beam ? .7 : .34) && (heavy || S.beam || S.hit >= 3)){
    tryDash(w, dir[0], dir[1]);
    B.dashes++; B.dodge = .3; B.ex = dir[0]; B.ey = dir[1]; B.actCd = .3;
    return;
  }
  // once it has picked a way out it keeps to it: no flicking from one side to the other every few frames
  if (B.dodge > .2 && B.ex*S.ex + B.ey*S.ey < 0 && t > .3){ B.actCd = .15; return; }
  B.dodge = S.beam ? .8 : .5; B.ex = S.ex; B.ey = S.ey; B.dodges++; B.actCd = .2;
}
/* Where to be. Hold the range its spells want; circle, but never into a wall or a
   crate; go round a crate that is between it and its target instead of firing
   into it; step behind cover when it is hurt and under fire; and if the target
   crowds it, open the gap with a dash. */
function bossMove(w, opp, S, dt){
  const B = w.boss;
  B.strafeT -= dt;
  const dx = w.x - opp.x, dy = w.y - opp.y, d = HYPOT(dx, dy) || 1, ux = dx/d, uy = dy/d;
  const los = lineClear(w, opp, true, 16);
  B.blind = los ? 0 : B.blind + dt;
  const open = sg => {
    const px = w.x - uy*sg*140, py = w.y + ux*sg*140;
    return px > 90 && px < W - 90 && py > 90 && py < H - 90 &&
           !debris.some(q => q.solid && !q.gone && !q.owner && HYPOT(px - q.x, py - q.y) < q.r + 36);
  };
  if (B.strafeT <= 0){ if (rand() < .65) B.strafe = -B.strafe; B.strafeT = rnd(.9, 2.3); }
  if (!open(B.strafe) && open(-B.strafe)){ B.strafe = -B.strafe; B.strafeT = rnd(.8, 1.6); }

  const want = bossRange(w);
  const push = clamp((want - d) / 100, -1, 1);
  let ax = ux*push - uy*B.strafe*.9, ay = uy*push + ux*B.strafe*.9;

  // crowded: make room
  if (d < 165 && w.dashCool <= 0 && !w.beamOn && !B.fuse && B.dodge <= 0){
    const dir = bossDashDir(w, ux - uy*B.strafe*.5, uy + ux*B.strafe*.5, false);
    if (dir){ tryDash(w, dir[0], dir[1]); B.dashes++; }
  }
  // no way to shoot from here: find one
  if (B.blind > .45 && !B.goal && B.hideT <= 0){
    const g = bossFlank(w, opp, want);
    if (g){ B.goal = g; B.goalT = 1.8; B.flanking = true; }
  }
  if (B.flanking && los){ B.goal = null; B.flanking = false; }
  // hurt and under fire: get a crate between you
  if (S && S.hit && w.hp < w.hpMax * .4 && B.coverCd <= 0 && B.dodge <= 0){
    const spot = nearestCover(w, opp);
    if (spot){ B.goal = spot; B.goalT = 1.5; B.hideT = 1.8; B.coverCd = 5; B.flanking = false; }
  }
  // stuck on a crate? sample progress twice a second and pick somewhere open
  w.stuckT = (w.stuckT || 0) + dt;
  if (w.stuckT >= .5){
    const moved = HYPOT(w.x - (w.lastPX == null ? w.x : w.lastPX), w.y - (w.lastPY == null ? w.y : w.lastPY));
    if (moved < 10){
      w.stuckFor = (w.stuckFor || 0) + w.stuckT;
      if (w.stuckFor > 1.2){ const away = navPickOpen(w); if (away){ B.goal = away; B.goalT = 1.6; B.flanking = false; } w.stuckFor = 0; }
    } else w.stuckFor = 0;
    w.lastPX = w.x; w.lastPY = w.y; w.stuckT = 0;
  }
  if (B.goal && (B.goalT -= dt) > 0){
    const wp = HYPOT(B.goal.x - w.x, B.goal.y - w.y) < 60 ? null : navNext(w.x, w.y, B.goal.x, B.goal.y);
    ax = (wp ? wp.x : B.goal.x) - w.x; ay = (wp ? wp.y : B.goal.y) - w.y;
    if (HYPOT(B.goal.x - w.x, B.goal.y - w.y) < 30){ B.goal = null; B.flanking = false; }
  } else { B.goal = null; B.flanking = false; }
  // a sidestep overrides the rest, and the circling follows it round
  if (B.dodge > 0 && (B.ex || B.ey)){
    ax = ax*.3 + B.ex*3; ay = ay*.3 + B.ey*3;
    if ((B.ex * -uy + B.ey * ux) * B.strafe < 0) B.strafe = -B.strafe;
  }
  if (w.x < 90) ax += 1.4; if (w.x > W - 90) ax -= 1.4;
  if (w.y < 90) ay += 1.4; if (w.y > H - 90) ay -= 1.4;
  if (w.beamOn && w.beamWind >= byId.beam.cast){ ax *= .3; ay *= .3; }
  if (B.fuse){ ax *= .4; ay *= .4; }
  moveWizard(w, ax, ay, dt);
  // a beam is led: the wand swings to where the target is going, not where it was
  B.aim = null;
  if (w.beamOn && opp.dashT <= 0){
    const tt = clamp(d / 900, .2, .5) + .15;
    B.aim = ATAN2(opp.y + (opp.vy || 0)*tt - w.y, opp.x + (opp.vx || 0)*tt - w.x);
  }
}
function bossTick(w, opp, dt){
  const B = w.boss;
  // the arms: out (1) while their pair is working, behind the back (0) otherwise
  const working = B.phase === "live" || B.phase === "warn";
  const M = B.refl;
  for (let i = 0; i < 4; i++){
    const A = B.arms[i];
    // the two front hands raise the mirror, whichever pair is out: they come out from behind the back for it
    const mirArm = M && (i === 0 || i === 2);
    const live = working && bossLive(B, i);
    const want = live || mirArm ? 1 : 0;
    const rate = dt / (want ? (mirArm && !live ? .2 : BOSS_DRAW) : BOSS_HOLSTER);
    A.k = A.k < want ? Math.min(want, A.k + rate) : Math.max(want, A.k - rate);
    A.cf += ((A.st === 4 ? 1 : 0) - A.cf) * Math.min(1, dt * 8);
    if (mirArm){ A.rc += (1 - A.rc) * Math.min(1, dt * 14); A.rw = bossMirrorOpenK(M); }
    else { A.rc -= A.rc * Math.min(1, dt * 7); A.rw = Math.max(0, A.rw - dt * 5); }
    A.fired = Math.max(0, A.fired - dt);
  }
  B.fuseCd = Math.max(0, B.fuseCd - dt);
  const S = B.phase === "intro" ? null : bossSense(w);
  B.sense = S;
  bossReact(w, S, dt);

  if (B.phase === "intro"){
    B.pt -= dt;
    if (B.pt <= 0) bossSpin(w, false);
  } else if (B.phase === "spin"){
    B.pt -= dt;
    B.spinK = clamp(1 - B.pt / B.spinT, 0, 1);
    if (B.pt <= 0) bossBegin(w);
  } else if (!B.refl){
    // (while the mirror is up its hands are busy: every wand holds where it is, and nothing is cast, fused or changed over)
    // ---- the live wands
    for (let i = 0; i < 4; i++){
      const A = B.arms[i];
      if (A.st === 3 || A.st === 4 || A.st === 5 || !bossLive(B, i)) continue;
      if (A.st === 0){
        const t0 = A.t;
        A.t += dt;
        if (A.spell === 4 && t0 < 0 && A.t >= 0){           // the beam opens the moment its wand starts charging
          if (!w.beamOn && B.phase === "live" && w.mana >= BOSS_COST[4] + 6 && (!opp || lineClear(w, opp, false))){
            w.beamOn = true; w.beamWind = 0; w.charge = null; w.mana -= BOSS_COST[4];
          } else { A.t = -.4; A.dry += .4; }                 // not free, not paid for, or no clear line: try again in a moment
        }
        if (A.t >= A.dur){
          A.t = A.dur;
          // a full wand lets go if it can pay, has a line, and (for the wall) has a reason
          const need = A.spell === 4 && w.beamOn ? 0 : bossNeed(w, i);
          if (w.mana < need) A.dry += dt;
          else if (A.spell !== 3 && A.spell !== 4 && opp && !lineClear(w, opp, true, BOSS_PAD[A.spell])) A.dry += dt;
          else if (A.spell === 3 && !A.force && A.wait < 2.4 && w.ward <= 0){ A.wait += dt; }
          else bossRelease(w, i);
        }
      } else if (A.st === 1){
        A.held += dt;
        A.blind = (A.spell === 4 && opp && !lineClear(w, opp, false)) ? A.blind + dt : 0;
        if (A.spell === 4){
          if (B.prism){
            // a fused beam throws missiles from its tip once it is really firing
            if (w.beamWind >= byId.beam.cast && (B.prism.t -= dt) <= 0){
              B.prism.t += .2;
              bossMissile(w, i, { off: rnd(-.6, .6), kind: "swarm", color: w.beamTint,
                                  v0: 380, turn: 1.2, wob: .5, dmg: 5, r: 6, life: 3.4, glow: 18 });
            }
            // no wind-up to add back in: the lance was already live the instant it fused
            if (A.held >= BOSS_BEAM_HOLD || !w.beamOn || A.blind > .5) bossPrismEnd(w);
          } else if (A.held >= BOSS_BEAM_HOLD || !w.beamOn || A.blind > .5){ stopBeam(w, true); bossReload(w, i); }
        } else if (A.held >= BOSS_GRASP_HOLD || !w.held){
          if (w.held) throwHeld(w);
          bossReload(w, i);
        }
      } else if (A.st === 2){
        A.bt -= dt;
        if (A.bt <= 0){
          if (A.burst > 0){ bossShoot(w, i, 0, 0); A.burst--; A.bt = .1; }
          else bossReload(w, i);
        }
      }
    }
    // ---- a wand that has waited too long for mana or a clear shot: turn the hat and choose again
    if (B.phase === "live" && !B.fuse && B.arms.some((A, i) => bossLive(B, i) && A.dry > BOSS_DRY)){ B.phase = "warn"; B.pt = .3; }
    // ---- a chance to fuse is not only at a reload: while both wands are still early in their charge it looks, now and then
    if (B.phase === "live" && !B.fuse && B.combo && B.wantFuse && (B.look -= dt) <= 0){ B.look = BOSS_FUSE_LOOK; bossTryFuse(w, B.pair * 2); }
    // ---- two wands come together
    if (B.fuse){
      const F = B.fuse;
      F.t += dt;
      if (F.stage === 0){
        if (F.t >= BOSS_FUSE_CHARGE){ F.stage = 1; F.t = 0; B.flashN++; impact(w.x, w.y, 2.4, B.combo.color); }
      } else {
        F.flash = clamp(F.t / BOSS_FUSE_FLASH, 0, 1);
        if (F.t >= BOSS_FUSE_FLASH) bossCombo(w);
      }
    }
    // ---- shots that leave a beat apart
    if (B.q.length){
      const keep = [];
      for (const e of B.q){ e.t -= dt; if (e.t <= 0) bossMissile(w, e.arm, e); else keep.push(e); }
      B.q = keep;
    }
    // ---- the changeover
    if (B.phase === "warn"){
      B.pt = Math.max(0, B.pt - dt);
      B.wake = 1 - B.pt / .7;
      const busy = B.fuse || B.q.length || B.prism || B.arms.some((A, i) => bossLive(B, i) && (A.st === 1 || A.st === 2));
      if (B.pt <= 0 && !busy){
        // whatever was still winding up is dropped: the wands go back in their sheaths
        if (w.beamOn && w.beamWind < byId.beam.cast) stopBeam(w, true);
        bossSpin(w, true);
      }
    }
  }
  // each wand swings to the centre line while it holds the beam
  for (let i = 0; i < 4; i++){
    const A = B.arms[i];
    const want = (A.spell === 4 && A.st !== 3 && bossLive(B, i) && (A.st === 1 || A.t > 0)) ? 1 : 0;
    A.foc += (want - A.foc) * Math.min(1, dt * 9);
  }
  // the cone tip shows whichever live wand is closest to going off, or the colour of the fused spell
  let next = -1, best = -1;
  B.nextCol = null;
  if (B.phase === "live" || B.phase === "warn"){
    if (B.fuse) B.nextCol = B.combo.color;
    else for (let i = 0; i < 4; i++){
      const A = B.arms[i];
      if (!bossLive(B, i) || A.st === 3 || A.st === 5) continue;
      const k = A.st === 0 ? clamp(A.t / A.dur, 0, 1) : 1;
      if (k > best){ best = k; next = A.spell; }
    }
  }
  B.next = next;

  if (B.phase === "intro"){ w.vx = w.vy = 0; return; }
  bossMove(w, opp, S, dt);
}
// the boss turns to face you at a limited rate, and slower still while a beam is
// open — that is what makes its beam something you can step out of
function bossTurn(w, want, dt){
  const rate = (w.beamOn && w.beamWind >= byId.beam.cast) ? 1.0 : 5.5;
  return w.facing + clamp(angDiff(want, w.facing), -rate*dt, rate*dt);
}

/* ---------------------------------------------------------- damage */
function hurt(w, amount, by){
  if (w.dead || w.spawnSafe > 0) return;
  if (by && by !== w && !by.dead){
    by.dmg += amount;           // damage dealt, attributed to the attacker
    w.lastBy = by;              // and remembered for kill credit
  }
  w.hp -= amount;
  w.hurt = Math.min(1, w.hurt + amount/22);
  if (amount >= 3 && w.hitCool <= 0){
    hitSound(w, amount);
    w.hitCool = amount >= 14 ? .24 : .15;
  }
  shake = Math.min(shake + (REDUCED ? 0 : amount*0.18), 12);
  puff(w.x, w.y, "#ff4d5e", Math.min(20, 4 + amount|0));
  if (amount > 1.2) impact(w.x, w.y, amount/4.5, "#ff4d5e");
  if (w.hp <= 0){ w.hp = 0; w.dead = true; onDeath(w); }
}
/* ---------------------------------------------------------- the ward */
// A ward is a bank of damage hung in front of the wizard. Everything that would
// land on them goes through it first — a shot, a hurled crate, a beam grinding
// away — and the bank eats as much as it is still holding. Only the remainder
// reaches the wizard, so the blow that empties the wall is also the first blow
// that hurts, and it only hurts by what it had left over.
function wardFacing(w, sx, sy){
  if (!w || w.ward <= 0) return false;
  return COS(angDiff(ATAN2(sy - w.y, sx - w.x), w.facing)) > WARD_COS;
}
// `soak` marks damage arriving in sixty small pieces a second, so the wall
// sparks on a steady budget instead of once a frame.
function strike(w, amount, sx, sy, kind, soak, by){
  if (!w || w.dead || amount <= 0) return 0;
  if (!wardFacing(w, sx, sy)){ hurt(w, amount, by); return 0; }
  if (!WARD_BLOCKS[kind]){
    // heavier than the wall was ever rated for: straight through, and the wall
    // goes with it
    breakWard(w);
    hurt(w, amount, by);
    return 0;
  }
  const eaten = Math.min(w.ward, amount);
  w.ward -= eaten;
  if (soak){
    w.wardTick += eaten;
    if (w.wardTick >= 5){ w.wardTick = 0; puff(sx, sy, byId.ward.color, 4); }
  } else {
    swish(w, byId.ward.color);
    puff(sx, sy, byId.ward.color, 12);
  }
  if (w.ward <= 0) breakWard(w);
  const through = amount - eaten;
  if (through > 0) hurt(w, through, by);
  return eaten;
}
function breakWard(w){
  if (w.wardMax <= 0) return;
  w.ward = 0; w.wardMax = 0; w.wardFade = 0; w.wardTick = 0;
  puff(w.x, w.y, byId.ward.color, 18);
  impact(w.x, w.y, 3.2, byId.ward.color);
}

const SWISH_T = .3, FLICK_T = .19;
function swish(w, color, kind){
  if (!w || w.dead) return;
  w.swishKind = kind || "deflect";
  w.swishT0 = w.swishKind === "cast" ? FLICK_T : SWISH_T;
  w.swish = w.swishT0;
  w.swishDir = vrand() < .5 ? -1 : 1;
  w.swishColor = color || "#fff";
}
// one call for "something landed": shake, a shockwave ring, and for the heavy
// end of the scale a frame of hit-stop and a colour wash over the whole arena.
function impact(x, y, power, color){
  power = clamp(power, 0, 10);
  shake = Math.min(shake + (REDUCED ? power*0.25 : power*1.15), 16);
  rings.push({ x, y, r: 5 + power*1.5, max: 26 + power*11, t: 0,
               life: .3 + power*.035, color: color || "#fff", width: 1.4 + power*.5 });
  /* Hit-stop is SIMULATION, not decoration: it scales dt for the whole world in
     simStep. It must therefore happen identically on every machine.

     It used to sit behind `!REDUCED` — the operating system's "reduce motion"
     setting. Two people whose machines disagreed about that ran the same frames
     with different timesteps, so their worlds parted company on the first heavy
     hit and the relay stopped the match a few seconds in. Nothing about the
     network was wrong; the accessibility preference was in the simulation.

     Anything below this line that only affects what is DRAWN may still answer
     to REDUCED, because no other client depends on it. */
  if (power >= 3) hitStop = Math.max(hitStop, .035 + power*.007);
  if (power >= 3 && !REDUCED){
    flash = Math.max(flash, Math.min(.42, power*.05));
    flashColor = color || "#fff";
  }
}
// A counter that actually stops something feeds the wand: instant mana back
// plus a short burst of faster regeneration. Getting out-weighed pays nothing.
const SURGE_T = 3, SURGE_COLOR = "#ffd24a";
function surge(w, weight){
  if (!w || w.dead) return;
  w.counters++;                        // a successful counter that stopped something
  w.mana = clamp(w.mana + 6 + weight*7, 0, 100);
  w.surge = SURGE_T;                       // a clean counter is worth three full seconds
  rings.push({ x:w.x, y:w.y, r:12, max:40, t:0, life:.34, color:SURGE_COLOR, width:2 });
  for (let i = 0; i < 10; i++){
    const a = vrnd(0,TAU), sp = vrnd(50,150);
    bits.push({ x:w.x, y:w.y, vx:COS(a)*sp, vy:SIN(a)*sp, life:vrnd(.3,.6), t:0, color:SURGE_COLOR, r:vrnd(1,2.4) });
  }
}
function puff(x,y,color,n){
  if (REDUCED) n = Math.min(n, 4);
  for (let i = 0; i < n; i++){
    const a = vrand()*TAU, s = vrnd(30,220);
    bits.push({ x, y, vx: COS(a)*s, vy: SIN(a)*s, life: vrnd(.2,.6), t:0, color, r: vrnd(1,3) });
  }
}

/* ---------------------------------------------------------- update */
function update(dt){
  for (const w of wizards){
    if (w.dead) continue;
    if (w.lock && (w.lock.dead || w.lock.team === w.team)) w.lock = null;
    w.target = w.lock || nearestEnemy(w) || w.target;
  }
  const nf = nearestEnemy(you);
  if (nf) foe = nf;

  // ---- intent: humans from the keyboard, everyone else from aiTick
  for (const w of wizards){
    if (w.dead) continue;
    if (w.human){
      moveWizard(w, w.moveX || 0, w.moveY || 0, dt);
    } else if (w.target){
      if (w.boss) bossTick(w, w.target, dt); else aiTick(w, w.target, dt);
    }
  }

  for (const w of wizards){
    // the wand tracks what the wizard can see. Lose sight and it holds on the
    // last place they were, rather than following them through the wall.
    if (w.target){
      if (perceives(w, w.target)){
        w.seenX = w.target.x; w.seenY = w.target.y; w.seenT = 0;
        w.facing = w.boss ? bossTurn(w, w.boss.aim != null ? w.boss.aim : ATAN2(w.target.y - w.y, w.target.x - w.x), dt)
                          : ATAN2(w.target.y - w.y, w.target.x - w.x);
      } else if (w.seenX != null){
        w.facing = ATAN2(w.seenY - w.y, w.seenX - w.x);
      }
    }
    w.castLock = Math.max(0, w.castLock - dt);
    w.fizzle = Math.max(0, w.fizzle - dt);
    w.hurt = Math.max(0, w.hurt - dt*3);
    w.spawnSafe = Math.max(0, w.spawnSafe - dt);
    w.hitCool = Math.max(0, w.hitCool - dt);
    w.swish = Math.max(0, w.swish - dt);
    w.dashCool = Math.max(0, w.dashCool - dt);
    if (w.dashT > 0) w.dashT = Math.max(0, w.dashT - dt);
    const beamActive = w.beamOn && w.beamWind >= byId.beam.cast;
    w.surge = Math.max(0, w.surge - dt);
    w.beamBurn = Math.max(0, w.beamBurn - dt);
    if (w.surge > 0 && !REDUCED && vrand() < dt*26){
      const a = vrnd(0, TAU), rr = vrnd(16, 26);
      bits.push({ x: w.x + COS(a)*rr, y: w.y + SIN(a)*rr,
                  vx: COS(a)*vrnd(4,18), vy: SIN(a)*vrnd(4,18) - 22,
                  life: vrnd(.35,.7), t:0, color: SURGE_COLOR, r: vrnd(.9,2.1) });
    }
    const regen = ((w.charge !== null || beamActive) ? 6 : 17)
                * (w.D ? w.D.regen : 1)
                * (w.surge > 0 ? 2.2 : 1)
                * (w.beamBurn > 0 ? 0.4 : 1);
    w.mana = clamp(w.mana + regen*dt, 0, 100);
    if (w.charge !== null){
      const s = SPELLS[w.charge];
      w.chargeT = Math.min(w.chargeT + dt, s.maxChg);
    }
    if (w.ward > 0){
      w.ward -= w.wardFade * dt;
      if (w.ward <= 0){ w.ward = 0; w.wardMax = 0; w.wardFade = 0; }
    }
    if (w.beamOn){
      w.beamWind = Math.min(w.beamWind + dt, byId.beam.cast);
      if (w.beamWind >= byId.beam.cast){
        w.beamT += dt;
        w.mana -= byId.beam.cost * dt * (w.boss ? BOSS_BEAM_DRAIN : 1);
        if (w.mana <= 0){ w.mana = 0; stopBeam(w); }
      } else {
        w.mana -= 10*dt * (w.boss ? BOSS_BEAM_DRAIN : 1);
      }
    } else { w.beamT = 0; }
    const isPrism = !!(w.boss && w.beamTint);          // the Prism Lance has its own cue, not the ordinary beam's hum and drone
    const firing = w.beamOn && w.beamWind >= byId.beam.cast;
    if (firing !== w.beamSounding){
      if (!isPrism) beamSound(w, firing);
      w.beamSounding = firing;
      if (firing) swish(w, byId.beam.color, "cast");
    }
    const winding = w.beamOn && w.beamWind < byId.beam.cast;
    if (winding !== w.beamCharging){
      if (!isPrism) chargeSound(w, winding);
      w.beamCharging = winding;
    }
    if (winding && !REDUCED){
      // red motes drawn in out of the dark towards the wand
      const k = w.beamWind / byId.beam.cast;
      const tx = w.x + COS(w.facing)*24, ty = w.y + SIN(w.facing)*24;
      const n = 1 + (vrand()*3|0);
      for (let i = 0; i < n; i++){
        const ang = vrnd(0, TAU), rad = vrnd(18, 54) * (1.15 - k*0.55);
        const px = tx + COS(ang)*rad, py = ty + SIN(ang)*rad;
        const pull = 70 + k*210;
        bits.push({ x:px, y:py, vx:(tx-px)/rad*pull, vy:(ty-py)/rad*pull,
                    life: rad/pull * vrnd(.75,1.05), t:0,
                    color: vrand() < .22 ? "#ffd6df" : "#ff2b5c",
                    r: vrnd(.8, 2.2 + k) });
      }
    }
    // held debris orbit
    if (w.held){
      const d = w.held;
      const tx = w.x + COS(w.facing)*54, ty = w.y + SIN(w.facing)*54;
      d.x += (tx-d.x)*Math.min(1,dt*11); d.y += (ty-d.y)*Math.min(1,dt*11);
      d.a += dt*3;
      w.holdT += dt;
      w.mana -= 5*dt;
      if (w.mana <= 0){ w.mana = 0; d.owner = null; w.held = null; }
    }
  }

  /* ---- beams: the orb between two beams is a tug of war over mana */
  const firing = w => w.beamOn && w.beamWind >= byId.beam.cast && !w.dead;
  for (const w of wizards){
    w.beamLen = firing(w) ? beamReach(w) : 0;
    w.clash = false;
    w.clashOrb = null;
  }
  // the Prism Lance fizzles rather than glowing steady: sparks kicked off at random
  // points along its length, the whole time it is live
  if (!REDUCED) for (const w of wizards){
    if (!(w.boss && w.beamTint) || !firing(w)) continue;
    const n = 2 + (vrand()*3|0);
    for (let i = 0; i < n; i++){
      const t = vrand();
      const px = w.x + COS(w.facing)*w.beamLen*t, py = w.y + SIN(w.facing)*w.beamLen*t;
      const ang = vrnd(0, TAU), sp = vrnd(30, 150);
      bits.push({ x:px, y:py, vx:COS(ang)*sp, vy:SIN(ang)*sp, life: vrnd(.1, .28), t:0,
                  color: vrand() < .35 ? "#ffffff" : w.beamTint, r: vrnd(1, 2.6) });
    }
  }
  // the Alchemist's mirror: a beam that reaches the glass goes no further, and comes back
  for (const w of wizards) if (w.boss) bossMirrorStep(w, dt);
  const wasClashing = clashes;
  clashes = [];
  for (let i = 0; i < wizards.length; i++){
    const a = wizards[i];
    if (!firing(a) || a.clash) continue;
    for (let j = i+1; j < wizards.length; j++){
      const b = wizards[j];
      if (!firing(b) || b.clash || b.team === a.team) continue;
      const sep = dist(a, b);
      if (a.beamLen < sep-20 || b.beamLen < sep-20) continue;
      // are they actually pointed at each other?
      if (COS(a.facing)*(b.x-a.x) + SIN(a.facing)*(b.y-a.y) <= 0) continue;
      if (COS(b.facing)*(a.x-b.x) + SIN(b.facing)*(a.y-b.y) <= 0) continue;

      const prev = wasClashing.find(c => (c.a === a && c.b === b) || (c.a === b && c.b === a));
      let t = prev ? (prev.a === a ? prev.t : 1 - prev.t) : 0.5;
      const pA = beamPower(a), pB = beamPower(b);
      const target = pA / (pA + pB);
      const even = Math.abs(target - 0.5) < 0.045;
      // the orb slides, it never snaps: whoever has the mana walks it forward — except the
      // Prism Lance, which does not haggle at all: it is already through on the first frame
      const overwhelm = (a.boss && a.beamTint) || (b.boss && b.beamTint);
      const rate = overwhelm ? 1 : 0.5 * dt;
      t += clamp(target - t, -rate, rate);
      t = clamp(t, 0.04, 0.96);

      a.beamLen = sep*t; b.beamLen = sep*(1-t);
      a.clash = b.clash = true;
      // An evenly-matched orb shivers, but that is a look, not a fact: jittering
      // its real position here would put it somewhere different on a machine with
      // reduced motion turned on. The shiver is applied when it is drawn.
      const cx = a.x + (b.x - a.x)*t;
      const cy = a.y + (b.y - a.y)*t;
      const orb = { x: cx, y: cy, even, jit: even ? 4.5 : 0,
                    lead: target > .5 ? a : b, press: Math.abs(target - .5)*2 };
      a.clashOrb = b.clashOrb = orb;
      a.clashPt = b.clashPt = orb;
      clashes.push({ a, b, t, x: cx, y: cy });
      clashNowFlag = true;

      // the orb touching a wizard is far worse than being beamed
      const touch = Math.min(.34, (a.r + 16) / Math.max(1, sep));
      if (t < touch){
        hurt(a, 62*dt*dmgMul(b), b);
        a.vx -= COS(a.facing)*90*dt; a.vy -= SIN(a.facing)*90*dt;
        if (!REDUCED) puff(cx, cy, "#fff", 2);
      } else if (t > 1 - touch){
        hurt(b, 62*dt*dmgMul(a), a);
        b.vx -= COS(b.facing)*90*dt; b.vy -= SIN(b.facing)*90*dt;
        if (!REDUCED) puff(cx, cy, "#fff", 2);
      }

      if (!clashPrev){
        swish(a, byId.beam.color); swish(b, byId.beam.color);
        impact(cx, cy, 4.5, byId.beam.color);
        clashSound(true);
      }
      shake = Math.min(shake + (REDUCED ? 0 : (even ? 34 : 24)*dt), 7);
      if (!REDUCED){
        const n = 2 + (vrand()*3|0);
        for (let k = 0; k < n; k++){
          const ang = ATAN2(b.y-a.y, b.x-a.x) + Math.PI/2 * (vrand()<.5?1:-1) + vrnd(-.8,.8);
          const sp = vrnd(120,340);
          bits.push({ x:cx, y:cy, vx:COS(ang)*sp, vy:SIN(ang)*sp, life:vrnd(.15,.45), t:0,
                      color: vrand()<.4 ? "#ffffff" : byId.beam.color, r:vrnd(1,3) });
        }
      }
      break;
    }
  }
  // a clash that ended because both wizards let go simply comes apart
  for (const old of wasClashing){
    if (clashes.some(c => (c.a === old.a && c.b === old.b))) continue;
    const aF = firing(old.a), bF = firing(old.b);
    if (!aF && !bF){
      // both let go: the orb simply comes apart
      puff(old.x, old.y, byId.beam.color, 18);
      puff(old.x, old.y, "#ffffff", 8);
      rings.push({ x:old.x, y:old.y, r:8, max:52, t:0, life:.4, color:byId.beam.color, width:2 });
    } else if (aF !== bF){
      // one of them stopped resisting: the orb rides the surviving beam
      launchOrb(aF ? old.a : old.b, old.x, old.y);
    }
  }
  const clashNow = clashes.length > 0;
  if (clashPrev && !clashNow) clashSound(false);
  clashPrev = clashNow;
  // an unopposed beam burns whatever stands in it
  for (const w of wizards){
    if (!firing(w) || w.clash) continue;
    const ex = w.x + COS(w.facing)*w.beamLen, ey = w.y + SIN(w.facing)*w.beamLen;
    for (const o of wizards){
      if (o.dead || o.team === w.team) continue;
      // a ward is no answer to a beam: the beam burns straight through it
      if (segCircle(w.x, w.y, ex, ey, o.x, o.y, o.r + 4))
        strike(o, byId.beam.dmg*dt*dmgMul(w), w.x, w.y, "beam", true, w);
    }
  }
  // beams vaporize shots & chew crates
  for (const w of wizards){
    if (!firing(w)) continue;
    const ex = w.x + COS(w.facing)*w.beamLen, ey = w.y + SIN(w.facing)*w.beamLen;
    for (let i = shots.length-1; i >= 0; i--){
      const s = shots[i];
      if (s.owner === w) continue;
      if (segCircle(w.x,w.y,ex,ey,s.x,s.y,s.r+5)){
        puff(s.x,s.y,s.color,10); shots.splice(i,1);
      }
    }
    for (const d of debris){
      if (!d.gone && !d.owner && d.hp !== Infinity && segCircle(w.x,w.y,ex,ey,d.x,d.y,d.r)){
        // a prop in flight is fragile; one sitting on the floor takes its time
        d.hp -= dt * (d.thrown > 0 ? 20 : 9);
        if (d.thrown > 0){ d.vx *= (1 - dt*5); d.vy *= (1 - dt*5); }
        if (d.hp <= 0) breakProp(d);
      }
    }
  }

  /* ---- shots */
  for (let i = shots.length-1; i >= 0; i--){
    const s = shots[i];
    if (s.seek){
      const mark = s.owner.target;
      if (!mark) { s.seek = null; } else {
      const dd = HYPOT(mark.x - s.x, mark.y - s.y);
      const prox = clamp(1 - dd/560, 0, 1);
      const want = s.seek.vMin + (s.seek.vMax - s.seek.vMin) * prox * prox;
      s.seek.phase += dt*5.5;
      const desired = ATAN2(mark.y - s.y, mark.x - s.x) + SIN(s.seek.phase)*s.seek.wob*0.4;
      const cur = ATAN2(s.vy, s.vx);
      const step = clamp(angDiff(desired, cur), -s.seek.turn*dt, s.seek.turn*dt);
      const na = cur + step;
      s.vx = COS(na)*want; s.vy = SIN(na)*want;
      s.spin += dt*(s.ring ? 7 + prox*20 : 2.5 + prox*9);
      if (!REDUCED && vrand() < prox*0.5*(0.3 + (s.lvl||0)*0.9))
        bits.push({ x:s.x, y:s.y, vx:vrnd(-30,30), vy:vrnd(-30,30), life:vrnd(.2,.45), t:0, color:byId.hex.color, r:vrnd(1,2.4) });
      }
    }
    if (s.ring && (s.ring.t -= dt) <= 0){
      // the Alchemist's sparkwheel throws a ring of sparks off its rim as it comes. Each ring
      // is turned half a gap from the last, so the holes in it wander, and they come faster
      // the nearer the wheel gets.
      const R = s.ring, mk = s.owner.target;
      const prox = mk ? clamp(1 - HYPOT(mk.x - s.x, mk.y - s.y)/560, 0, 1) : 0;
      R.t += R.every * (1 - .6*prox);
      const off = s.spin + R.k * (Math.PI / R.n);
      for (let j = 0; j < R.n; j++){
        const a = off + j * TAU / R.n;
        shots.push({ x: s.x, y: s.y, vx: COS(a)*R.v, vy: SIN(a)*R.v, weight: 1, w0: 1, dmg: 5 * dmgMul(s.owner), r: 5.5,
                     color: s.color, kind: "spark", owner: s.owner, life: 1.7, trail: [], spin: 0, seek: null, glow: 14, lvl: 0, seq: shotSeq++ });
      }
      R.k++;
      rings.push({ x: s.x, y: s.y, r: s.r, max: s.r + 34, t: 0, life: .28, color: s.color, width: 1.8 });
    }
    s.trail.push({x:s.x, y:s.y});
    if (s.trail.length > 9) s.trail.shift();
    s.x += s.vx*dt; s.y += s.vy*dt;
    s.life -= dt;
    if (s.life <= 0 || s.x < -40 || s.x > W+40 || s.y < -40 || s.y > H+40){
      if (s.orb){ s.x = clamp(s.x, 8, W-8); s.y = clamp(s.y, 8, H-8); explodeOrb(s); }
      shots.splice(i,1); continue;
    }
    // debris
    let gone = false;
    for (const d of debris){
      if (d.gone || d.owner === s.owner) continue;
      if (!d.stopsShot) continue;
      if (dist2(s,d) < (d.r + s.r)*(d.r + s.r)){
        if (d.hp !== Infinity){
          d.hp -= s.weight;
          if (!d.owner){ d.vx += s.vx*0.06; d.vy += s.vy*0.06; }
          else swish(d.owner, s.color);
          if (d.hp <= 0) breakProp(d);
        }
        puff(s.x, s.y, d.chip, 6);
        puff(s.x, s.y, s.color, 8);
        if (s.orb) explodeOrb(s);
        shots.splice(i,1); gone = true; break;
      }
    }
    if (gone) continue;
    // shot vs shot
    for (let j = shots.length-1; j >= 0; j--){
      if (j === i || j >= shots.length) continue;
      const o = shots[j];
      if (!o || o.owner === s.owner) continue;
      if (dist2(s,o) < (s.r + o.r)*(s.r + o.r)){
        const cx = (s.x+o.x)/2, cy = (s.y+o.y)/2;
        let near = null, nd = Infinity;
        for (const q of wizards){
          const qd = (cx-q.x)*(cx-q.x) + (cy-q.y)*(cy-q.y);
          if (!q.dead && qd < nd){ nd = qd; near = q; }
        }
        swish(near, near === s.owner ? o.color : s.color);
        impact(cx, cy, (s.weight + o.weight) * .55, s.weight >= o.weight ? s.color : o.color);
        puff(cx, cy, "#ffffff", 8);
        puff(cx, cy, s.color, 6); puff(cx, cy, o.color, 6);
        if (s.weight > o.weight){
          surge(s.owner, o.weight);
          s.weight -= o.weight; s.dmg *= s.weight/s.w0 || .4;
          s.r = Math.max(5, s.r - o.weight*2.2);
          shots.splice(j,1);
          if (j < i) i--;
        } else if (o.weight > s.weight){
          surge(o.owner, s.weight);
          o.weight -= s.weight; o.dmg *= o.weight/o.w0 || .4;
          o.r = Math.max(5, o.r - s.weight*2.2);
          shots.splice(i,1); gone = true;
        } else {
          // Equal weight: nobody out-muscled anybody, so the tiebreak is who cast
          // theirs more recently. shotSeq is a strict firing order (never reused,
          // never tied), so exactly one of these two wins the exchange and takes
          // the whole mana bonus — the other gets nothing, same as losing outright.
          const laterOwner = (s.seq||0) > (o.seq||0) ? s.owner : o.owner;
          surge(laterOwner, s.weight);
          const hi = Math.max(i,j), lo = Math.min(i,j);
          shots.splice(hi,1); shots.splice(lo,1);
          if (lo < i) i--;
          gone = true;
        }
        break;
      }
    }
    if (gone) continue;
    // wizards
    let tgt = null;
    for (const q of wizards){
      if (q.dead || q.team === s.owner.team) continue;
      if (dist2(s,q) < (q.r + s.r)*(q.r + s.r)){ tgt = q; break; }
    }
    if (tgt){
      const held = wardFacing(tgt, s.x, s.y) && WARD_BLOCKS[s.kind];
      strike(tgt, s.dmg, s.x, s.y, s.kind, false, s.owner);
      if (held && tgt.ward > 0) surge(tgt, s.weight);   // the wall held
      if (s.orb) explodeOrb(s);
      shots.splice(i,1);
    }
  }

  /* ---- thrown debris */
  const propSnapshot = debris.slice();
  for (const d of propSnapshot){
    if (d.gone || d.owner) continue;
    if (d.thrown > 0){
      d.thrown -= dt;
      d.x += d.vx*dt; d.y += d.vy*dt;
      d.a += dt*6;
      d.vx *= (1 - dt*1.1); d.vy *= (1 - dt*1.1);
      if (d.x < d.r || d.x > W-d.r || d.y < d.r || d.y > H-d.r){
        d.x = clamp(d.x, d.r, W-d.r); d.y = clamp(d.y, d.r, H-d.r);
        d.vx = d.vy = 0; d.thrown = 0;
        puff(d.x, d.y, "#ffd24a", 8);
      }
      let tgt = null;
      if (d.thrower) for (const q of wizards){
        if (q.dead || q.team === d.thrower.team) continue;
        if (dist2(d,q) < (d.r + q.r)*(d.r + q.r)){ tgt = q; break; }
      }
      if (tgt && HYPOT(d.vx,d.vy) > 80){
        strike(tgt, byId.grasp.dmg * dmgMul(d.thrower), d.x, d.y, "prop", false, d.thrower);
        impact(d.x, d.y, 3.4, byId.grasp.color);
        d.vx = d.vy = 0; d.thrown = 0; d.hp -= 2;
        if (d.hp <= 0) { breakProp(d); continue; }
      }
      for (const o of debris){
        if (o === d || o.gone || o.owner || o.thrown > 0 || !o.solid) continue;
        if (dist2(d,o) < (d.r+o.r)*(d.r+o.r)){
          d.vx = d.vy = 0; d.thrown = 0;
          puff(d.x,d.y,"#ffd24a",6);
          if (o.hp !== Infinity){ o.hp -= 2; if (o.hp <= 0) breakProp(o); }
          d.hp -= 1; if (d.hp <= 0) breakProp(d);
          break;
        }
      }
    } else {
      d.vx *= (1-dt*4); d.vy *= (1-dt*4);
      d.x += d.vx*dt; d.y += d.vy*dt;
    }
  }

  /* ---- dash afterimages */
  for (let i = ghosts.length-1; i >= 0; i--){
    const g = ghosts[i];
    g.t += dt;
    if (g.t >= g.life) ghosts.splice(i,1);
  }

  /* ---- shockwave rings */
  for (let i = rings.length-1; i >= 0; i--){
    const r = rings[i];
    r.t += dt;
    if (r.t >= r.life) rings.splice(i,1);
  }

  /* ---- particles */
  for (let i = bits.length-1; i >= 0; i--){
    const b = bits[i];
    b.t += dt;
    if (b.t >= b.life){ bits.splice(i,1); continue; }
    b.x += b.vx*dt; b.y += b.vy*dt;
    b.vx *= (1-dt*2.4); b.vy *= (1-dt*2.4);
  }
  shake *= (1 - dt*5);
}
function angDiff(a,b){ let d = a-b; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; }
function breakProp(d){
  if (d.gone) return;
  d.gone = true;
  puff(d.x, d.y, d.chip || "#c9a06a", 22);
  impact(d.x, d.y, 1.4 + Math.min(3, d.r/12), d.chip || "#c9a06a");
  if (d.owner){ d.owner.held = null; d.owner = null; }
  const i = debris.indexOf(d);
  if (i >= 0) debris.splice(i,1);
  buildNav();   // a smashed crate is a doorway now
}

/* ---------------------------------------------------------- draw */
/* The vignette never changes, so it is built once and blitted after that.

   It used to build a radial gradient and fill the whole canvas EVERY frame,
   which is a full-screen gradient rasterisation sixty times a second to draw
   something that is identical every time. Cached, it costs one image blit.
   Rebuilt only if the arena is resized. */
let vignetteCv = null, vignetteW = 0, vignetteH = 0;
function vignette(){
  if (vignetteCv && vignetteW === W && vignetteH === H) return vignetteCv;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  const vg = g.createRadialGradient(W/2, H/2, H*0.32, W/2, H/2, H*0.92);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,.72)");
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  vignetteCv = cv; vignetteW = W; vignetteH = H;
  return cv;
}
function draw(){
  // --- light layer: fade what was there, then draw this frame's magic on top
  fxc.globalCompositeOperation = "destination-out";
  fxc.fillStyle = "rgba(0,0,0," + (REDUCED ? 1 : 0.28) + ")";
  fxc.fillRect(0, 0, W, H);
  fxc.globalCompositeOperation = "source-over";
  const main = ctx;
  ctx = fxc;
  // In fog you see the flash of a spell only where your own eyes reach: inside the
  // sight radius and with nothing solid in the way. Everything on this layer is
  // something happening in the world, so it all answers to the same question.
  // (`lit` is view-only — the simulation never asks it.)
  const dark = matchCfg.fog && you && !you.dead;
  const lit = o => !dark || canSee(you, o);
  for (const s of shots) if (lit(s)) drawShot(s);
  for (const w of wizards) if (w.beamOn && !w.dead && (w === you || lit(w))) drawBeam(w);
  for (const w of wizards) if (w.boss && w.boss.refl && !w.dead && (w === you || lit(w))) drawMirror(w);
  for (const g of ghosts) if (lit(g)) drawGhost(g);
  for (const r of rings) if (lit(r)) drawRing(r);
  for (const b of bits){
    if (!lit(b)) continue;
    const k = 1 - b.t/b.life;
    ctx.globalAlpha = k;
    ctx.fillStyle = b.color;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r*k + .5, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx = main;

  // --- solid layer
  ctx.save();
  if (shake > .2){
    ctx.translate(vrnd(-shake,shake), vrnd(-shake,shake));
    if (shake > 4){
      ctx.translate(W/2, H/2);
      ctx.rotate(vrnd(-shake,shake) * 0.0014);
      ctx.translate(-W/2, -H/2);
    }
  }
  ctx.drawImage(floor, 0, 0);
  // the permanent scenery is already in the floor image; only the things that
  // can break, burn or be thrown are worth redrawing
  for (const d of debris) if (!bakedProp(d)) drawDebris(d);
  if (you.lock && !you.lock.dead){
    const t = you.lock;
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(performance.now()/1400);
    ctx.strokeStyle = you.tint;
    ctx.shadowColor = you.tint; ctx.shadowBlur = 10;
    ctx.lineWidth = 2;
    for (let q = 0; q < 4; q++){
      const a0 = q*TAU/4 + .34, a1 = a0 + .55;
      ctx.beginPath(); ctx.arc(0, 0, 27, a0, a1); ctx.stroke();
    }
    ctx.restore();
  }
  const fog = matchCfg.fog && you && !you.dead;
  for (const w of wizards) if (w !== you && !w.dead && !(fog && !canSee(you, w))) drawWizard(w);
  if (!you.dead) drawWizard(you);

  let windK = 0;
  for (const w of wizards)
    if (w.beamOn && w.beamWind < byId.beam.cast)
      windK = Math.max(windK, w.beamWind / byId.beam.cast);
  if (windK > 0){
    ctx.fillStyle = "rgba(4,2,9," + (0.34*windK).toFixed(3) + ")";
    ctx.fillRect(0, 0, W, H);
  }

  ctx.globalCompositeOperation = "lighter";
  ctx.drawImage(fx, 0, 0);
  ctx.globalCompositeOperation = "source-over";

  ctx.drawImage(vignette(), 0, 0);
  ctx.restore();

  // Fog of war. Not a vignette: the lit region is the sight radius MINUS the
  // shadow every solid thing throws away from you, so you genuinely cannot see
  // around a corner. Built on its own layer — fill it dark, cut the radius out,
  // then paint the darkness back into each wall's shadow.
  if (matchCfg.fog && you && !you.dead){
    const fr = Math.max(80, FOG_R * mapScale());
    const SHADE = "rgba(3,2,8,0.94)";
    const g = fogC;
    g.setTransform(1,0,0,1,0,0);
    g.globalCompositeOperation = "source-over";
    g.clearRect(0,0,W,H);
    g.fillStyle = SHADE; g.fillRect(0,0,W,H);

    g.globalCompositeOperation = "destination-out";
    const rg = g.createRadialGradient(you.x, you.y, fr*0.55, you.x, you.y, fr);
    rg.addColorStop(0,"rgba(0,0,0,1)");
    rg.addColorStop(1,"rgba(0,0,0,0)");
    g.fillStyle = rg; g.fillRect(0,0,W,H);

    g.globalCompositeOperation = "source-over";
    g.fillStyle = SHADE;
    const FAR = fr * 2.2;
    for (const d of debris){
      if (d.gone || d.owner || !blocksBeam(d)) continue;
      const dx = d.x - you.x, dy = d.y - you.y;
      const dd = HYPOT(dx, dy);
      if (dd <= d.r + 2 || dd - d.r > fr) continue;   // standing in it, or past the light
      // the two tangent rays from the eye graze the prop; everything beyond them is dark
      const a = ATAN2(dy, dx);
      const sp = Math.asin(Math.min(1, d.r / dd));
      const L = Math.sqrt(Math.max(1, dd*dd - d.r*d.r));
      const a1 = a - sp, a2 = a + sp;
      g.beginPath();
      g.moveTo(you.x + COS(a1)*L,   you.y + SIN(a1)*L);
      g.lineTo(you.x + COS(a1)*FAR, you.y + SIN(a1)*FAR);
      g.lineTo(you.x + COS(a2)*FAR, you.y + SIN(a2)*FAR);
      g.lineTo(you.x + COS(a2)*L,   you.y + SIN(a2)*L);
      g.closePath(); g.fill();
    }
    ctx.drawImage(fogCv, 0, 0);
    // a faint visible boundary so the edge of the world reads as fog, not void
    ctx.strokeStyle = "rgba(160,150,220,0.10)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(you.x, you.y, fr*0.98, 0, TAU); ctx.stroke();
  }

  drawBossBar();

  if (flash > 0.004){
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = flash;
    ctx.fillStyle = flashColor;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  if (msg && msg.t > 0){
    ctx.save();
    ctx.globalAlpha = clamp(msg.t, 0, 1);
    ctx.textAlign = "center";
    ctx.font = "900 46px Cinzel, Georgia, serif";
    ctx.fillStyle = msg.color;
    ctx.shadowColor = msg.color; ctx.shadowBlur = 30;
    ctx.fillText(msg.text.toUpperCase(), W/2, H/2 - 8);
    if (msg.sub){
      ctx.shadowBlur = 0;
      ctx.font = "400 15px 'IBM Plex Mono', monospace";
      ctx.fillStyle = "#c4bade";
      ctx.fillText(msg.sub, W/2, H/2 + 26);
    }
    ctx.restore();
  }
}

function drawGhost(g){
  const k = 1 - g.t/g.life;
  const tint = g.tint || (g.friendly ? "#7ee9ff" : "#ff9d6b");
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.translate(g.x, g.y);
  ctx.rotate(g.facing);
  if (g.sc) ctx.scale(g.sc, g.sc);
  ctx.globalAlpha = k * .5;
  ctx.strokeStyle = tint;
  ctx.shadowColor = tint; ctx.shadowBlur = 12;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(16, 0); ctx.lineTo(-10, -13); ctx.lineTo(-6, 0); ctx.lineTo(-10, 13);
  ctx.closePath(); ctx.stroke();
  ctx.restore();
}
function drawRing(r){
  const k = r.t / r.life;
  const rad = r.r + (r.max - r.r) * (1 - (1-k)*(1-k));
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = (1 - k) * .85;
  ctx.strokeStyle = r.color;
  ctx.shadowColor = r.color; ctx.shadowBlur = 14;
  ctx.lineWidth = Math.max(.6, r.width * (1 - k));
  ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, TAU); ctx.stroke();
  ctx.restore();
}
function drawDebris(d){
  const P = PROPS[d.type];
  const held = !!d.owner;
  const worn = d.hp === Infinity ? 1 : clamp(d.hp / P.hp, 0, 1);
  ctx.save();
  ctx.translate(d.x, d.y);

  // solid things sit on the floor and cast a shadow; furniture you can step
  // over is drawn lighter, so cover reads at a glance
  if (d.solid){
    ctx.fillStyle = "rgba(0,0,0,.45)";
    ctx.beginPath(); ctx.ellipse(3, 4, d.r*.95, d.r*.85, 0, 0, TAU); ctx.fill();
  }
  ctx.rotate(d.a);
  if (!d.solid) ctx.globalAlpha = .82;

  const line = d.chip;
  switch (d.type){
    case "stone": {
      ctx.beginPath();
      for (let i = 0; i < 7; i++){
        const ang = i/7*TAU;
        const rr = d.r * (0.82 + 0.22*SIN(d.seed + i*2.1));
        ctx[i?"lineTo":"moveTo"](COS(ang)*rr, SIN(ang)*rr);
      }
      ctx.closePath();
      ctx.fillStyle = "#231d33"; ctx.fill();
      ctx.strokeStyle = "#3a3154"; ctx.lineWidth = 2; ctx.stroke();
      ctx.strokeStyle = "rgba(169,124,255,.16)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(0,0,d.r*.55,d.seed,d.seed+2.2); ctx.stroke();
      break;
    }
    case "pillar": {
      ctx.fillStyle = "#241e36"; ctx.strokeStyle = "#463b64"; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(0,0,d.r,0,TAU); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = "rgba(169,124,255,.28)"; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(0,0,d.r*.62,0,TAU); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-d.r*.62,0); ctx.lineTo(d.r*.62,0);
      ctx.moveTo(0,-d.r*.62); ctx.lineTo(0,d.r*.62);
      ctx.stroke();
      break;
    }
    case "lattice": {
      // an open wooden screen: shots go through the gaps, bodies and beams do not
      const t = d.r*0.95;
      ctx.strokeStyle = line; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.rect(-t, -t, t*2, t*2); ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.globalAlpha *= .8;
      for (let i = -2; i <= 2; i++){
        const o = i * t * 0.5;
        ctx.beginPath(); ctx.moveTo(-t, o); ctx.lineTo(t, o); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(o, -t); ctx.lineTo(o, t); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      break;
    }
    /* ---- forest ------------------------------------------------------ */
    case "tree": {
      // seen from above: a canopy of overlapping leaf clumps with the trunk
      // showing through the middle. Unbreakable, so it is permanent cover.
      ctx.fillStyle = "#2a1c14";
      ctx.beginPath(); ctx.arc(0, 0, d.r*0.30, 0, TAU); ctx.fill();
      for (let i = 0; i < 6; i++){
        const ang = d.seed + i/6*TAU;
        const rr = d.r * (0.46 + 0.12*SIN(d.seed*2 + i*1.7));
        const cx = COS(ang)*d.r*0.46, cy = SIN(ang)*d.r*0.46;
        ctx.fillStyle = i % 2 ? "#31532a" : "#24401f";
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, TAU); ctx.fill();
      }
      ctx.fillStyle = "#3e6634";
      ctx.beginPath(); ctx.arc(-d.r*0.16, -d.r*0.18, d.r*0.42, 0, TAU); ctx.fill();
      ctx.strokeStyle = line; ctx.globalAlpha *= .45; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(0, 0, d.r*0.86, 0, TAU); ctx.stroke();
      ctx.globalAlpha = d.solid ? 1 : .82;
      break;
    }
    case "bush": {
      // hides you without stopping anything: shots pass straight through
      const clumps = 5;
      for (let i = 0; i < clumps; i++){
        const ang = d.seed + i/clumps*TAU;
        const cx = COS(ang)*d.r*0.42, cy = SIN(ang)*d.r*0.42;
        ctx.fillStyle = i % 2 ? "#1f3a22" : "#27492a";
        ctx.beginPath(); ctx.arc(cx, cy, d.r*0.52, 0, TAU); ctx.fill();
      }
      ctx.strokeStyle = line; ctx.globalAlpha *= .5; ctx.lineWidth = 1.2;
      for (let i = 0; i < 7; i++){
        const ang = d.seed*1.7 + i/7*TAU, rr = d.r*(0.5 + 0.35*SIN(d.seed+i));
        ctx.beginPath();
        ctx.moveTo(COS(ang)*rr*0.4, SIN(ang)*rr*0.4);
        ctx.lineTo(COS(ang)*rr, SIN(ang)*rr);
        ctx.stroke();
      }
      ctx.globalAlpha = d.solid ? 1 : .82;
      break;
    }
    case "log": {
      const L = d.r*1.15, T = d.r*0.52;
      ctx.fillStyle = "#2e2015"; ctx.strokeStyle = line; ctx.lineWidth = 2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(-L, -T, L*2, T*2, T*0.7);
      else ctx.rect(-L, -T, L*2, T*2);
      ctx.fill(); ctx.stroke();
      // the cut ends, with rings
      for (const sx of [-1, 1]){
        ctx.fillStyle = "#4a361f";
        ctx.beginPath(); ctx.ellipse(sx*L*0.94, 0, T*0.36, T*0.86, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,.35)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(sx*L*0.94, 0, T*0.2, T*0.5, 0, 0, TAU); ctx.stroke();
      }
      ctx.strokeStyle = "rgba(0,0,0,.3)"; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(-L*0.7, -T*0.3); ctx.lineTo(L*0.7, -T*0.3); ctx.stroke();
      break;
    }
    case "stump": {
      ctx.fillStyle = "#3d2c1c"; ctx.strokeStyle = line; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.arc(0, 0, d.r, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#5a4227";
      ctx.beginPath(); ctx.arc(0, 0, d.r*0.78, 0, TAU); ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,.3)"; ctx.lineWidth = 1;
      for (let i = 1; i <= 3; i++){
        ctx.beginPath(); ctx.arc(0, 0, d.r*0.78*(i/3.4), 0, TAU); ctx.stroke();
      }
      break;
    }

    /* ---- castle ------------------------------------------------------ */
    case "statue": {
      // a figure on a plinth, robed and facing its own way
      ctx.fillStyle = "#22243a"; ctx.strokeStyle = "#4b4f70"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, d.r, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#5d6289";
      ctx.beginPath();
      ctx.moveTo(d.r*0.5, 0);
      ctx.quadraticCurveTo(0, d.r*0.66, -d.r*0.55, 0);
      ctx.quadraticCurveTo(0, -d.r*0.66, d.r*0.5, 0);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#8e93b8";
      ctx.beginPath(); ctx.arc(0, 0, d.r*0.26, 0, TAU); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.16)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(0, 0, d.r*0.72, 0, TAU); ctx.stroke();
      break;
    }
    case "brazier": {
      // beams pass over an open fire bowl; shots do not
      ctx.fillStyle = "#1e1b28"; ctx.strokeStyle = "#4a4358"; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.arc(0, 0, d.r, 0, TAU); ctx.fill(); ctx.stroke();
      // the flame breathes on view time — never on the seeded clock
      const flick = 0.82 + 0.18*SIN(performance.now()/150 + d.seed*6);
      ctx.fillStyle = "#5a2a10";
      ctx.beginPath(); ctx.arc(0, 0, d.r*0.66, 0, TAU); ctx.fill();
      ctx.fillStyle = "#ff8a2b";
      ctx.beginPath(); ctx.arc(0, 0, d.r*0.5*flick, 0, TAU); ctx.fill();
      ctx.fillStyle = "#ffd88a";
      ctx.beginPath(); ctx.arc(0, 0, d.r*0.26*flick, 0, TAU); ctx.fill();
      break;
    }
    case "chest": {
      const tw = d.r*0.92, th = d.r*0.66;
      ctx.fillStyle = "#2b1d12"; ctx.strokeStyle = line; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.rect(-tw, -th, tw*2, th*2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = line; ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-tw, -th*0.2); ctx.lineTo(tw, -th*0.2);
      ctx.moveTo(-tw*0.45, -th); ctx.lineTo(-tw*0.45, th);
      ctx.moveTo(tw*0.45, -th); ctx.lineTo(tw*0.45, th);
      ctx.stroke();
      ctx.fillStyle = line;
      ctx.beginPath(); ctx.arc(0, 0, 2.4, 0, TAU); ctx.fill();
      break;
    }
    case "rubble": {
      // knocked-out masonry: a scatter of chunks you can pick up and throw
      for (let i = 0; i < 4; i++){
        const ang = d.seed + i*1.9;
        const cx = COS(ang)*d.r*0.4, cy = SIN(ang)*d.r*0.4;
        const rr = d.r*(0.3 + 0.16*SIN(d.seed + i*2.3));
        ctx.fillStyle = i % 2 ? "#2b2a3d" : "#35334a";
        ctx.beginPath();
        ctx.moveTo(cx + rr, cy);
        ctx.lineTo(cx, cy + rr*0.9);
        ctx.lineTo(cx - rr*0.9, cy);
        ctx.lineTo(cx, cy - rr*0.8);
        ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = line; ctx.globalAlpha *= .4; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(0, 0, d.r*0.8, 0, TAU); ctx.stroke();
      ctx.globalAlpha = d.solid ? 1 : .82;
      break;
    }

    case "crate": {
      const t = d.r*0.82;
      ctx.fillStyle = "#33261a"; ctx.strokeStyle = line; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.rect(-t,-t,t*2,t*2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-t,-t); ctx.lineTo(t,t); ctx.moveTo(t,-t); ctx.lineTo(-t,t); ctx.stroke();
      break;
    }
    case "barrel": {
      ctx.fillStyle = "#2a1f16"; ctx.strokeStyle = line; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0,0,d.r,0,TAU); ctx.fill(); ctx.stroke();
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(0,0,d.r*.6,0,TAU); ctx.stroke();
      for (let i = 0; i < 4; i++){
        const ang = i/4*TAU + .4;
        ctx.beginPath();
        ctx.moveTo(COS(ang)*d.r*.6, SIN(ang)*d.r*.6);
        ctx.lineTo(COS(ang)*d.r, SIN(ang)*d.r);
        ctx.stroke();
      }
      break;
    }
    case "table": {
      const tw = d.r*1.5, th = d.r*1.0;
      ctx.fillStyle = "#241a12"; ctx.strokeStyle = line; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.rect(-tw,-th,tw*2,th*2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = line; ctx.globalAlpha *= .7;
      for (const [lx,ly] of [[-1,-1],[1,-1],[-1,1],[1,1]]){
        ctx.beginPath(); ctx.arc(lx*(tw-5), ly*(th-5), 2.2, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = d.solid ? 1 : .82;
      ctx.strokeStyle = "rgba(255,255,255,.07)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-tw+4, 0); ctx.lineTo(tw-4, 0); ctx.stroke();
      break;
    }
    case "shelf": {
      const tw = d.r*1.5, th = d.r*0.55;
      ctx.fillStyle = "#1f1710"; ctx.strokeStyle = line; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.rect(-tw,-th,tw*2,th*2); ctx.fill(); ctx.stroke();
      const books = ["#7a4a5c","#4a5f7a","#6b6a3c","#5c3f6b","#3f6b5c","#7a5a3c"];
      const n = 6, bw = (tw*2 - 8) / n;
      for (let i = 0; i < n; i++){
        ctx.fillStyle = books[(i + ((d.seed*10)|0)) % books.length];
        const h = th*2 - 7 - (i % 3);
        ctx.fillRect(-tw + 4 + i*bw + 1, -th + 3, bw - 2, h);
      }
      break;
    }
    case "urn": {
      ctx.fillStyle = "#1c242e"; ctx.strokeStyle = line; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0,0,d.r,0,TAU); ctx.fill(); ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(0,0,d.r*.5,0,TAU); ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,.22)";
      ctx.beginPath(); ctx.arc(0,0,d.r*.78, -2.5, -1.4); ctx.stroke();
      break;
    }
    case "chair": {
      const t = d.r*0.72;
      ctx.fillStyle = "#241a12"; ctx.strokeStyle = line; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.rect(-t,-t,t*2,t*2); ctx.fill(); ctx.stroke();
      ctx.lineWidth = 2.6;
      ctx.beginPath(); ctx.moveTo(-t, -t-3); ctx.lineTo(t, -t-3); ctx.stroke();
      ctx.fillStyle = line;
      for (const [lx,ly] of [[-1,-1],[1,-1],[-1,1],[1,1]]){
        ctx.beginPath(); ctx.arc(lx*t*.8, ly*t*.8, 1.5, 0, TAU); ctx.fill();
      }
      break;
    }
    case "stool": {
      ctx.fillStyle = "#241a12"; ctx.strokeStyle = line; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(0,0,d.r*.85,0,TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = line;
      for (let i = 0; i < 3; i++){
        const ang = d.seed + i/3*TAU;
        ctx.beginPath(); ctx.arc(COS(ang)*d.r*.6, SIN(ang)*d.r*.6, 1.6, 0, TAU); ctx.fill();
      }
      break;
    }
  }

  // damage shows as cracks before it shows as splinters
  if (worn < 1){
    ctx.globalAlpha *= .8;
    ctx.strokeStyle = "rgba(255,90,90," + (0.25 + (1-worn)*0.5).toFixed(2) + ")";
    ctx.lineWidth = 1.3;
    const cracks = Math.ceil((1 - worn) * 3);
    for (let i = 0; i < cracks; i++){
      const ang = d.seed + i*2.3;
      ctx.beginPath();
      ctx.moveTo(COS(ang)*d.r*.15, SIN(ang)*d.r*.15);
      ctx.lineTo(COS(ang+.4)*d.r*.6, SIN(ang+.4)*d.r*.6);
      ctx.lineTo(COS(ang)*d.r*.9, SIN(ang)*d.r*.9);
      ctx.stroke();
    }
  }

  if (held){
    ctx.globalAlpha = 1;
    ctx.shadowColor = byId.grasp.color; ctx.shadowBlur = 18;
    ctx.strokeStyle = "rgba(255,210,74,.75)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, d.r + 3, 0, TAU); ctx.stroke();
  }
  ctx.restore();
}

function drawShot(s){
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < s.trail.length; i++){
    const p = s.trail[i], k = i/s.trail.length;
    ctx.globalAlpha = k*0.35;
    ctx.fillStyle = s.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, s.r*k*0.8, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // the bolt itself and its white heart, both from the sprite cache
  blitSprite(glowSprite(s.color, s.r, s.glow || 22), s.x, s.y);
  blitSprite(glowSprite("#ffffff", s.r*0.42, 8, s.color), s.x, s.y);
  if (s.kind === "wheel"){
    // a spoked wheel, turning fast: nine spokes with a bead on each tip, a rim, and a
    // counter-turning hexagon inside. The rings of sparks leave from the spoke tips.
    ctx.translate(s.x, s.y);
    ctx.rotate(s.spin);
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = 2;
    ctx.globalAlpha = .95;
    ctx.beginPath();
    for (let j = 0; j < 9; j++){
      const a = j * TAU / 9;
      ctx.moveTo(COS(a)*s.r*.55, SIN(a)*s.r*.55); ctx.lineTo(COS(a)*s.r*1.75, SIN(a)*s.r*1.75);
    }
    ctx.stroke();
    for (let j = 0; j < 9; j++){
      const a = j * TAU / 9;
      ctx.beginPath(); ctx.arc(COS(a)*s.r*1.95, SIN(a)*s.r*1.95, 2.6, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = .7; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(0, 0, s.r*1.25, 0, TAU); ctx.stroke();
    ctx.rotate(-s.spin * 2.3);
    ctx.globalAlpha = .85;
    ctx.beginPath();
    for (let j = 0; j < 6; j++){ const a = j / 6 * TAU; ctx[j ? "lineTo" : "moveTo"](COS(a)*s.r*.8, SIN(a)*s.r*.8); }
    ctx.closePath(); ctx.stroke();
    ctx.globalAlpha = 1;
  } else if (s.seek && s.kind === "hex" && s.lvl > .4){
    ctx.translate(s.x, s.y);
    ctx.rotate(s.spin);
    ctx.strokeStyle = s.color; ctx.lineWidth = 1 + s.lvl; ctx.globalAlpha = .35 + s.lvl*.55;
    ctx.beginPath();
    for (let i = 0; i < 6; i++){
      const ang = i/6*TAU, rr = s.r*1.5;
      ctx[i?"lineTo":"moveTo"](COS(ang)*rr, SIN(ang)*rr);
    }
    ctx.closePath(); ctx.stroke();
    ctx.globalAlpha = .2 + s.lvl*.3;
    ctx.beginPath(); ctx.arc(0, 0, s.r*1.9, s.spin, s.spin + 2.4); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  // weight ticks
  if (s.weight > 1){
    ctx.save();
    ctx.globalAlpha = .85;
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.4;
    for (let i = 0; i < s.weight; i++){
      const a = -Math.PI/2 + (i - (s.weight-1)/2)*0.42;
      ctx.beginPath();
      ctx.moveTo(s.x + COS(a)*(s.r+4), s.y + SIN(a)*(s.r+4));
      ctx.lineTo(s.x + COS(a)*(s.r+9), s.y + SIN(a)*(s.r+9));
      ctx.stroke();
    }
    ctx.restore();
  }
}

function jag(x1,y1,x2,y2,segs,amp){
  const pts = [];
  const dx = x2-x1, dy = y2-y1, L = HYPOT(dx,dy) || 1;
  const nx = -dy/L, ny = dx/L;
  for (let i = 0; i <= segs; i++){
    const t = i/segs;
    const taper = SIN(t*Math.PI);
    const off = (vrand()*2-1) * amp * taper;
    pts.push(x1 + dx*t + nx*off, y1 + dy*t + ny*off);
  }
  return pts;
}
/* ---------------------------------------------------- pre-rendered glow

   A blurred fill is one of the most expensive things you can ask a 2D canvas
   for: the rasteriser draws the shape, blurs a copy of it, and composites
   both. Doing that ninety times a frame is what put a full room of Archmages
   at five frames a second — not the bots' thinking, which measured at barely
   one millisecond.

   So the small glowing things that repeat — cloak jewels, beam motes — are
   rendered ONCE into a little offscreen canvas, blur and all, and blitted from
   then on. Identical picture, and a blit is close to free. The caches are keyed
   by colour and size and stay tiny: a dozen jewel colours at a handful of sizes.

   View-only, like everything else here: no seeded RNG, nothing the simulation
   reads. */
const glowCache = new Map(), jewelCache = new Map();
function makeSprite(size, paint){
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const g = cv.getContext("2d");
  if (g) paint(g, size / 2);
  return cv;
}
// a soft round glow, the way a shadowed arc looks
function glowSprite(color, radius, blur, glowColor){
  const r = Math.max(0.5, Math.round(radius * 2) / 2);
  const b = Math.round(blur);
  const halo = glowColor || color;
  const key = color + "|" + halo + "|" + r + "|" + b;
  let cv = glowCache.get(key);
  if (!cv){
    cv = makeSprite(Math.ceil((r + b) * 2) + 4, (g, c) => {
      g.shadowColor = halo; g.shadowBlur = b;
      g.fillStyle = color;
      g.beginPath(); g.arc(c, c, r, 0, TAU); g.fill();
    });
    glowCache.set(key, cv);
  }
  return cv;
}
/* The cut of a stone.

   Each entry in the GEMS ladder (src/account.js) names a shape, and the ladder
   is ordered so the cuts get more elaborate as you climb: a plain bar at level
   two, an eight-pointed sigil at forty. The same function draws them on a cape
   and in the menu's jewel track, so what somebody is climbing towards is
   exactly what they will end up wearing.

   Traced around the origin at radius `s`. A shape that reads as an outline
   rather than a solid — the ring — says so by returning "stroke". */
function poly(g, n, r, rot){
  g.beginPath();
  for (let i = 0; i < n; i++){
    const a = rot + i * TAU / n;
    g[i ? "lineTo" : "moveTo"](COS(a) * r, SIN(a) * r);
  }
  g.closePath();
}
function starPath(g, points, outer, inner, rot){
  g.beginPath();
  for (let i = 0; i < points * 2; i++){
    const r = i % 2 ? inner : outer;
    const a = rot + i * Math.PI / points;
    g[i ? "lineTo" : "moveTo"](COS(a) * r, SIN(a) * r);
  }
  g.closePath();
}
function jewelPath(g, s, shape){
  switch (shape){
    case "bar":      g.beginPath(); g.rect(-s * 1.35, -s * 0.42, s * 2.7, s * 0.84); return "fill";
    case "dot":      g.beginPath(); g.arc(0, 0, s * 0.86, 0, TAU); return "fill";
    case "square":   g.beginPath(); g.rect(-s * 0.78, -s * 0.78, s * 1.56, s * 1.56); return "fill";
    case "pentagon": poly(g, 5, s * 0.98, -Math.PI / 2); return "fill";
    case "triangle": poly(g, 3, s * 1.05, 0); return "fill";
    // a bite taken out of a disc — the one silhouette here that is unmistakable
    // at four pixels across
    case "crescent": g.beginPath();
                     g.arc(0, 0, s * 0.95, Math.PI * 0.42, -Math.PI * 0.42);
                     g.arc(s * 0.62, 0, s * 0.78, -Math.PI * 0.58, Math.PI * 0.58, true);
                     g.closePath(); return "fill";
    case "hex":      poly(g, 6, s * 0.95, 0); return "fill";
    case "ring":     g.beginPath(); g.arc(0, 0, s * 0.72, 0, TAU); return "stroke";
    case "spark":    starPath(g, 4, s * 1.15, s * 0.34, 0); return "fill";
    case "star":     starPath(g, 6, s * 1.1, s * 0.46, 0); return "fill";
    case "halo":     g.beginPath(); g.arc(0, 0, s * 0.5, 0, TAU); return "fill+ring";
    case "sigil":    starPath(g, 8, s * 1.2, s * 0.44, 0); return "fill+dot";
    default:         poly(g, 6, s * 0.95, 0); return "fill";
  }
}
// Paint one jewel at the origin. Used for the cape sprites and, at a larger
// size, for the tiles in the menu's jewel track.
function paintJewel(g, size, color, shape){
  const how = jewelPath(g, size, shape);
  g.shadowColor = color; g.shadowBlur = Math.max(4, size * 1.6);
  if (how === "stroke"){
    g.strokeStyle = color; g.lineWidth = Math.max(1, size * 0.42);
    g.lineCap = "round"; g.globalAlpha = .95; g.stroke();
    return;
  }
  g.fillStyle = color; g.globalAlpha = .95; g.fill();
  g.shadowBlur = 0;
  g.globalAlpha = .8; g.strokeStyle = "#0a0d18"; g.lineWidth = Math.max(.6, size * 0.18);
  g.stroke();
  if (how === "fill+ring"){                       // a stone held inside a ring
    g.globalAlpha = .9; g.strokeStyle = color;
    g.lineWidth = Math.max(.7, size * 0.2);
    g.shadowColor = color; g.shadowBlur = size;
    g.beginPath(); g.arc(0, 0, size * 1.12, 0, TAU); g.stroke();
  } else if (how === "fill+dot"){                 // a bright heart to the sigil
    g.globalAlpha = 1; g.fillStyle = "#ffffff"; g.shadowBlur = 0;
    g.beginPath(); g.arc(0, 0, size * 0.26, 0, TAU); g.fill();
  }
}
/* The emblem set into a cloak's hem.

   One per rung of the ladder in src/account.js, and it is the thing that says
   at a glance how far somebody has come: a single stud at level one, a cut
   diamond at fourteen. Traced around the origin at radius `s`, so the same
   function serves the cape and the menu tile.

   These are OUTLINED white marks on a plain band, not glowing stones — the
   ladder they belong to reads by silhouette and by the colour of the cloth
   behind them, not by how brightly each piece shines. */
function hexAt(g, x, y, r){
  g.moveTo(x + r, y);
  for (let i = 1; i < 6; i++){
    const a = i * TAU / 6;
    g.lineTo(x + COS(a) * r, y + SIN(a) * r);
  }
  g.closePath();
}
function discAt(g, x, y, r){ g.moveTo(x + r, y); g.arc(x, y, r, 0, TAU); }
function emblemPath(g, s, kind){
  g.beginPath();
  switch (kind){
    case "stud1":  discAt(g, 0, 0, s * 0.40); return "fill";
    case "stud2":  discAt(g, -s * 0.42, 0, s * 0.36); discAt(g, s * 0.42, 0, s * 0.36); return "fill";
    case "stud3":  discAt(g, -s * 0.50, s * 0.20, s * 0.32);
                   discAt(g,  s * 0.50, s * 0.20, s * 0.32);
                   discAt(g,  0, -s * 0.30, s * 0.32); return "fill";
    // four discs in a flower — the first mark that is a device rather than a count
    case "quatre": for (let i = 0; i < 4; i++){
                     const a = i * TAU / 4 + Math.PI / 4;
                     discAt(g, COS(a) * s * 0.40, SIN(a) * s * 0.40, s * 0.36);
                   } return "stroke";
    case "hex1":   hexAt(g, 0, 0, s * 0.62); return "stroke";
    case "hex2":   hexAt(g, -s * 0.50, 0, s * 0.46); hexAt(g, s * 0.50, 0, s * 0.46); return "stroke";
    case "hex3":   hexAt(g, -s * 0.48, s * 0.30, s * 0.40);
                   hexAt(g,  s * 0.48, s * 0.30, s * 0.40);
                   hexAt(g,  0, -s * 0.40, s * 0.40); return "stroke";
    // three hexes overlapping into one lattice — a device, not three marks
    case "lattice":hexAt(g, 0, -s * 0.34, s * 0.46);
                   hexAt(g, -s * 0.40, s * 0.26, s * 0.46);
                   hexAt(g,  s * 0.40, s * 0.26, s * 0.46);
                   hexAt(g, 0, 0, s * 0.30); return "stroke";
    case "diamond":g.moveTo(0, -s * 0.72); g.lineTo(s * 0.56, 0);
                   g.lineTo(0, s * 0.72); g.lineTo(-s * 0.56, 0);
                   g.closePath(); return "fill";
    default:       discAt(g, 0, 0, s * 0.40); return "fill";
  }
}
function paintEmblem(g, size, kind, color){
  const how = emblemPath(g, size, kind);
  // A dark backing first, so a white mark still reads on the pale cloaks at the
  // top of the ladder as clearly as it does on the grey ones at the bottom.
  g.strokeStyle = "rgba(8,10,18,.75)";
  g.lineWidth = Math.max(1.6, size * (how === "fill" ? 0.30 : 0.34));
  g.lineJoin = "round"; g.stroke();
  if (how === "fill"){ g.fillStyle = color; g.fill(); return; }
  g.strokeStyle = color;
  g.lineWidth = Math.max(0.9, size * 0.17);
  g.stroke();
}
const emblemCache = new Map();
function emblemSprite(kind, size, color){
  const sz = Math.max(1, Math.round(size * 2) / 2);
  const key = kind + "|" + sz + "|" + color;
  let cv = emblemCache.get(key);
  if (!cv){
    cv = makeSprite(Math.ceil((sz * 1.2 + 6) * 2), (g, c) => {
      g.translate(c, c);
      paintEmblem(g, sz, kind, color);
    });
    emblemCache.set(key, cv);
  }
  return cv;
}

// one cloak jewel, glow and outline baked in; blitted rotated to the cloth
function jewelSprite(color, size, shape){
  const sz = Math.max(1, Math.round(size * 2) / 2);
  const key = color + "|" + sz + "|" + shape;
  let cv = jewelCache.get(key);
  if (!cv){
    cv = makeSprite(Math.ceil((sz * 1.6 + 8) * 2), (g, c) => {
      g.translate(c, c);
      paintJewel(g, sz, color, shape);
    });
    jewelCache.set(key, cv);
  }
  return cv;
}
// Just the glow, with the shape itself punched back out — for things that still
// want to draw their own crisp body on top, like a wizard's brim.
const haloCache = new Map();
function haloSprite(color, radius, blur){
  const r = Math.max(1, Math.round(radius));
  const b = Math.round(blur);
  const key = color + "|" + r + "|" + b;
  let cv = haloCache.get(key);
  if (!cv){
    cv = makeSprite(Math.ceil((r + b) * 2) + 4, (g, c) => {
      g.shadowColor = color; g.shadowBlur = b;
      g.fillStyle = color;
      g.beginPath(); g.arc(c, c, r, 0, TAU); g.fill();
      g.shadowBlur = 0;
      g.globalCompositeOperation = "destination-out";
      g.beginPath(); g.arc(c, c, r, 0, TAU); g.fill();
    });
    haloCache.set(key, cv);
  }
  return cv;
}

// blit a cached sprite centred on a point
function blitSprite(cv, x, y, alpha, angle){
  const w = cv && cv.width;
  if (!w) return;                       // headless rigs have no real canvas
  ctx.save();
  if (alpha != null) ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  if (angle) ctx.rotate(angle);
  ctx.drawImage(cv, -w / 2, -w / 2);
  ctx.restore();
}

function strokeJag(pts, color, width, alpha){
  // The halo on these used to come from whatever shadowBlur happened to be set
  // when they were drawn — twenty-odd blurred polyline strokes a frame, the
  // single most expensive thing on screen. A wide faint pass under a crisp one
  // gives the same look for a fraction of the cost, because the whole beam is
  // composited with "lighter" anyway and simply adds up.
  ctx.shadowBlur = 0;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i+1]);
  ctx.globalAlpha = alpha * .3;
  ctx.lineWidth = width * 3.4;
  ctx.stroke();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.globalAlpha = 1;
}
/* The Alchemist's mirror. Its front hands clap together and the glass begins as a bright seam
   between them; then the hands fling apart and a pane is drawn out between them, a sheet of
   pale glass seen from above with a lattice of triangles running through it that shimmer,
   each on its own beat, with a brighter band sweeping across. A brightening marks where a beam
   lands, and each beam it is turning back is drawn coming out of that point, in the colour it
   went in. All of this is the drawing of `boss.refl`, which it never writes. */
const MIRROR_TRI = 17, MIRROR_TINTS = ["#8fe9ff", "#bff4ff", "#c9b6ff", "#ffffff", "#a8ffe6"];
function drawMirror(w){
  const R = w.boss.refl, now = performance.now();
  const ca = COS(R.ang), sa = SIN(R.ang);
  const cx = w.x + ca * BOSS_MIRROR_D, cy = w.y + sa * BOSS_MIRROR_D;
  const seed = clamp(R.t / .1, 0, 1);                                     // the seam catches light
  const half = R.half * (.3 + .7 * seed);
  const open = bossMirrorOpenK(R);                                        // 0 while the hands are together, 1 once they are out
  const hd = BOSS_MIRROR_DEPTH * (.35 + .65 * open);                      // the pane thickens as it is drawn out
  const life = clamp((BOSS_REFLECT_LIFE - R.t) / .25, 0, 1);              // it thins in its last moments
  const a = (.55 + .45 * life) * (.3 + .7 * seed);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(R.ang);                                                      // local x runs toward whoever is beaming, y along the pane
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  // a faint halo, then the glass itself: dark and cool (drawn over the arena, not added to it, so the lattice in it can be seen)
  ctx.fillStyle = "#8fe9ff";
  ctx.globalAlpha = .06 * a; ctx.beginPath(); ctx.ellipse(0, 0, hd + 18, half + 18, 0, 0, TAU); ctx.fill();
  ctx.globalAlpha = .1 * a;  ctx.beginPath(); ctx.ellipse(0, 0, hd + 7, half + 7, 0, 0, TAU); ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  ctx.save();
  ctx.beginPath(); ctx.rect(-hd, -half, hd * 2, half * 2); ctx.clip();
  ctx.globalAlpha = .62 * a; ctx.fillStyle = "#0b2238"; ctx.fillRect(-hd, -half, hd * 2, half * 2);
  const gl = ctx.createLinearGradient(0, -half, 0, half);
  gl.addColorStop(0, "rgba(143,233,255,.05)"); gl.addColorStop(.25, "rgba(143,233,255,.2)"); gl.addColorStop(.5, "rgba(191,244,255,.34)");
  gl.addColorStop(.75, "rgba(143,233,255,.2)"); gl.addColorStop(1, "rgba(143,233,255,.05)");
  ctx.globalAlpha = a; ctx.fillStyle = gl; ctx.fillRect(-hd, -half, hd * 2, half * 2);
  // the triangles: a lattice of them across the pane, each glinting on its own beat
  const S = MIRROR_TRI, hgt = S * .866, sweep = -half - 30 + ((now / 900) % 1) * (half * 2 + 60);   // a bright band crossing the glass
  const rows = Math.max(1, Math.ceil(hd * 2 / hgt));
  ctx.lineWidth = .8; ctx.strokeStyle = "#dff8ff";
  for (let r = 0; r < rows; r++){
    const x0 = -hd + r * hgt, off = (r & 1) * S * .5;
    for (let k = -1; k * S - half < half + S; k++){
      const y0 = -half + k * S + off;
      for (let t = 0; t < 2; t++){
        const ph = ((r * 7 + (k + 9) * 13 + t * 5) * .61803) % 1;
        const cy2 = y0 + S * (t ? 1 : .5);
        const tw = SIN(now / 190 + ph * TAU + k * .5), glint = tw > 0 ? tw * tw : 0;
        const band = Math.max(0, 1 - Math.abs(cy2 - sweep) / 24);
        ctx.fillStyle = MIRROR_TINTS[(ph * MIRROR_TINTS.length) | 0];
        ctx.globalAlpha = Math.min(.95, a * (.1 + .42 * glint + .5 * band));
        ctx.beginPath();
        if (t === 0){ ctx.moveTo(x0, y0); ctx.lineTo(x0, y0 + S); ctx.lineTo(x0 + hgt, y0 + S * .5); }
        else { ctx.moveTo(x0 + hgt, y0 + S * .5); ctx.lineTo(x0 + hgt, y0 + S * 1.5); ctx.lineTo(x0, y0 + S); }
        ctx.closePath(); ctx.fill();
        ctx.globalAlpha = a * (.22 + .35 * glint + .3 * band); ctx.stroke();
      }
    }
  }
  ctx.restore();
  ctx.globalCompositeOperation = "lighter";
  // the frame of it: an edge, and the bright line down the middle where a beam is cut
  ctx.strokeStyle = "#bff4ff"; ctx.globalAlpha = .75 * a; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.rect(-hd, -half, hd * 2, half * 2); ctx.stroke();
  const g = ctx.createLinearGradient(0, -half, 0, half);
  g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(.3, "rgba(255,255,255,.9)"); g.addColorStop(.5, "rgba(255,255,255,1)");
  g.addColorStop(.7, "rgba(255,255,255,.9)"); g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.strokeStyle = g; ctx.globalAlpha = a * (.55 + .45 * open); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, -half); ctx.lineTo(0, half); ctx.stroke();
  // the end-caps of a pane of glass: where the hands hold it
  for (const ey of [-half, half]){
    ctx.fillStyle = "#fff"; ctx.globalAlpha = (.4 + .45 * open) * a; ctx.beginPath(); ctx.arc(0, ey, 2.4 + 2.6 * open, 0, TAU); ctx.fill();
    ctx.globalAlpha = (.1 + .2 * open) * a; ctx.beginPath(); ctx.arc(0, ey, 7 + 7 * open, 0, TAU); ctx.fill();
  }
  // glints running along the middle
  if (!REDUCED) for (let k = 0; k < 3; k++){
    const u = ((now / 520 + k / 3) % 1) * 2 - 1;
    const fade = 1 - Math.abs(u);
    ctx.globalAlpha = .9 * a * fade; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-5, u * half - 6); ctx.lineTo(5, u * half + 6); ctx.stroke();
  }
  // the flash as the hands fling apart
  const fl = R.t - BOSS_MIRROR_CLASP;
  if (fl > -.02 && fl < .22){
    const k = 1 - clamp(fl / .22, 0, 1);
    ctx.globalAlpha = k * .85; ctx.strokeStyle = "#fff"; ctx.lineWidth = 12 * k + 2;
    ctx.beginPath(); ctx.moveTo(0, -half); ctx.lineTo(0, half); ctx.stroke();
  }
  ctx.restore();
  // each beam it is sending back
  for (const o of R.out){
    const src = wizards.find(q => q.id === o.id);
    const tint = src && src.beamTint || byId.beam.color;
    const hx = o.x, hy = o.y;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const pulse = 1 + SIN(now / 45) * .12;
    bzGlow(hx, hy, 5 * pulse, 20, "#ffffff", .75);
    bzGlow(hx, hy, 8, 32, tint, .45);
    if (!REDUCED){
      const n = 4 + (vrand() * 3 | 0);
      for (let k = 0; k < n; k++){
        const ang = R.ang + Math.PI + vrnd(-1.3, 1.3), L2 = vrnd(14, 50);
        strokeJag(jag(hx, hy, hx + COS(ang) * L2, hy + SIN(ang) * L2, 4, 8), k & 1 ? "#fff" : "#bff4ff", 1.4, .8);
      }
    }
    ctx.restore();
    // the returned beam: drawn by the beam's own drawing, from a stand-in that sits on the glass
    drawBeam({ x: hx - COS(o.ang) * 18, y: hy - SIN(o.ang) * 18, facing: o.ang, beamLen: o.len + 18, beamWind: byId.beam.cast,
               beamTint: tint, friendly: false, clash: false, clashOrb: null });
  }
}
function drawBeam(w){
  const BC = w.beamTint || byId.beam.color;         // the Alchemist's fused beam wears its own colour
  const winding = w.beamWind < byId.beam.cast;
  const a = w.facing;
  const mz = w.boss ? BOSS_MUZZLE * BOSS_SCALE - 1 : 0;          // the Alchemist holds its beam out at the wand tip
  const len = winding ? 90 + mz : w.beamLen;
  const ex = w.x + COS(a)*len, ey = w.y + SIN(a)*len;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  if (winding){
    const k = w.beamWind/byId.beam.cast;
    ctx.strokeStyle = BC;
    ctx.globalAlpha = .35 + k*.5;
    ctx.lineWidth = 1 + k*2;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(w.x + COS(a)*(20 + mz), w.y + SIN(a)*(20 + mz));
    ctx.lineTo(w.x + COS(a)*(20 + mz + 600*k), w.y + SIN(a)*(20 + mz + 600*k));
    ctx.stroke();
    ctx.setLineDash([]);
    blitSprite(glowSprite(BC, 3 + k*7, 20*k),
               w.x + COS(a)*(22 + mz), w.y + SIN(a)*(22 + mz));
    const tx = w.x + COS(a)*(24 + mz), ty = w.y + SIN(a)*(24 + mz);
    if (!REDUCED){
      const now = performance.now();
      const dots = 8;
      for (let i = 0; i < dots; i++){
        const ang = now/280 * (w.friendly ? 1 : -1) + i/dots*TAU;
        const rad = 8 + 42*(1-k) + SIN(now/130 + i)*2.5;
        blitSprite(glowSprite(i % 3 ? BC : "#ffd6df", .9 + 2.2*k, 12),
                   tx + COS(ang)*rad, ty + SIN(ang)*rad, .3 + .65*k);
      }
      ctx.globalAlpha = 1;
      if (k > .25) for (let i = 0; i < 2; i++){
        const ang = vrnd(0, TAU), L2 = vrnd(6, 10 + k*22);
        strokeJag(jag(tx, ty, tx + COS(ang)*L2, ty + SIN(ang)*L2, 3, 5), "#fff", 1, .55*k);
      }
    }
  } else {
    const now = performance.now();
    const sharp = !!(w.boss && w.beamTint);     // the Prism Lance: an instant bolt, not a sustained glowing channel
    const flick = 1 + SIN(now/40)*(sharp ? 0.3 : 0.12);
    const sx = w.x + COS(a)*(18 + mz), sy = w.y + SIN(a)*(18 + mz);
    ctx.shadowColor = BC; ctx.shadowBlur = sharp ? 15 : 26;
    ctx.strokeStyle = BC;
    ctx.globalAlpha = sharp ? .32 : .5;
    ctx.lineWidth = (sharp ? 9 : 17)*flick;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = (sharp ? 3 : 6)*flick;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = sharp ? 1.3 : 2;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();

    // arcing filaments crawling along the shaft
    if (!REDUCED){
      const segs = Math.max(4, Math.min(22, (len/26)|0));
      ctx.shadowBlur = sharp ? 9 : 14;
      strokeJag(jag(sx, sy, ex, ey, segs, sharp ? 21 : 11), "#ffd8e6", sharp ? 1.3 : 1.6, sharp ? .95 : .85);
      strokeJag(jag(sx, sy, ex, ey, segs, sharp ? 32 : 19), BC, 1.2, .55);
      if (sharp) strokeJag(jag(sx, sy, ex, ey, segs, 13), "#fff", 1, .85);   // a whiter, jumpier core crackle
      // forks that leap off the shaft
      const forks = (sharp ? 3 : 1) + (vrand()*3|0);
      for (let f = 0; f < forks; f++){
        const t = vrand();
        const bx = sx + (ex-sx)*t, by = sy + (ey-sy)*t;
        const ang = a + Math.PI/2*(vrand()<.5?1:-1) + vrnd(-.6,.6);
        const L2 = vrnd(14, sharp ? 62 : 46);
        strokeJag(jag(bx, by, bx + COS(ang)*L2, by + SIN(ang)*L2, 4, 7), "#fff", 1.1, .5);
      }
      ctx.shadowBlur = 0;
    }
    // muzzle bloom at the wand
    ctx.fillStyle = "#fff"; ctx.shadowColor = BC; ctx.shadowBlur = 30;
    ctx.beginPath(); ctx.arc(sx, sy, 5 + SIN(now/50)*1.6, 0, TAU); ctx.fill();

    if (w.clash && w.clashOrb){
      const orb = w.clashOrb;
      // the shiver lives here, in the drawing, so the simulated orb stays put
      const j = (orb.jit && !REDUCED) ? orb.jit : 0;
      const ox = orb.x + (j ? vrnd(-j, j) : 0), oy = orb.y + (j ? vrnd(-j, j) : 0);
      const pulse = SIN(now/55);
      const r = 15 + pulse*4 + orb.press*7;
      const lead = orb.lead ? orb.lead.tint : "#fff";
      ctx.shadowBlur = 45;
      ctx.fillStyle = BC; ctx.globalAlpha = .5;
      ctx.beginPath(); ctx.arc(ox, oy, r*2.1, 0, TAU); ctx.fill();
      ctx.globalAlpha = .35 + orb.press*.45;
      ctx.fillStyle = lead;
      ctx.beginPath(); ctx.arc(ox, oy, r*1.5, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(ox, oy, r, 0, TAU); ctx.fill();
      const ex = ox, ey = oy;
      if (!REDUCED){
        // lightning thrown off the point of contention
        const spokes = 5 + (vrand()*4|0);
        for (let i = 0; i < spokes; i++){
          const ang = vrnd(0, TAU);
          const L2 = vrnd(18, 62);
          strokeJag(jag(ex, ey, ex + COS(ang)*L2, ey + SIN(ang)*L2, 5, 9),
                    i % 2 ? "#fff" : BC, 1.5, .75);
        }
        ctx.strokeStyle = "#fff"; ctx.globalAlpha = .35; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(ex, ey, r*2.6 + (now/6 % 26), 0, TAU); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }
  ctx.restore();
}

/* ------------------------------------------------------- the cape
   A rank worn on your back. A wizard starting out trails plain cloth; every
   cloak jewel earned (the same ladder as GEMS in src/account.js) adds one
   stone in its own colour and its own cut, so a wizard who has been at it a
   while is visibly heavier dressed. The cloth is longer and wider at higher
   rank too.

   VIEW ONLY. Nothing here touches the seeded RNG, reads back into the
   simulation, or appears in RPW.hash() — two clients can disagree about the
   exact ripple of a cape without disagreeing about the match. It is stepped
   from real elapsed time in pump(), not from the fixed simulation step, so it
   stays smooth whatever the frame rate.

   The motion is a spring-to-rest verlet chain: each node is pulled towards
   where it would hang if the wizard stood still — straight out behind, with a
   travelling sine running down the length — while its own inertia drags it,
   and a distance constraint stops the cloth stretching. Turning or dashing
   therefore whips it out sideways, and standing still leaves it breathing. */

const CAPE_NODES = 9;
const CAPE_SEG_MIN = 4.4, CAPE_SEG_MAX = 5.95;  // per-segment length, low rank to high
const CAPE_RUNGS = 14;                          // rungs on the cloak ladder (src/account.js)
const CAPE_LAG = 5.0;                           // how far the collar may trail the wizard, in px

/* ------------------------------------------------------------ how it hangs

   Each joint is a damped spring towards where its neighbour points. Two numbers
   decide whether that reads as cloth or as a plank: the spring rate, and the
   DAMPING RATIO — how much of a swing survives to become the next swing.

   Below 1 the joint overshoots its rest angle and comes back, once for each
   swing; at 1 and above it can only creep towards rest and stop. That is the
   whole difference between follow-through and sluggishness, and it is possible
   to get it exactly backwards while believing you have made the hem looser.

   This code did. An earlier version dropped the spring rate towards the hem
   (right) while also raising the damping (wrong), which put every joint past
   the halfway point of the cape at a ratio above 1. The tip — the part with
   the least holding it and the most to say — was the one part of the cape that
   physically could not swing past anything. It lagged, so it passed a test
   written about lag, and it still looked like a board.

   So the ratio is now stated directly rather than falling out of a per-frame
   multiplier, and it FALLS towards the hem: the collar answers the wizard
   crisply and stops, the hem rings three or four times and is still going when
   everything above it has settled. */
const CAPE_STIFF_TOP = 38, CAPE_STIFF_TIP = 11;   // spring rate, collar to hem
const CAPE_ZETA_TOP  = 0.88, CAPE_ZETA_TIP = 0.26; // damping ratio, collar to hem

/* Cloth does not know where its owner is going; it only feels being dragged.
   Every whip, flare and settle a real cape has comes from the pivot ACCELERATING
   under it — a stop throws the hem forward past the body, a hard turn throws it
   wide. Nothing in this file used to model that: the chain followed a rest
   direction derived from facing and speed, so it could trail, but it could not
   be thrown. This is the term that throws it. */
const CAPE_WOB = 0.05;         // how far the cloth ripples across its width
const CAPE_WOB_WAVE = 2.3;     // radians of that ripple across the WHOLE length
const CAPE_WOB_MAX = 1 + CAPE_WOB;  // the widest it can ever be, for the fold rule
const CAPE_SWING = 0.055;      // how hard the pivot's acceleration is felt
const CAPE_ACC_MAX = 2600;     // px/s^2 — a respawn is a teleport, not a sprint
const CAPE_ACC_TAU = 0.075;    // seconds; smooths velocity into a usable acceleration

/* The cape bends by a bounded amount per segment and no more. This is the
   single rule that keeps it from tying itself in knots.

   An earlier version simulated the two hems as free particles. It moved
   beautifully right up until it didn't: free hems can swing past one another,
   and once they cross, the outline folds through itself and the cloth turns
   inside out. No amount of damping fixes that, because nothing in the model
   forbids it.

   Now there is only ONE chain — the spine — and the hems are derived from it.
   The cloth folds when the spine turns tighter than it is wide, so the turn is
   simply not allowed to get that tight: cap it below seg/halfWidth radians and
   a self-intersection is arithmetically impossible. What is left is a smooth
   curve that trails, which is what a cape does. */
const CAPE_MAX_TURN = 0.26;                     // radians per segment, ~15 degrees
/* How much radius the INSIDE edge must keep. 1.0 is the crossing limit and also
   the collapse limit; above it the inner edge stays a curve. */
const CAPE_FOLD_MARGIN = 1.45;

/* Half the cloth's width at node i.

   It starts at the SHOULDERS, not at a point. Tapering the collar down to a few
   pixels made the thing read as a bowtie — two triangles pinched together
   behind the wizard — rather than as a cloak hanging off them. A real cloak is
   already shoulder-wide where it fastens and only flares from there.

   `wide` scales the whole thing gently with rank, so a beginner's cloak is a
   plainer, smaller garment as well as an unadorned one. */
/* Half the cloth's width at node i. `flare` widens the SKIRT only — it ramps in
   over the bottom third — so a high rung reads as a broader hem rather than a
   uniformly fatter cape, which is what the reference sheet does as it climbs. */
function capeHalf(i, last, wide, flare, wob){
  const k = i / last;
  let w = (8.6 + k * 10.4) * (1 - POW(k, 10) * 0.16);
  if (flare) w *= 1 + flare * POW(Math.max(0, (k - 0.34) / 0.66), 1.6);
  if (wob && wob[i] != null) w *= wob[i];
  return w * (wide == null ? 1 : wide);
}
/* Darken or lighten a #rrggbb by a fraction. The cape uses it to shade its own
   cloth colour towards the hem, so a rung supplies ONE colour and the depth
   comes out of it rather than out of a second entry that could drift. */
function shade(hex, k){
  const h = String(hex).replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, c => c + c) : h, 16);
  const mix = (c) => Math.max(0, Math.min(255, Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k)));
  return "#" + [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map(c => mix(c).toString(16).padStart(2, "0")).join("");
}
/* #rrggbb at an alpha, for the fade down the cloth. */
function rgba(hex, a){
  const n = parseInt(String(hex).replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function capeWide(rung){
  return 0.84 + 0.16 * Math.min(1, (rung - 1) / (CAPE_RUNGS - 1));
}

/* Which rung of the cloak ladder a wizard has climbed to.

   Only a LEVEL crosses the wire (see currentLevel() in src/net.js) — never the
   cloth, the seams or the emblem. Rungs are reached strictly in level order, so
   every client derives the identical cloak from the shared table in
   src/account.js. One small integer, carried in the roster that already flows
   on join, leave and start; nothing here rides the per-frame input stream, so
   no cape can cost anybody a frame however elaborate it is.

   Rungs are per-level, not per-wizard, so this is memoised: six capes at sixty
   frames a second would otherwise walk the same fourteen-row table 360 times a
   second for nothing. */
const PLAIN_CLOAK = { at: 1, emblem: "stud1", seams: 0, tail: "chevron", flare: 0,
                      base: "#3a3a44", wedge: null,
                      hat: "#5e5e68", brim: "#24242b", lit: "#93939f" };
const rankCache = new Map();
function rankFor(level){
  const lv = Math.max(1, Math.min(999, Math.floor(Number(level)) || 1));
  let r = rankCache.get(lv);
  if (!r){
    const acct = ACCT();
    r = (acct && acct.cloak) ? acct.cloak(lv) : PLAIN_CLOAK;
    rankCache.set(lv, r);
  }
  return r;
}
let myRank = PLAIN_CLOAK;
function refreshMarks(profile){
  rankCache.clear();
  myRank = rankFor(profile ? profile.level : 1);
}
/* Bots wear a RANK, not a special case.

   Each tier is given a level and sent through rankFor() exactly like a player,
   so a bot's cloak is a cloak somebody could actually be wearing — same stones,
   same colours, same braid, same size. That is the whole point: you should be
   able to look at a wizard across the arena and know what you are facing, and
   an Archmage's cloak should be a thing to want.

   Apprentice sits at level 1 — the plain grey cloth a new player starts in, so
   a beginner sees themselves in it. Adept is level 7, the last rung before the
   cloth turns green: clearly ahead of you, still the same colour. Archmage is
   13, one rung short of the top, so there is somewhere left to climb even after
   you can beat one.

   Levels, not rung indexes, because then the ladder in src/account.js stays the
   single source of truth — retune it and the bots follow without being touched. */
const BOT_LEVEL = [1, 7, 13];       // Apprentice, Adept, Archmage

// A wizard starting out wears plain cloth. Everything on it is earned.
function capeMarks(w){
  if (w === you) return myRank;                                        // your own profile
  if (w.D){
    const tier = Math.max(0, DIFF.indexOf(w.D));
    return rankFor(BOT_LEVEL[tier] || 1);                              // a bot wears its tier
  }
  return rankFor(seatLevels && seatLevels[w.seat]);                    // another player, from the roster
}
function capeSeg(rung){
  const k = Math.min(1, (rung - 1) / (CAPE_RUNGS - 1));
  return CAPE_SEG_MIN + (CAPE_SEG_MAX - CAPE_SEG_MIN) * k;
}

/* The cloth itself: one angle per segment, and that is the whole state.

   Storing ANGLES rather than positions is what makes this well behaved. A
   segment is exactly `seg` long by construction, so the cloth can never
   stretch; and the angle each segment is allowed to differ from the one before
   it is clamped, so the curve can never kink or double back. There is nothing
   left for a solver to fight over.

   Each angle eases towards the one ahead of it with a little inertia, and it
   reads that neighbour as it was LAST frame rather than as it has just become.
   That one detail is what gives the cloth overlapping action: a turn at the
   shoulders takes several frames to reach the hem instead of snapping the whole
   chain into line at once, so the cape trails, overshoots and settles from the
   collar down. Segments also get looser and heavier towards the tip, and the
   collar itself lags a little behind the wizard, so the cloth is never quite
   done moving when the wizard is.

   VIEW ONLY. No seeded RNG, nothing read back by the simulation, absent from
   RPW.hash(); stepped from real elapsed time in pump(), not the fixed
   simulation step. */
function makeCape(w, seg){
  const back = w.facing + Math.PI;
  // `prev` is last frame's angles, `ax/ay` the lagging collar, `hang` the eased
  // rest direction — the three pieces of state that make the cloth overlap
  // itself rather than move as one board.
  const c = { seg, a: [], va: [], prev: [], p: [], wob: [],
              ax: w.x - COS(w.facing) * 3, ay: w.y - SIN(w.facing) * 3,
              hang: back, svx: w.vx || 0, svy: w.vy || 0 };
  for (let i = 0; i < CAPE_NODES - 1; i++){ c.a.push(back); c.va.push(0); c.prev.push(back); }
  for (let i = 0; i < CAPE_NODES; i++) c.wob.push(1);
  layCape(c, c.ax, c.ay);
  return c;
}
/* Walk the angles out into points, writing into the SAME point objects every
   frame. Rebuilding the list allocated one small object per node per wizard per
   frame — sixty-odd short-lived objects a frame at a full table. In the headless
   rig the saving is inside the noise; this is here because allocation churn in
   a per-frame path is worth not having, not because it was measured to matter.
   Nothing outside this function keeps a reference to these points beyond the
   frame it reads them in. */
function layCape(c, ax, ay){
  const n = c.a.length + 1;
  while (c.p.length < n) c.p.push({ x: 0, y: 0 });
  if (c.p.length > n) c.p.length = n;
  let x = ax, y = ay;
  c.p[0].x = x; c.p[0].y = y;
  for (let i = 0; i < c.a.length; i++){
    x += COS(c.a[i]) * c.seg;
    y += SIN(c.a[i]) * c.seg;
    c.p[i + 1].x = x; c.p[i + 1].y = y;
  }
}
// shortest signed way round from a to b
function angleTo(a, b){
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
function updateCapes(dt){
  if (!(dt > 0)) return;
  const step = Math.min(dt, 1 / 30);
  const t = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
  const last = CAPE_NODES - 1;

  for (const w of wizards){
    const marks = capeMarks(w);
    const rung = marks.at, flare = marks.flare || 0;
    const seg = capeSeg(rung), wide = capeWide(rung);
    const ax = w.x - COS(w.facing) * 3, ay = w.y - SIN(w.facing) * 3;

    let c = w.cape;
    if (!c || c.seg !== seg || c.a.length !== CAPE_NODES - 1) c = w.cape = makeCape(w, seg);

    /* The collar lags. It chases the wizard's shoulders rather than being nailed
       to them, so a dash pulls the cloth taut behind and a stop lets it catch
       up — but the lag is clamped to a few pixels, because a cape that comes
       off its owner's back is a bug, not follow-through. */
    const chase = 1 - POW(0.0016, step);
    c.ax += (ax - c.ax) * chase;
    c.ay += (ay - c.ay) * chase;
    const offx = c.ax - ax, offy = c.ay - ay;
    const off = HYPOT(offx, offy);
    if (off > CAPE_LAG){ c.ax = ax + offx / off * CAPE_LAG; c.ay = ay + offy / off * CAPE_LAG; }

    // Which way the cloth hangs when nothing is happening: straight out behind.
    // If the wizard is moving, it trails the direction of travel instead — that
    // is the difference between a cape and a weather vane. Eased, so a turn
    // arrives at the collar as a sweep rather than a jump.
    const sp = HYPOT(w.vx || 0, w.vy || 0);
    let want0 = w.facing + Math.PI;
    if (sp > 12){
      const drift = ATAN2(-(w.vy || 0), -(w.vx || 0));
      want0 += angleTo(want0, drift) * Math.min(1, sp / 150) * 0.85;
    }
    c.hang += angleTo(c.hang, want0) * (1 - POW(0.02, step));

    const phase = w.seat * 1.7;
    const gust = Math.min(1, sp / 170);

    /* What the cloth actually feels: not where the wizard is going, but how
       hard the collar is being yanked. Smoothing the velocity and taking what
       the raw velocity is doing AHEAD of that smoothed value is an acceleration
       without the noise of differencing a position twice. */
    const vx = w.vx || 0, vy = w.vy || 0;
    const ease = 1 - EXP(-step / CAPE_ACC_TAU);
    c.svx += (vx - c.svx) * ease;
    c.svy += (vy - c.svy) * ease;
    let accx = (vx - c.svx) / CAPE_ACC_TAU, accy = (vy - c.svy) / CAPE_ACC_TAU;
    const am = HYPOT(accx, accy);
    // A respawn moves a wizard across the arena in one frame. That is a
    // teleport, not a sprint, and a cape that treats it as one turns inside out.
    if (am > CAPE_ACC_MAX){ accx = accx / am * CAPE_ACC_MAX; accy = accy / am * CAPE_ACC_MAX; }

    // last frame's angles are what this frame's segments follow
    for (let i = 0; i < c.a.length; i++) c.prev[i] = c.a[i];

    for (let i = 0; i < c.a.length; i++){
      const k = i / Math.max(1, c.a.length - 1);
      /* Looser towards the hem — and looser means BOTH numbers falling. The
         collar is stiff and well damped, so it answers the wizard and stops;
         the hem is slack and barely damped, so it swings past and comes back
         several times. Raising the damping towards the hem, as this once did,
         produces the opposite of slack. */
      const stiff = CAPE_STIFF_TOP + (CAPE_STIFF_TIP - CAPE_STIFF_TOP) * k;
      const zeta  = CAPE_ZETA_TOP  + (CAPE_ZETA_TIP  - CAPE_ZETA_TOP)  * k;
      const damp  = EXP(-2 * zeta * Math.sqrt(stiff) * step);
      // the wave lives in the TARGET, never in the positions — a wave applied
      // to points can kink the curve, a wave applied to a target cannot. Two
      // frequencies that do not divide into one another, so the idle drift
      // never falls into a visible beat the way a single sine does.
      const wave = (SIN(t * 2.1  - i * 0.42 + phase) * 0.63 +
                    SIN(t * 3.37 - i * 0.23 + phase * 1.7) * 0.37)
                   * (0.045 + 0.115 * k) * (0.55 + gust);
      const lead = i === 0 ? c.hang : c.prev[i - 1];
      const want = lead + wave;

      c.va[i] += angleTo(c.a[i], want) * stiff * step;
      /* The pivot's acceleration, felt as a torque about this joint: a segment
         pointing one way is thrown by the component of that acceleration across
         it, and not at all by the component along it. Weighted towards the hem,
         which has the most cloth below it to be thrown. */
      const nx = -SIN(c.a[i]), ny = COS(c.a[i]);
      c.va[i] -= (accx * nx + accy * ny) / seg * CAPE_SWING * (0.25 + 0.75 * k) * step;
      c.va[i] *= damp;
      c.a[i] += c.va[i] * step;
    }

    /* The rule that makes folding impossible, applied AFTER the chain has moved
       and against each segment's neighbour as it now is. Clamping inside the
       loop above would have compared against last frame's neighbour, which is
       not the curve anybody actually sees. Front to back, so each clamp is
       measured against an angle that is already final. */
    for (let i = 0; i < c.a.length; i++){
      const lead = i === 0 ? c.hang : c.a[i - 1];
      const rel = angleTo(lead, c.a[i]);
      /* Measured against the widest this cloth can ever be — the rung's flare
         included, and the ripple at its crest. The flare was missing here: a
         high rung is drawn wider at the hem than this rule assumed, so the one
         thing that makes folding arithmetically impossible was being computed
         for a narrower cape than the one on screen.

         The MARGIN matters as much as the rule. Bending until the spine's
         radius merely equals the cloth's half-width is the limit at which the
         edges do not CROSS — and it is also the point at which the inside edge
         has a radius of zero, so every point along it lands on the same spot.
         The result is not a fold; it is a bite taken out of the cloth, and it
         passes any test that asks about crossing. Keep a real radius on the
         inside and the outline stays an outline. */
      const cap = Math.min(CAPE_MAX_TURN,
                           seg / (capeHalf(i + 1, last, wide, flare) * CAPE_WOB_MAX * CAPE_FOLD_MARGIN));
      /* Correct the position always — that is the no-fold guarantee and it is
         not negotiable. But only take the velocity that is still pushing INTO
         the limit; a joint already swinging back off the cap is doing exactly
         what cloth does, and the old blanket cut threw that away too. */
      if (rel > cap){ c.a[i] = lead + cap; if (c.va[i] > 0) c.va[i] *= -0.18; }
      else if (rel < -cap){ c.a[i] = lead - cap; if (c.va[i] < 0) c.va[i] *= -0.18; }
    }

    /* A hem that keeps one exact width is a cut-out. This ripples the cloth
       ACROSS its width as well as along it — a few percent, travelling down —
       so the silhouette breathes instead of sliding about rigidly. It is a
       drawing weight, not a position: it cannot kink the spine or fold it.

       The WAVELENGTH is the whole point and the first attempt got it wrong. At
       0.74 radians of phase per node, neighbouring nodes were near opposite
       parts of the wave, so the cloth came out a few percent wider, narrower,
       wider, narrower down its length — a scalloped polygon rather than a
       breathing edge, and clearly visible at the size this is drawn. Under
       half a wave over the whole cape is what reads as cloth. */
    const wobStep = CAPE_WOB_WAVE / Math.max(1, c.wob.length - 1);
    for (let i = 0; i < c.wob.length; i++){
      const k = i / Math.max(1, c.wob.length - 1);
      c.wob[i] = 1 + SIN(t * 2.6 - i * wobStep + phase) * CAPE_WOB * k * (0.6 + 0.5 * gust);
    }
    layCape(c, c.ax, c.ay);
  }
}


// Drawn in the wizard's translated (but unrotated) space, so the cloth keeps
// its own world-space shape instead of turning rigidly with the hat.
function drawCape(w){
  const c = w.cape;
  if (!c || !c.p || c.p.length < 3) return;
  /* The rung this wizard has climbed to. Its ONE base colour is the cloth, and
     what changes down the length is not the colour but the ALPHA: near solid at
     the shoulders, nearly gone at the hem. That is the difference between cloth
     you can see through and a shape cut out of paper, and it is why there is no
     second colour here that could drift out of step with the first.

     Everything drawn on top of it is white. Friend and foe are told apart by the
     ring and wand glow, which stay the seat's own tint; shading the cloth by
     side as well would have muddied the one thing the ladder is for. */
  const rank = capeMarks(w);

  const P = c.p.map(p => ({ x: p.x - w.x, y: p.y - w.y }));
  const last = P.length - 1;

  // The hems are DERIVED from the spine, never simulated. Because the spine's
  // curvature is capped below seg/width, offsetting it can never produce an
  // edge that crosses itself.
  const dirAt = i => {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(last, i + 1)];
    let ux = b.x - a.x, uy = b.y - a.y;
    const d = HYPOT(ux, uy) || 1;
    return { x: ux / d, y: uy / d };
  };
  const wide = capeWide(rank.at), flare = rank.flare || 0;
  /* How the cloth closes at the bottom. The reference sheet changes this every
     few rungs and it is the loudest signal on the whole cape — you can read it
     from across the arena, long before an emblem is legible:

       chevron  a shallow wide V, tips barely past the body — plain cloth
       kite     a single deep point
       rhombus  a broad flat diamond, tips flared out past the body
       split    two long lobes with a deep notch cut up between them — the top
                rung, and the only hem that is not one continuous edge

     Every point is built from the tail's own direction and normal, so the shape
     travels and swings with the cloth instead of being painted on flat. */
  const tailPts = (f, kind) => {
    const u = dirAt(last), h = capeHalf(last, last, wide, flare, c.wob) * f;
    const T = P[last], nx = -u.y, ny = u.x;
    const at = (along, side) => ({ x: T.x + u.x * h * along + nx * h * side,
                                   y: T.y + u.y * h * along + ny * h * side });
    switch (kind){
      case "chevron": return [at(0.26, 1.06), at(0.52, 0), at(0.26, -1.06)];
      case "rhombus": return [at(0.30, 1.30), at(0.86, 0), at(0.30, -1.30)];
      // the notch is cut back almost to the tail, so the two lobes read as a
      // deep split rather than a wide shallow dip
      case "split":   return [at(0.20, 1.26), at(1.12, 0.74), at(0.02, 0.15),
                              at(0.02, -0.15), at(1.12, -0.74), at(0.20, -1.26)];
      default:        return [at(0.98, 0)];                      // kite: one deep point
    }
  };
  const edges = f => {
    const L = [], R = [];
    for (let i = 0; i <= last; i++){
      const u = dirAt(i), h = capeHalf(i, last, wide, flare, c.wob) * f;
      L.push({ x: P[i].x - u.y * h, y: P[i].y + u.x * h });
      R.push({ x: P[i].x + u.y * h, y: P[i].y - u.x * h });
    }
    return { L, R, tail: tailPts(f, rank.tail) };
  };
  const runThrough = pts => {
    for (let i = 1; i < pts.length - 1; i++){
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  };
  // The tail is drawn with straight segments on purpose: a chevron that has
  // been smoothed into a curve is just a kite again.
  const runTail = e => { for (const t of e.tail) ctx.lineTo(t.x, t.y); };
  const trace = (f = 1) => {
    const e = edges(f);
    ctx.beginPath();
    ctx.moveTo(e.L[0].x, e.L[0].y);
    runThrough(e.L);
    runTail(e);
    ctx.lineTo(e.R[last].x, e.R[last].y);
    runThrough(e.R.slice().reverse());
    ctx.closePath();
  };
  const traceHem = f => {
    const e = edges(f), from = Math.max(1, last - 2);
    ctx.beginPath();
    ctx.moveTo(e.L[from].x, e.L[from].y);
    runThrough(e.L.slice(from));
    runTail(e);
    ctx.lineTo(e.R[last].x, e.R[last].y);
    runThrough(e.R.slice(from).reverse());
  };

  ctx.save();
  ctx.globalAlpha = .32; ctx.fillStyle = "#04050b";
  ctx.save(); ctx.translate(1.6, 2.6); trace(); ctx.fill(); ctx.restore();
  ctx.globalAlpha = 1;

  const tail = P[last];
  /* The cloth is TRANSLUCENT: the arena reads through it, which is what made
     the old capes feel like enchanted cloth rather than cardboard. The flat
     ladder colours had made it opaque and it looked pasted on.

     The glow around the edge is three strokes of the seat's own tint at falling
     width and rising alpha, NOT shadowBlur. They look the same at this size and
     the strokes cost almost nothing, where shadowBlur is the single most
     expensive thing this renderer can do — it is what made six Archmages run at
     13fps before, and putting it back on every cape would undo that. */
  const grad = ctx.createLinearGradient(P[0].x, P[0].y, tail.x, tail.y);
  grad.addColorStop(0,   rgba(rank.base, .96));
  grad.addColorStop(0.55, rgba(rank.base, .74));
  grad.addColorStop(1,   rgba(rank.base, .40));
  trace();
  ctx.fillStyle = grad; ctx.fill();
  ctx.lineJoin = "round";
  ctx.strokeStyle = w.tint;
  ctx.globalAlpha = .12; ctx.lineWidth = 5.5; ctx.stroke();
  ctx.globalAlpha = .26; ctx.lineWidth = 2.8; ctx.stroke();
  ctx.globalAlpha = .85; ctx.lineWidth = 1.1; ctx.stroke();
  ctx.globalAlpha = 1;

  // a soft fold down the middle, so it has a near side and a far side
  ctx.save(); trace(); ctx.clip();
  ctx.globalAlpha = .26; ctx.strokeStyle = "#05070f"; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(P[0].x, P[0].y); runThrough(P); ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1;

  /* Everything below is EARNED, and it is all clipped to the cloth so nothing
     can spill off the edge of the cape. Three things arrive at different rates
     — the centre panel, the seams, and the emblem in the hem band — which is
     what keeps the middle of the ladder from feeling like a slower version of
     the start. */
  ctx.save(); trace(); ctx.clip();
  ctx.globalAlpha = 1;

  // the centre wedge down the spine, from level 8: white everywhere except the
  // top rung, where it is the one piece of colour on an almost white cloak
  if (rank.wedge){
    const E = edges(0.20);
    ctx.globalAlpha = rank.wedge === "#ffffff" ? .12 : .58; ctx.fillStyle = rank.wedge;
    ctx.beginPath();
    ctx.moveTo(E.L[0].x, E.L[0].y);
    runThrough(E.L);
    runTail(E);
    ctx.lineTo(E.R[last].x, E.R[last].y);
    runThrough(E.R.slice().reverse());
    ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
  }

  /* Seams. Each one runs the whole length of the cloth at a fixed fraction of
     its width, so they fan out with the cape and travel with it rather than
     being painted on flat. An odd count puts one straight down the spine. */
  if (rank.seams > 0){
    ctx.globalAlpha = .48; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 0.85;
    ctx.lineCap = "round";
    for (let k = 0; k < rank.seams; k++){
      const t = rank.seams === 1 ? 0 : (k / (rank.seams - 1)) * 2 - 1;   // -1..1
      ctx.beginPath();
      for (let i = 0; i <= last; i++){
        const u = dirAt(i), h = capeHalf(i, last, wide, flare, c.wob) * t * 0.82;
        const x = P[i].x - u.y * h, y = P[i].y + u.x * h;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // the hem band the emblem is set into, and its bright edge
  const E1 = edges(1), bandFrom = Math.max(1, last - 2);
  ctx.globalAlpha = .20; ctx.fillStyle = "#ffffff";
  traceHem(1); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = .85; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(E1.L[bandFrom].x, E1.L[bandFrom].y);
  ctx.quadraticCurveTo(P[bandFrom].x, P[bandFrom].y, E1.R[bandFrom].x, E1.R[bandFrom].y);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();

  /* The emblem, riding the cloth in the middle of the hem band. It is blitted
     from a cached sprite rather than traced every frame — six capes at sixty
     frames a second would otherwise redraw the same lattice 360 times a second
     for nothing. */
  {
    const f = 0.90 * last;
    const i0 = Math.min(last - 1, f | 0), fr = f - i0;
    const a = P[i0], b = P[i0 + 1];
    let ux = b.x - a.x, uy = b.y - a.y;
    const d = HYPOT(ux, uy) || 1; ux /= d; uy /= d;
    const x = a.x + (b.x - a.x) * fr, y = a.y + (b.y - a.y) * fr;
    const size = 5.2 + 2.6 * ((rank.at - 1) / (CAPE_RUNGS - 1));
    ctx.globalAlpha = .92;
    blitSprite(emblemSprite(rank.emblem, size, "#ffffff"), x, y, 1, ATAN2(uy, ux) + Math.PI / 2);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/* ------------------------------------------------------- the Alchemist, drawn
   Ported from Opus's boss concept (v2) concept (v2): the game's own cloth language
   — one colour fading to see-through down its length, a tint glow edge, white
   seams and a hem band — with the "hat tell" on top. A gem sits in the brim where
   each arm leaves the hat, lit in that arm's next spell; the live ones carry a
   white ring that closes as the cast comes due, the holstered ones are embers
   that wake just before the arms trade places, and the cone tip burns in the
   colour of whatever fires first.

   The soft parts are alive. Everything below the "view" line — the ribbons and
   the mantle (a real chain of springy cloth, dragged by the boss's movement and
   turns, kicked by its casts) and the arms (spring-damped, so they overshoot the
   pose the simulation asks for and settle) — is VIEW STATE. It lives in
   `w.view`, advances on real frame time in updateBossView(), and is never read
   by the simulation, so a machine that draws it differently, or not at all,
   still agrees with every other on where the boss is and what it is casting. */
const BZ = {
  cloth:"#c42a5c", brim:"#1c0b13", cone:"#6a1c36", lit:"#e0668a",
  arm:"#3a1620", armLit:"#d0607f", outline:"#08030a", joint:"#5a1a2e",
  hs:2.15, coneLen:34
};
const BZ_BRIM = 15 * BZ.hs;
function bzGlow(x, y, r, blur, color, a){
  const g = ctx.createRadialGradient(x, y, 0, x, y, r + blur);
  const k = r / (r + blur);
  g.addColorStop(0, rgba(color, a)); g.addColorStop(k, rgba(color, a));
  g.addColorStop(Math.min(1, k + (1 - k)*.35), rgba(color, a*.32)); g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r + blur, 0, TAU); ctx.fill();
}
function bzHalo(r, blur, color, a){
  const g = ctx.createRadialGradient(0, 0, r*.9, 0, 0, r + blur);
  g.addColorStop(0, rgba(color, 0)); g.addColorStop(.1, rgba(color, a)); g.addColorStop(.45, rgba(color, a*.3)); g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r + blur, 0, TAU); ctx.fill();
}
function bzEdge(tint){
  ctx.lineJoin = "round"; ctx.strokeStyle = tint;
  ctx.globalAlpha = .12; ctx.lineWidth = 5.5; ctx.stroke();
  ctx.globalAlpha = .26; ctx.lineWidth = 2.8; ctx.stroke();
  ctx.globalAlpha = .85; ctx.lineWidth = 1.1; ctx.stroke();
  ctx.globalAlpha = 1;
}

/* ---------------------------------------------------------- the soft parts (view) */
const BZV_H = 1 / 120;                        // physics sub-step, seconds
// arms: an elbow, a hand and a wand angle, each a damped spring chasing the pose the
// simulation asks for. omega = how quickly, zeta = how bouncy (1 would settle
// without overshooting; these do not). The wand is loosest, so it whips.
const BZV_ARM = { E:{ w:15, z:.55 }, H:{ w:12, z:.38 }, A:{ w:15, z:.26 } };
const BZV_FACE = { w:19, z:.62 };
// the hat and its ring of stones spin up and settle: a spring after the sim's spin curve, so they click home
const BZV_HAT = { w:24, z:.5 }, BZV_RING = { w:20, z:.45 };
const BZ_HAT_TURNS = 3, BZ_RING_TURNS = 2;    // full turns the hat / the ring make in one spin
const BZV_COLS = 5, BZV_ROWS = 11;             // the cloak: five strands of cloth side by side, eleven links each
const RIDE = [0, 0];
const BZ_SWING = 2.05;                       // the furthest a link of cloth may swing from straight behind the body (about 117 degrees)
const BZV_UCOLS = 3;                          // and a longer, darker under-cloak behind it
function bzChain(n, restLocal, kTop, kTip, zTop, zTip){
  const ch = { n, rest: restLocal, x: [], y: [], vx: [], vy: [], k: [], c: [], seg: 0, cap: .3, nb: null, lat: 0, kick: 1, amp: 30 };
  for (let i = 0; i < n; i++){
    const t = i / (n - 1);
    const om = kTop + (kTip - kTop) * t, z = zTop + (zTip - zTop) * t;
    ch.k.push(om * om); ch.c.push(2 * z * om);
    ch.x.push(0); ch.y.push(0); ch.vx.push(0); ch.vy.push(0);
  }
  let d = 0;
  for (let i = 1; i < n; i++) d += HYPOT(restLocal[i][0] - restLocal[i-1][0], restLocal[i][1] - restLocal[i-1][1]);
  ch.seg = d / (n - 1);
  return ch;
}
function bzPlace(w, ch, face){                // drop a chain onto its rest pose
  const c = COS(face), s = SIN(face);
  for (let i = 0; i < ch.n; i++){
    const r = ch.rest[i];
    ch.x[i] = w.x + c*r[0] - s*r[1]; ch.y[i] = w.y + s*r[0] + c*r[1];
    ch.vx[i] = ch.vy[i] = 0;
  }
}
function bzKick(ch, fx, fy, from){           // an impulse, felt more towards the hem
  for (let i = 1; i < ch.n; i++){
    const k = (i / (ch.n - 1)); const g = k * k * (from == null ? 1 : from) * ch.kick;
    ch.vx[i] += fx * g; ch.vy[i] += fy * g;
  }
}
/* Where the under-cloak wants to be: on the main cloak. `s` is how far down the cloth
   the node is, `lat` how far to the side of the centre line. Past the main cloak's
   hem it carries on in the direction that hem was going. */
function bzRide(lead, s, lat, out){
  const n = lead.n, seg = lead.seg, f = s / seg;
  let i0 = Math.min(n - 2, f | 0), u = f - i0;
  const dx = lead.x[i0 + 1] - lead.x[i0], dy = lead.y[i0 + 1] - lead.y[i0], L = HYPOT(dx, dy) || 1;
  out[0] = lead.x[i0] + dx * u + dy / L * lat;
  out[1] = lead.y[i0] + dy * u - dx / L * lat;
}
function bzStepChain(w, ch, face, h, t, ph, amp, gust, v, lead){
  const c = COS(face), s = SIN(face), n = ch.n;
  // the drag: when the boss is streaking (a dash) the cloth is laid out along the line it came, like a
  // scarf in a slipstream, and holds there a moment before it comes home
  const st = v.stream, ks = 1 + 1.6*st, cs = Math.sqrt(ks);
  const scr = COS(v.srel), scs = SIN(v.srel);
  // the root is nailed to the body
  ch.x[0] = w.x + c*ch.rest[0][0] - s*ch.rest[0][1];
  ch.y[0] = w.y + s*ch.rest[0][0] + c*ch.rest[0][1];
  ch.vx[0] = ch.vy[0] = 0;
  // the rest pose hangs from the cloth's own heading, a slower one than the body's (see bzAdvance), so a
  // quick turn of the body swings the cloth round after it rather than flicking it
  const C2 = COS(v.cf), S2 = SIN(v.cf);
  const nx = -S2, ny = C2;                     // across the cloth
  const px = [], py = [];
  px.push(ch.x[0]); py.push(ch.y[0]);
  for (let i = 1; i < n; i++){
    const r = ch.rest[i], k = i / (n - 1);
    let rx = w.x + C2*r[0] - S2*r[1], ry = w.y + S2*r[0] + C2*r[1];
    let hx = rx, hy = ry;                       // where it would hang if the boss stood still
    if (st > .002){
      // ...and where it streams to: straight out along the slipstream, its spread narrowed and turned with it,
      // a wave running down it that is felt most at the hem
      const lat = r[1] - ch.rest[0][1], lx = -S2*lat*.4, ly = C2*lat*.4;
      const rip = SIN(t*26 - i*.85 + ph*2) * 8 * k * st * v.calm;
      const qx = ch.x[0] + v.sdx*i*ch.seg + lx*scr - ly*scs - v.sdy*rip;
      const qy = ch.y[0] + v.sdy*i*ch.seg + lx*scs + ly*scr + v.sdx*rip;
      const wg = st * (.2 + .8*k);
      rx += (qx - rx) * wg; ry += (qy - ry) * wg;
    }
    if (lead){
      // the under-cloak lies on the cloak: it is pulled towards the cloak's own shape, so it follows the
      // cloak (a beat behind) instead of flapping about under it on its own
      bzRide(lead, i * ch.seg, r[1] - ch.rest[0][1], RIDE);
      rx += (RIDE[0] - rx) * .8; ry += (RIDE[1] - ry) * .8;
    }
    // spring to where the cloth would hang, damping, and a flutter that lives in
    // the force (never the positions) so it cannot kink the chain
    const fl = (SIN(t*3.4 - i*.55 + ph)*.6 + SIN(t*5.3 - i*.31 + ph*1.7)*.4) * amp * (.25 + .75*k) * (.5 + gust) * (1 - st);
    let fx = (rx - ch.x[i]) * ch.k[i] * ks, fy = (ry - ch.y[i]) * ch.k[i] * ks;
    if (ch.nb){
      // neighbouring strands pull each other's displacement into step: that is what
      // makes five strands one sheet of cloth instead of five ribbons
      let sx = 0, sy = 0;
      for (const nb of ch.nb){
        const q = nb.rest[i];
        sx += nb.x[i] - (w.x + C2*q[0] - S2*q[1]); sy += nb.y[i] - (w.y + S2*q[0] + C2*q[1]);
      }
      sx /= ch.nb.length; sy /= ch.nb.length;
      const kl = ch.lat * (.3 + .7*k) * (1 - st);
      fx += (sx - (ch.x[i] - hx)) * kl; fy += (sy - (ch.y[i] - hy)) * kl;
    }
    ch.vx[i] += (fx - ch.vx[i] * ch.c[i] * cs + nx * fl) * h;
    ch.vy[i] += (fy - ch.vy[i] * ch.c[i] * cs + ny * fl) * h;
    px.push(ch.x[i] + ch.vx[i]*h); py.push(ch.y[i] + ch.vy[i]*h);
  }
  /* Lay the chain out again from the root, one link at a time: each link keeps
     exactly its length (that is what makes it cloth and not a wobbling spring)
     and bends no more than `cap` from the link before it (so it cannot fold
     through itself). Built forwards from a node that is already final, so both
     rules hold exactly and there is nothing left to iterate or to argue about. */
  let a0 = 0;
  const rear = v.cf + Math.PI;
  for (let i = 1; i < n; i++){
    let a1 = ATAN2(py[i] - py[i-1], px[i] - px[i-1]);
    if (i > 1){
      const rel = angleTo(a0, a1);
      if (rel > ch.cap) a1 = a0 + ch.cap; else if (rel < -ch.cap) a1 = a0 - ch.cap;
    }
    // a cape hangs behind its wearer: no link of it is allowed to point round the front of the body
    const off = angleTo(rear, a1);
    if (off > BZ_SWING) a1 = rear + BZ_SWING; else if (off < -BZ_SWING) a1 = rear - BZ_SWING;
    px[i] = px[i-1] + COS(a1) * ch.seg; py[i] = py[i-1] + SIN(a1) * ch.seg;
    a0 = a1;
  }
  for (let i = 1; i < n; i++){
    let vx = (px[i] - ch.x[i]) / h, vy = (py[i] - ch.y[i]) / h;
    const sp = HYPOT(vx, vy);
    if (sp > 700){ vx *= 700 / sp; vy *= 700 / sp; }
    ch.vx[i] = vx; ch.vy[i] = vy;
    ch.x[i] = px[i]; ch.y[i] = py[i];
  }
}
// target pose for one arm, seen from the boss's drawn frame
function bzTarget(w, i, face){
  const B = w.boss, t = w.target, A = B.arms[i];
  let P = [150, 0];
  if (t){
    const dx = t.x - w.x, dy = t.y - w.y, c = COS(face), s = SIN(face);
    P = [(dx*c + dy*s) / BOSS_SCALE, (-dx*s + dy*c) / BOSS_SCALE];
  }
  return bossPose(i, A.k, P, A.foc, A.cf, A.rc, A.rw);
}
// one sheet of cloth: `n` strands hung side by side from the collar, joined so they move as one
function bzSheet(n, len, fan, root, kTop, kTip, zTop, zTip, lat, cut, opt){
  const strands = [];
  for (let c = 0; c < n; c++){
    const sp = n === 1 ? 0 : (c - (n - 1) / 2) / ((n - 1) / 2);          // -1 .. 1 across the cloak
    const L = len - cut * sp * sp;                                       // the middle runs longest
    const rest = [];
    for (let i = 0; i < BZV_ROWS; i++){
      const t = i / (BZV_ROWS - 1);
      rest.push([-(6 + L * t) * BOSS_SCALE, sp * (root + fan * t) * BOSS_SCALE]);
    }
    const ch = bzChain(BZV_ROWS, rest, kTop, kTip, zTop, zTip);
    ch.cap = opt.cap; ch.lat = lat; ch.kick = opt.kick; ch.amp = opt.amp;
    strands.push(ch);
  }
  for (let c = 0; c < n; c++){
    const nb = [];
    if (c > 0) nb.push(strands[c - 1]);
    if (c < n - 1) nb.push(strands[c + 1]);
    strands[c].nb = nb;
  }
  return strands;
}
function bzView(w){
  let v = w.view;
  if (v) return v;
  const B = w.boss;
  v = w.view = { t: 0, face: w.facing, fv: 0, x: w.x, y: w.y, arms: [], cloak: [], under: [],
                 fired: [0,0,0,0], hurt: 0, prevK: [0,0,0,0], swap: 0, ph: (w.id || 0) * 1.3,
                 hat: 0, hatv: 0, ring: 0, ringv: 0, spinning: false, flashN: B.flashN, star: null,
                 cf: w.facing, stream: 0, sx0: -COS(w.facing), sy0: -SIN(w.facing), sdx: -COS(w.facing), sdy: -SIN(w.facing), srel: 0, calm: 1,
                 tr: [[], [], [], []] };
  for (let i = 0; i < 4; i++){
    const T = bzTarget(w, i, v.face);
    v.arms.push({ E: T.E.slice(), Ev: [0,0], H: T.H.slice(), Hv: [0,0], a: ATAN2(T.T[1]-T.H[1], T.T[0]-T.H[0]), av: 0 });
  }
  // the under-cloak is the longer, thinner cloth behind the main one. It used to be the loosest thing on
  // the boss (a slack spring, hardly any damping, the strongest flutter) and it thrashed; it is now
  // the heavier, better-damped of the two, so it follows the cloak rather than fighting it.
  v.under = bzSheet(BZV_UCOLS, 150, 26, 10, 22, 11, .95, .82, 110, 26, { cap: .3, kick: .35, amp: 12 });
  v.cloak = bzSheet(BZV_COLS, 124, 38, 14, 26, 10, .85, .5, 140, 18, { cap: .22, kick: .8, amp: 22 });
  for (const ch of v.under) bzPlace(w, ch, v.face);
  for (const ch of v.cloak) bzPlace(w, ch, v.face);
  return v;
}
function bzCloth(v){ return v.cloak.concat(v.under); }
// how far through its spin the hat has come (0..1) -> how far round it has turned (0..1)
function bzSpinEase(K){ const q = 1 - K; return K < .5 ? 4*K*K*K : 1 - 4*q*q*q; }
function bzAdvance(w, dt){
  const B = w.boss, v = bzView(w);
  const moved = HYPOT(w.x - v.x, w.y - v.y) > 120;
  if (moved){                                    // it arrived, or was moved: do not drag the cloth across the arena
    v.face = w.facing; v.fv = 0; v.stream = 0; v.cf = w.facing;
    for (const ch of bzCloth(v)) bzPlace(w, ch, v.face);
    for (const q of v.tr) q.length = 0;
  }
  const mvx = moved ? 0 : (w.x - v.x) / Math.max(dt, 1e-3), mvy = moved ? 0 : (w.y - v.y) / Math.max(dt, 1e-3);
  const speed = HYPOT(mvx, mvy);
  v.x = w.x; v.y = w.y;
  const calm = REDUCED ? .35 : 1;
  v.calm = calm;
  /* The drag. A walk does not stream the cloth; a dash (five times the pace) does, at once, and lets go
     slowly — so the cloth lies out along the line the boss came for a beat after it has stopped, then
     comes home without a flap. The way it streams is opposite to the way it went, but never round the
     front of the body: a dash backwards throws it out to the side instead. */
  v.cf += angleTo(v.cf, v.face) * (1 - Math.exp(-6 * dt));      // the cloth's heading: the body's, a beat late
  const sk = clamp((speed - 260) / 420, 0, 1);
  v.stream += (sk - v.stream) * (1 - Math.exp(-(sk > v.stream ? 26 : 2.1) * dt));
  if (speed > 200){ v.sx0 = -mvx / speed; v.sy0 = -mvy / speed; }
  {
    const rear = v.face + Math.PI, rel = clamp(angleTo(rear, ATAN2(v.sy0, v.sx0)), -1.75, 1.75), a = rear + rel;
    v.srel = rel; v.sdx = COS(a); v.sdy = SIN(a);
  }
  const nsub = Math.max(1, Math.ceil(dt / BZV_H)), h = dt / nsub;
  const cloth = bzCloth(v);

  // events the cloth and arms should react to (read from the sim, never written to it)
  for (let i = 0; i < 4; i++){
    const A = B.arms[i], seen = v.fired[i];
    if (A.fired > seen + .02){                   // a wand just went off: recoil, and the cloth is thrown back
      const T = bzTarget(w, i, v.face), a = v.arms[i];
      const dx = T.T[0] - T.H[0], dy = T.T[1] - T.H[1], d = HYPOT(dx, dy) || 1;
      a.Hv[0] -= dx/d * 150 * calm; a.Hv[1] -= dy/d * 150 * calm;
      a.av += (i % 2 ? -1 : 1) * 9 * calm;
      const c = COS(v.face), s = SIN(v.face);
      const bx = -(c*dx/d - s*dy/d), by = -(s*dx/d + c*dy/d);
      for (const ch of cloth) bzKick(ch, bx * 20 * calm, by * 20 * calm);
    }
    v.fired[i] = A.fired;
  }
  if (w.hurt > v.hurt + .15){                    // flinch
    for (const ch of cloth) bzKick(ch, vrnd(-32, 32) * calm, vrnd(-32, 32) * calm);
  }
  v.hurt = w.hurt;
  let du = 0;                                    // arms going round the back stir the air
  for (let i = 0; i < 4; i++){ du += Math.abs(B.arms[i].k - v.prevK[i]); v.prevK[i] = B.arms[i].k; }
  du /= Math.max(dt, 1e-3);
  v.swap += (Math.min(1.6, du) - v.swap) * Math.min(1, dt * 6);
  if (B.flashN !== v.flashN){                    // the star: a blast of air out from the boss
    v.flashN = B.flashN;
    v.star = { t: 0, color: B.combo ? B.combo.color : BOSS_TINT };
    if (!REDUCED){ flash = Math.max(flash, .22); flashColor = v.star.color; }
    for (const ch of cloth) bzKick(ch, -COS(v.face) * 70 * calm, -SIN(v.face) * 70 * calm);
  }
  if (v.star){ v.star.t += dt; if (v.star.t > .85) v.star = null; }

  // the hat's spin: the sim says how far through it we are; these follow with a little spring
  const spinning = B.phase === "spin";
  if (v.spinning && !spinning){ v.hat -= TAU * BZ_HAT_TURNS; v.ring -= TAU * BZ_RING_TURNS; }   // it landed on a whole number of turns
  v.spinning = spinning;
  const e = spinning ? bzSpinEase(B.spinK) : 0;
  const hatT = TAU * BZ_HAT_TURNS * e, ringT = TAU * BZ_RING_TURNS * e;

  for (let s = 0; s < nsub; s++){
    v.t += h;
    // body facing: a slightly under-damped spring chasing the simulated facing, plus a slow breath
    const want = w.facing + .028 * SIN(v.t * 2.3 + v.ph) * calm;
    const dF = angleTo(v.face, want);
    v.fv += (dF * BZV_FACE.w * BZV_FACE.w - v.fv * 2 * BZV_FACE.z * BZV_FACE.w) * h;
    v.face += v.fv * h;
    v.hatv += ((hatT - v.hat) * BZV_HAT.w * BZV_HAT.w - v.hatv * 2 * BZV_HAT.z * BZV_HAT.w) * h;
    v.hat += v.hatv * h;
    v.ringv += ((ringT - v.ring) * BZV_RING.w * BZV_RING.w - v.ringv * 2 * BZV_RING.z * BZV_RING.w) * h;
    v.ring += v.ringv * h;
    // arms
    for (let i = 0; i < 4; i++){
      const T = bzTarget(w, i, v.face), a = v.arms[i], A = B.arms[i];
      let tE = T.E, tH = T.H;
      const dx = T.T[0] - T.H[0], dy = T.T[1] - T.H[1], d = HYPOT(dx, dy) || 1;
      if (A.st === 0 && bossLive(B, i) && A.t > 0){        // winding up: the hand draws back a touch against the coming cast
        const k = clamp(A.t / A.dur, 0, 1), pull = k * k * 4.5;
        tH = [tH[0] - dx/d*pull, tH[1] - dy/d*pull];
      }
      const tA = ATAN2(T.T[1] - T.H[1], T.T[0] - T.H[0]);
      for (let q = 0; q < 2; q++){
        a.Ev[q] += ((tE[q] - a.E[q]) * BZV_ARM.E.w*BZV_ARM.E.w - a.Ev[q] * 2*BZV_ARM.E.z*BZV_ARM.E.w) * h;
        a.E[q] += a.Ev[q] * h;
        a.Hv[q] += ((tH[q] - a.H[q]) * BZV_ARM.H.w*BZV_ARM.H.w - a.Hv[q] * 2*BZV_ARM.H.z*BZV_ARM.H.w) * h;
        a.H[q] += a.Hv[q] * h;
      }
      a.av += (angleTo(a.a, tA) * BZV_ARM.A.w*BZV_ARM.A.w - a.av * 2*BZV_ARM.A.z*BZV_ARM.A.w) * h;
      a.a += a.av * h;
    }
    // cloth: the strands of one sheet ripple a little out of step with each other, so waves travel across it
    const gust = Math.min(1.5, speed / 150 + v.swap * .5 + Math.min(1, Math.abs(v.hatv) / 16));
    for (let c = 0; c < v.cloak.length; c++) bzStepChain(w, v.cloak[c], v.face, h, v.t, c * .55 + v.ph, v.cloak[c].amp * calm, gust, v);
    for (let c = 0; c < v.under.length; c++) bzStepChain(w, v.under[c], v.face, h, v.t * .9, c * .7 + v.ph + 1.9, v.under[c].amp * calm, gust, v, v.cloak[v.cloak.length >> 1]);
  }
  // where the hems have been, while it streams: the streak the drag leaves in the air
  for (const q of v.tr) for (const p of q) p.t += dt;
  for (const q of v.tr) while (q.length && q[0].t > .5) q.shift();
  if (v.stream > .25 && !REDUCED){
    const src = [v.cloak[0], v.cloak[2], v.cloak[4], v.under[1]];
    for (let i = 0; i < 4; i++){ const ch = src[i], N = ch.n - 1; v.tr[i].push({ x: ch.x[N], y: ch.y[N], t: 0 }); }
  }
}
function updateBossView(dt){
  if (!(dt > 0)) return;
  const step = Math.min(dt, 1 / 30);
  for (const w of wizards) if (w.boss && !w.dead) bzAdvance(w, step);
}
// world chain -> the boss's drawn frame, in design units
function bzLocalChain(w, ch, face){
  const c = COS(face), s = SIN(face), out = [];
  for (let i = 0; i < ch.n; i++){
    const dx = ch.x[i] - w.x, dy = ch.y[i] - w.y;
    out.push([(dx*c + dy*s) / BOSS_SCALE, (-dx*s + dy*c) / BOSS_SCALE]);
  }
  return out;
}

/* ---------------------------------------------------------- the cloak, drawn */
/* A cloak is one sheet: the outline runs down the left edge, along a soft hem drawn
   through the tips of the strands, and back up the right; between the strands the
   cloth is pleated (alternate light and dark panels that shift as it moves) and each
   strand is a fold line. `o` sets the colours. */
function bzSheetDraw(cols, o){
  const C = cols.length, N = cols[0].length, hem = cols.map(c => c[N - 1]);
  const trace = () => {
    ctx.beginPath(); ctx.moveTo(cols[0][0][0], cols[0][0][1]);
    for (let i = 1; i < N; i++) ctx.lineTo(cols[0][i][0], cols[0][i][1]);
    for (let c = 1; c < C - 1; c++) ctx.quadraticCurveTo(hem[c][0], hem[c][1], (hem[c][0] + hem[c+1][0]) / 2, (hem[c][1] + hem[c+1][1]) / 2);
    ctx.lineTo(hem[C-1][0], hem[C-1][1]);
    for (let i = N - 2; i >= 0; i--) ctx.lineTo(cols[C-1][i][0], cols[C-1][i][1]);
    ctx.closePath();
  };
  const mid = cols[C >> 1];
  ctx.save();
  ctx.globalAlpha = .3; ctx.fillStyle = "#04050b"; ctx.save(); ctx.translate(1.8, 3); trace(); ctx.fill(); ctx.restore(); ctx.globalAlpha = 1;
  const g = ctx.createLinearGradient(mid[0][0], mid[0][1], mid[N-1][0], mid[N-1][1]);
  g.addColorStop(0, rgba(o.col, o.a0)); g.addColorStop(.6, rgba(o.col, o.a1)); g.addColorStop(1, rgba(o.col, o.a2));
  trace(); ctx.fillStyle = g; ctx.fill();
  ctx.save(); trace(); ctx.clip();
  // pleats
  for (let c = 0; c < C - 1; c++){
    ctx.beginPath(); ctx.moveTo(cols[c][0][0], cols[c][0][1]);
    for (let i = 1; i < N; i++) ctx.lineTo(cols[c][i][0], cols[c][i][1]);
    for (let i = N - 1; i >= 0; i--) ctx.lineTo(cols[c+1][i][0], cols[c+1][i][1]);
    ctx.closePath();
    ctx.globalAlpha = o.pleat; ctx.fillStyle = c & 1 ? "#05060c" : "#fff"; ctx.fill();
  }
  // the folds: one line down each inner strand, a pale one with a dark one beside it
  for (let c = 1; c < C - 1; c++){
    ctx.beginPath(); cols[c].forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    ctx.globalAlpha = .22; ctx.strokeStyle = "#05070f"; ctx.lineWidth = 3.4; ctx.save(); ctx.translate(1.4, .6); ctx.stroke(); ctx.restore();
    ctx.globalAlpha = o.fold; ctx.strokeStyle = "#fff"; ctx.lineWidth = .85; ctx.stroke();
  }
  // a pale band along the hem
  ctx.globalAlpha = o.band; ctx.fillStyle = "#fff";
  ctx.beginPath(); for (let c = 0; c < C; c++){ const p = cols[c][N - 3]; c ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }
  for (let c = C - 1; c >= 0; c--) ctx.lineTo(cols[c][N-1][0], cols[c][N-1][1]);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;
  trace(); bzEdge(o.edge || BOSS_TINT);
  if (o.hem){
    ctx.globalAlpha = .8; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.05;
    ctx.beginPath(); ctx.moveTo(hem[0][0], hem[0][1]);
    for (let c = 1; c < C - 1; c++) ctx.quadraticCurveTo(hem[c][0], hem[c][1], (hem[c][0] + hem[c+1][0]) / 2, (hem[c][1] + hem[c+1][1]) / 2);
    ctx.lineTo(hem[C-1][0], hem[C-1][1]); ctx.stroke(); ctx.globalAlpha = 1;
  }
  ctx.restore();
}
// the streaks the hems leave while the boss is being dragged along: drawn in the world, so they stay where they were
function bzTrailDraw(w, v){
  ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
  // the cloth's own wake: the ribbon between the two outer hems
  const A = v.tr[0], Bq = v.tr[2];
  if (A.length > 1 && A.length === Bq.length){
    const pa = bzLocalChain(w, { n: A.length, x: A.map(p => p.x), y: A.map(p => p.y) }, v.face);
    const pb = bzLocalChain(w, { n: Bq.length, x: Bq.map(p => p.x), y: Bq.map(p => p.y) }, v.face);
    ctx.fillStyle = BOSS_TINT;
    for (let j = 1; j < pa.length; j++){
      const k = 1 - A[j].t / .5;
      if (k <= 0) continue;
      ctx.globalAlpha = .3 * k * k;
      ctx.beginPath(); ctx.moveTo(pa[j-1][0], pa[j-1][1]); ctx.lineTo(pa[j][0], pa[j][1]); ctx.lineTo(pb[j][0], pb[j][1]); ctx.lineTo(pb[j-1][0], pb[j-1][1]); ctx.closePath(); ctx.fill();
    }
  }
  for (let i = 0; i < v.tr.length; i++){
    const q = v.tr[i];
    if (q.length < 2) continue;
    const pts = bzLocalChain(w, { n: q.length, x: q.map(p => p.x), y: q.map(p => p.y) }, v.face);
    for (let j = 1; j < pts.length; j++){
      const k = 1 - q[j].t / .5;
      if (k <= 0) continue;
      ctx.strokeStyle = i === 1 ? "#ffffff" : BOSS_TINT;
      ctx.globalAlpha = .8 * k * k * (i === 3 ? .6 : 1);
      ctx.lineWidth = (i === 1 ? 3 : 5) * (.3 + .7 * k);
      ctx.beginPath(); ctx.moveTo(pts[j-1][0], pts[j-1][1]); ctx.lineTo(pts[j][0], pts[j][1]); ctx.stroke();
    }
  }
  ctx.restore();
}
function bzCloakDraw(w, v){
  bzTrailDraw(w, v);
  bzSheetDraw(v.under.map(ch => bzLocalChain(w, ch, v.face)),
              { col: "#7a1838", a0: .9, a1: .62, a2: .34, pleat: .10, fold: .16, band: .08, edge: "#c4487a", hem: false });
  bzSheetDraw(v.cloak.map(ch => bzLocalChain(w, ch, v.face)),
              { col: BZ.cloth, a0: .97, a1: .82, a2: .56, pleat: .085, fold: .26, band: .17, hem: true });
}
// the sheaths on the back the wands go into while the hat spins: four loops on a curved plate
function bzBack(v){
  ctx.save();
  ctx.lineCap = "round";
  ctx.globalAlpha = .9; ctx.strokeStyle = BZ.outline; ctx.lineWidth = 6.4;
  ctx.beginPath(); ctx.arc(0, 0, 64, Math.PI - .62, Math.PI + .62); ctx.stroke();
  ctx.strokeStyle = BZ.joint; ctx.lineWidth = 4.2; ctx.stroke();
  ctx.globalAlpha = .55; ctx.strokeStyle = BOSS_TINT; ctx.lineWidth = 1; ctx.stroke();
  ctx.globalAlpha = 1;
  for (const a of BOSS_ARMS){
    ctx.fillStyle = BZ.outline; ctx.beginPath(); ctx.arc(a.stow.H[0], a.stow.H[1], 4.6, 0, TAU); ctx.fill();
    ctx.strokeStyle = BOSS_TINT; ctx.globalAlpha = .6; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(a.stow.H[0], a.stow.H[1], 4.6, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function bzSeg(p, q, w, col, a, dx, dy){
  dx = dx || 0; dy = dy || 0;
  ctx.globalAlpha = a == null ? 1 : a; ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(p[0] + dx, p[1] + dy); ctx.lineTo(q[0] + dx, q[1] + dy); ctx.stroke(); ctx.globalAlpha = 1;
}
function bzArm(a){
  const w1 = 5, w2 = 4.2;
  bzSeg(a.S, a.E, w1 + 7, BOSS_TINT, .10); bzSeg(a.E, a.H, w2 + 7, BOSS_TINT, .10);
  bzSeg(a.S, a.E, w1 + 2.4, BZ.outline); bzSeg(a.E, a.H, w2 + 2.4, BZ.outline);
  bzSeg(a.S, a.E, w1 + 2.4, BOSS_TINT, .35 + .25*a.w);
  bzSeg(a.S, a.E, w1, BZ.arm); bzSeg(a.E, a.H, w2, BZ.arm);
  bzSeg(a.S, a.E, w1*.3, BZ.armLit, .75, -.8, -.9); bzSeg(a.E, a.H, w2*.3, BZ.armLit, .75, -.7, -.8);
  ctx.fillStyle = BZ.joint; ctx.strokeStyle = BOSS_TINT; ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.arc(a.E[0], a.E[1], w1*.95, 0, TAU); ctx.fill(); ctx.globalAlpha = .85; ctx.stroke(); ctx.globalAlpha = 1;
  bzSeg(a.H, a.T, 3.8, BZ.outline); bzSeg(a.H, a.T, 2.4, "#c8b48a");
  ctx.fillStyle = BZ.joint; ctx.beginPath(); ctx.arc(a.H[0], a.H[1], w2*1.05, 0, TAU); ctx.fill();
  ctx.strokeStyle = BOSS_TINT; ctx.globalAlpha = .6; ctx.stroke(); ctx.globalAlpha = 1;
}
function bzTip(a, color, k){
  if (a.w < .5) return;
  const x = a.T[0], y = a.T[1];
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  bzGlow(x, y, 1.5 + k*4.5, 5 + k*15, color, .55 + .4*k);
  bzGlow(x, y, 1.2 + k*1.6, 1.5, "#ffffff", .9);
  ctx.globalAlpha = .55; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(x, y, 4 + k*9, -Math.PI/2, -Math.PI/2 + TAU*k); ctx.stroke();
  ctx.restore();
}
function bzCone(dx, dy){
  const cl = BZ.coneLen;
  ctx.beginPath(); ctx.arc(2.5 + dx, dy, 7.2, -Math.PI*.5, Math.PI*.5);
  ctx.quadraticCurveTo(-5 + dx, 6.4 + dy, -cl + dx, dy);
  ctx.quadraticCurveTo(-5 + dx, -6.4 + dy, 2.5 + dx, -7.2 + dy); ctx.closePath();
}
/* The hat. The cone turns with the hat; the ring of six stones on the brim turns
   with it and a little more, and comes to rest with the two chosen stones under
   the two reading marks. st = { hat, ring, ringv, spin, lockK, wake, fuseK, col[6], k[2], next, nextCol, comboCol } */
function bzHat(w, st){
  const s = BZ.hs, hurt = w.hurt > 0;
  ctx.save(); ctx.scale(s, s);
  ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.beginPath(); ctx.ellipse(1, 3, 16, 15, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(5.5, 0, 10.5, 13, 0, 0, TAU);
  ctx.fillStyle = shade(BZ.brim, -.25); ctx.fill(); ctx.globalAlpha = .45; ctx.strokeStyle = BOSS_TINT; ctx.lineWidth = 1.3; ctx.stroke(); ctx.globalAlpha = 1;
  bzHalo(15, hurt ? 24 : 9, BOSS_TINT, .7);
  ctx.beginPath(); ctx.arc(0, 0, 15, 0, TAU); ctx.fillStyle = BZ.brim; ctx.fill();
  ctx.strokeStyle = BOSS_TINT; ctx.lineWidth = 2; ctx.stroke();
  ctx.globalAlpha = .16; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, 12, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;

  // the cone, turning
  ctx.save(); ctx.rotate(st.hat);
  ctx.globalAlpha = .5; ctx.fillStyle = "#05060c"; bzCone(1.6, 2.8); ctx.fill(); ctx.globalAlpha = 1;
  bzCone(0, 0); ctx.fillStyle = hurt ? "#ff7d89" : BZ.cone; ctx.fill(); ctx.strokeStyle = BOSS_TINT; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.save(); bzCone(0, 0); ctx.clip(); ctx.globalAlpha = .55; ctx.fillStyle = BZ.lit;
  ctx.beginPath(); ctx.moveTo(12, -10); ctx.quadraticCurveTo(-4, -8.4, -18, -1.4); ctx.lineTo(-18, -4); ctx.lineTo(12, -4); ctx.closePath(); ctx.fill(); ctx.restore(); ctx.globalAlpha = 1;
  ctx.globalAlpha = .55; ctx.strokeStyle = "#0a0d16"; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.arc(2.5, 0, 7.2, -Math.PI*.38, Math.PI*.38); ctx.stroke(); ctx.globalAlpha = 1;
  // the cone tip burns in the colour of whatever fires first (or of the fused spell)
  const tx = -BZ.coneLen + .8, tc = st.nextCol || st.next;
  if (tc){
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    bzGlow(tx, 0, 1.8, 5.5, tc, .85); bzGlow(tx, 0, .9, .6, "#ffffff", 1); ctx.restore();
  } else { ctx.fillStyle = BOSS_TINT; ctx.globalAlpha = .9; ctx.beginPath(); ctx.arc(tx, 0, 1.9, 0, TAU); ctx.fill(); ctx.globalAlpha = 1; }
  ctx.restore();

  // the reading marks: two small wedges on the brim, where a stone must sit to count
  for (const sg of [-1, 1]){
    const a = sg * 60 * D2R, ca = COS(a), sa = SIN(a);
    const lit = .35 + .5 * st.lockK + .3 * st.wake * (.5 + .5 * SIN(w.view.t * 40));
    ctx.globalAlpha = Math.min(1, lit); ctx.fillStyle = BOSS_TINT;
    ctx.beginPath();
    ctx.moveTo(ca * 16.9, sa * 16.9);
    ctx.lineTo(ca * 20.8 - sa * 2.2, sa * 20.8 + ca * 2.2);
    ctx.lineTo(ca * 20.8 + sa * 2.2, sa * 20.8 - ca * 2.2);
    ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
  }
  // the ring of stones
  const R = 14.2, spin = st.spin, sm = Math.min(.55, Math.abs(st.ringv) * .028) * spin;
  for (let j = 0; j < 6; j++){
    const lock = j === 0 || j === 2;
    const ang = st.ring + (-60 + 60 * j) * D2R;
    const c = st.col[j];
    const lk = lock ? st.lockK : 0;
    const live = lock && lk > .5 && !spin;
    const k = live ? st.k[j === 0 ? 0 : 1] : 0;
    const wob = lock && st.wake > 0 ? SIN(w.view.t * 55 + j) * .5 * st.wake : 0;
    const x = COS(ang) * (R + wob), y = SIN(ang) * (R + wob);
    const r = spin ? 3.5 + 1.2 * lk : (lock ? 2.9 + 1.9 * lk : 2.9);
    if (sm > .03){                                   // motion smear: the stone leaves a comet's tail behind it
      ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
      const dir = st.ringv > 0 ? -1 : 1;
      ctx.globalAlpha = .5; ctx.strokeStyle = c; ctx.lineWidth = r * 1.5;
      ctx.beginPath(); ctx.arc(0, 0, R, ang, ang + dir * sm * 2.4, dir < 0); ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = "#12060c"; ctx.beginPath(); ctx.arc(x, y, r + 1.6, 0, TAU); ctx.fill();
    ctx.strokeStyle = live ? "#ffffff" : BOSS_TINT; ctx.globalAlpha = live ? .75 : .5; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    bzGlow(x, y, r * .8, live ? 4 + 9 * k : 2.5 + 3 * spin + 5 * lk, c, live ? .45 + .45 * k : .2 + .3 * spin + .3 * lk);
    ctx.restore();
    ctx.globalAlpha = live || spin ? 1 : .55 + .45 * lk; ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(255,255,255," + (live ? .35 + .6 * k : .15 + .3 * spin + .3 * lk) + ")";
    ctx.beginPath(); ctx.arc(x - r * .25, y - r * .25, r * .38, 0, TAU); ctx.fill();
    if (live){
      ctx.globalAlpha = .28; ctx.strokeStyle = c; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.arc(x, y, r + 3.3, 0, TAU); ctx.stroke();
      ctx.globalAlpha = .95; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.lineCap = "round";
      ctx.beginPath(); ctx.arc(x, y, r + 3.3, -Math.PI/2, -Math.PI/2 + TAU * k); ctx.stroke(); ctx.globalAlpha = 1;
    } else if (lock && lk > 0 && lk < 1){            // just locking: a ring snaps shut round it
      ctx.globalAlpha = .9 * (1 - lk * .6); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x, y, r + 3.3 + (1 - lk) * 6, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
    }
  }
  // the two stones are joined while their spells are being fused
  if (st.fuseK > 0){
    const a0 = -60 * D2R, a1 = 60 * D2R;
    ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
    ctx.strokeStyle = st.comboCol; ctx.globalAlpha = .35 + .5 * st.fuseK; ctx.lineWidth = 1 + 2.2 * st.fuseK;
    ctx.beginPath(); ctx.moveTo(COS(a0) * R, SIN(a0) * R); ctx.quadraticCurveTo(R * 1.15, 0, COS(a1) * R, SIN(a1) * R); ctx.stroke();
    ctx.globalAlpha = .9; ctx.strokeStyle = "#fff"; ctx.lineWidth = .8;
    ctx.beginPath(); ctx.moveTo(COS(a0) * R, SIN(a0) * R); ctx.quadraticCurveTo(R * 1.15, 0, COS(a1) * R, SIN(a1) * R); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}
// the whole boss for one frame. The caller has translated to the boss and rotated
// to its DRAWN facing (the spring-smoothed one), exactly as drawWizard does for
// everyone else.
function drawBossBody(w){
  const B = w.boss, v = bzView(w);
  const intro = B.phase === "intro" ? clamp(1 - B.pt/1.3, 0, 1) : 1;
  const flashK = clamp(w.hurt, 0, 1);
  const F = B.fuse, fk = F ? (F.stage === 0 ? F.t / BOSS_FUSE_CHARGE : 1) : 0;
  const arms = [];
  for (let i = 0; i < 4; i++){
    const T = bzTarget(w, i, v.face), a = v.arms[i];
    arms.push({ i, id: T.id, S: T.S, w: T.w, E: a.E, H: a.H,
                T: [a.H[0] + COS(a.a)*BOSS_WAND, a.H[1] + SIN(a.a)*BOSS_WAND] });
  }
  const armK = i => {
    const A = B.arms[i];
    if (!bossLive(B, i) || A.st === 3 || A.st === 5) return 0;
    if (A.st === 0) return clamp(A.t / A.dur, 0, 1);
    if (A.st === 4) return fk;
    return 1;
  };
  const spinning = B.phase === "spin";
  const src = spinning && B.spinK < .48 ? B.prev : B.slots;
  const st = { hat: v.hat, ring: v.ring, ringv: v.ringv, spin: spinning ? 1 : 0,
               lockK: spinning ? clamp((B.spinK - .8) / .2, 0, 1) : (B.phase === "intro" ? 0 : 1),
               wake: B.wake, fuseK: fk, comboCol: B.combo ? B.combo.color : "#fff",
               col: src.map(s => SPELLS[s].color),
               k: [armK(B.pair === 0 ? 0 : 3), armK(B.pair === 0 ? 1 : 2)],
               next: B.next >= 0 ? SPELLS[B.next].color : null, nextCol: B.nextCol };
  const breath = 1 + .014 * SIN(v.t * 3.1 + v.ph);
  ctx.save();
  ctx.scale(BOSS_SCALE * breath, BOSS_SCALE * breath);
  if (intro < 1){ const sc = .55 + .45*intro; ctx.scale(sc, sc); ctx.globalAlpha = .25 + .75*intro; }
  ctx.save(); ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.ellipse(4, 6, 50, 46, 0, 0, TAU); ctx.fill(); ctx.restore();
  bzCloakDraw(w, v);
  bzBack(v);
  arms.slice().sort((a, b) => a.w - b.w).forEach(bzArm);
  bzHat(w, st);
  for (const a of arms){
    const A = B.arms[a.i];
    if (!bossLive(B, a.i) || A.st === 3) continue;
    bzTip(a, SPELLS[A.spell].color, A.spell === 4 && A.st === 1 ? 1 : armK(a.i));
  }
  {
    // the mirror: light gathers between the two front hands as they clap, and a thread of it is drawn out between them as they fling apart
    const rcK = Math.min(B.arms[0].rc, B.arms[2].rc), rwK = Math.min(B.arms[0].rw, B.arms[2].rw);
    if (rcK > .03){
      const h0 = arms[0].H, h2 = arms[2].H, t0 = arms[0].T, t2 = arms[2].T;
      const mx = (h0[0] + h2[0]) / 2, my = (h0[1] + h2[1]) / 2, g = rcK * (1 - rwK * .75);
      ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
      if (g > .03){
        bzGlow(mx + 8, my, 3 + 5 * g, 8 + 16 * g, "#8fe9ff", .3 + .35 * g);
        bzGlow(mx + 8, my, 1.6 + 1.4 * g, 2.5, "#ffffff", .8);
      }
      if (rwK > .02){
        ctx.strokeStyle = "#bff4ff"; ctx.globalAlpha = .3 + .5 * rwK; ctx.lineWidth = 2.6 + 3 * rwK;
        ctx.beginPath(); ctx.moveTo(h0[0], h0[1]); ctx.lineTo(h2[0], h2[1]); ctx.stroke();
        ctx.strokeStyle = "#fff"; ctx.globalAlpha = .9 * rwK; ctx.lineWidth = 1;
        ctx.stroke();
      }
      for (const t of [t0, t2]) bzGlow(t[0], t[1], 1.5 + 2 * rcK, 6 + 10 * rcK, "#8fe9ff", .5 * rcK);
      ctx.restore();
    }
  }
  if (F){                                   // the two wands meet: light gathers between them
    const l = arms.filter(a => bossLive(B, a.i));
    if (l.length === 2){
      const c = B.combo.color, mx = (l[0].T[0] + l[1].T[0]) / 2, my = (l[0].T[1] + l[1].T[1]) / 2;
      ctx.save(); ctx.globalCompositeOperation = "lighter";
      strokeJag(jag(l[0].T[0], l[0].T[1], l[1].T[0], l[1].T[1], 5, 4 + 6 * fk), c, 1 + 2 * fk, .5 + .4 * fk);
      strokeJag(jag(l[0].T[0], l[0].T[1], l[1].T[0], l[1].T[1], 5, 2 + 3 * fk), "#fff", 1, .7);
      bzGlow(mx, my, 2 + 8 * fk, 8 + 22 * fk, c, .8);
      bzGlow(mx, my, 1.5 + 3 * fk, 2, "#ffffff", .95);
      ctx.restore();
    }
  }
  if (flashK > .02){
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = flashK*.55; ctx.fillStyle = flashK > .55 ? "#ffffff" : "#ff4d5e";
    ctx.beginPath(); ctx.arc(0, 0, BZ_BRIM, 0, TAU); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}
/* The star. A fused spell is announced by a large eight-pointed flash round the boss:
   four long spikes, four short, a bloom at the heart and two rings, all in the colour
   the new spell will be. World-space and unrotated: it does not turn with the boss. */
function bzStar(w, star){
  const t = star.t, T = .85;
  if (t > T) return;
  const grow = 1 - Math.pow(1 - Math.min(1, t / .26), 3);
  const fade = t < .3 ? 1 : Math.max(0, 1 - (t - .3) / (T - .3));
  const R = 175 * (.3 + .7 * grow);
  ctx.save(); ctx.globalCompositeOperation = "lighter";      // (the caller has already moved to the boss)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R * .6);
  g.addColorStop(0, rgba("#ffffff", .95 * fade)); g.addColorStop(.3, rgba(star.color, .6 * fade)); g.addColorStop(1, rgba(star.color, 0));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R * .6, 0, TAU); ctx.fill();
  const rot = -.4 + t * 1.1;
  for (let k = 0; k < 8; k++){
    const long = !(k & 1), len = (long ? 1 : .52) * R, wd = (long ? .085 : .06) * R;
    ctx.save(); ctx.rotate(rot + k * Math.PI / 4);
    const gg = ctx.createLinearGradient(0, 0, len, 0);
    gg.addColorStop(0, rgba("#ffffff", .95 * fade)); gg.addColorStop(.35, rgba(star.color, .65 * fade)); gg.addColorStop(1, rgba(star.color, 0));
    ctx.fillStyle = gg; ctx.beginPath(); ctx.moveTo(0, -wd); ctx.lineTo(len, 0); ctx.lineTo(0, wd); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.lineWidth = 1 + 3 * (1 - Math.min(1, t / T));
  ctx.strokeStyle = rgba(star.color, .85 * fade); ctx.beginPath(); ctx.arc(0, 0, R * (.2 + .8 * grow), 0, TAU); ctx.stroke();
  ctx.lineWidth = 1.4; ctx.strokeStyle = rgba("#ffffff", .6 * fade); ctx.beginPath(); ctx.arc(0, 0, R * .45 * grow + 8, 0, TAU); ctx.stroke();
  ctx.restore();
}
function drawBossWizard(w){
  const v = bzView(w);
  ctx.save();
  ctx.translate(w.x, w.y);
  drawWardArc(w, w.facing, WARD_R + 26);
  ctx.save();
  ctx.rotate(v.face);
  drawBossBody(w);
  ctx.restore();
  if (v.star) bzStar(w, v.star);
  ctx.restore();
}
// the boss's health, big, across the top of the arena
function drawBossBar(){
  const b = wizards.find(q => q.boss && !q.dead);
  if (!b) return;
  const bw = 380, bh = 9, x = (W - bw)/2, y = 18;
  const k = clamp(b.hp / b.hpMax, 0, 1);
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "700 13px Cinzel, Georgia, serif";
  ctx.fillStyle = BOSS_TINT; ctx.globalAlpha = .95;
  ctx.fillText("THE ALCHEMIST", W/2, y - 4);
  ctx.globalAlpha = .55; ctx.fillStyle = "#0a0410"; ctx.fillRect(x - 2, y - 2, bw + 4, bh + 4);
  ctx.globalAlpha = 1; ctx.fillStyle = "rgba(255,255,255,.12)"; ctx.fillRect(x, y, bw, bh);
  ctx.fillStyle = b.hp < b.hpMax*.4 ? "#ff4d5e" : BOSS_TINT; ctx.fillRect(x, y, bw*k, bh);
  ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1; ctx.strokeRect(x - .5, y - .5, bw + 1, bh + 1);
  // and under it, its mana: the wands run on it, and when it is low they hold
  const my = y + bh + 5, mh = 5, mk = clamp(b.mana / 100, 0, 1);
  const dry = b.boss && b.boss.arms.some(A => A.dry > .05);
  ctx.globalAlpha = .55; ctx.fillStyle = "#0a0410"; ctx.fillRect(x - 2, my - 2, bw + 4, mh + 4);
  ctx.globalAlpha = 1; ctx.fillStyle = "rgba(255,255,255,.1)"; ctx.fillRect(x, my, bw, mh);
  const mg = ctx.createLinearGradient(x, 0, x + bw, 0);
  mg.addColorStop(0, "#3f7fff"); mg.addColorStop(1, "#5aa9ff");
  ctx.fillStyle = dry ? "#8a9bc4" : mg; ctx.fillRect(x, my, bw*mk, mh);
  ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.strokeRect(x - .5, my - .5, bw + 1, mh + 1);
  ctx.restore();
}


// the wall held in front of a wizard. Same arc that blocks; `R` is how far out it stands
function drawWardArc(w, a, R){
  if (w.ward > 0){
    const k = w.ward / Math.max(1,w.wardMax);
    ctx.save();
    ctx.rotate(a);
    ctx.strokeStyle = byId.ward.color;
    ctx.shadowColor = byId.ward.color; ctx.shadowBlur = 18;
    // the drawn arc is the arc that blocks: same radius, same half-angle
    const half = Math.acos(WARD_COS);
    ctx.globalAlpha = .35 + k*.5;
    ctx.lineWidth = 3 + k*4;
    ctx.beginPath(); ctx.arc(0, 0, R, -half, half); ctx.stroke();
    ctx.globalAlpha = .18;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, R - 6, -half, half); ctx.stroke();
    // motes running the length of the wall, thinning out as it is spent
    const motes = 5 + Math.round(k*5);
    const spin = performance.now()/1100;
    ctx.shadowBlur = 14;
    for (let i = 0; i < motes; i++){
      const f = ((i/motes) + spin) % 1;
      const ang = -half + f*half*2;
      const rr = (R - 3) + SIN(spin*7 + i*1.7)*3.5;
      ctx.globalAlpha = (.35 + k*.6) * SIN(f*Math.PI);
      ctx.fillStyle = i % 4 ? byId.ward.color : "#dcffec";
      ctx.beginPath();
      ctx.arc(COS(ang)*rr, SIN(ang)*rr, 1.3 + k*1.7, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawWizard(w){
  if (w.boss){ drawBossWizard(w); return; }
  const a = w.facing;
  const tint = w.tint;
  /* The wizard wears their rank, not their side. Hat, brim and robe all come
     from the same family entry as the cloak, so a wizard in a green cloak is a
     green wizard and rank reads from the whole figure rather than from the
     cloth trailing behind it. Friend and foe are carried by the tint — the ring
     around the brim, the outline, the halo, the wand — which is the channel
     that was always doing that job anyway. */
  const rank = capeMarks(w);
  const robe = shade(rank.brim, -0.25);
  ctx.save();
  ctx.translate(w.x, w.y);

  drawCape(w);          // behind and beneath the wizard, before anything else

  // counter bonus: a gold corona that fades as the three seconds run out
  if (w.surge > 0){
    const k = Math.min(1, w.surge / SURGE_T);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = SURGE_COLOR;
    ctx.shadowColor = SURGE_COLOR; ctx.shadowBlur = 20;
    ctx.globalAlpha = .25 + k*.45;
    ctx.lineWidth = 1.5 + k*1.5;
    const puls = 22 + SIN(performance.now()/140)*1.6 + k*3;
    ctx.beginPath(); ctx.arc(0, 0, puls, 0, TAU); ctx.stroke();
    ctx.globalAlpha = (.12 + k*.22);
    ctx.beginPath(); ctx.arc(0, 0, puls*1.35, 0, TAU); ctx.stroke();
    ctx.restore();
  }

  drawWardArc(w, a, WARD_R);

  ctx.rotate(a);
  const flashK = clamp(w.hurt, 0, 1);
  // Straight down on a wizard you see a hat: a dark brim lying flat, and the
  // cone on top of it catching the light. Tone does the work at thirty pixels —
  // the cone has to be LIGHTER than the brim and cast a shadow onto it, or it
  // stops reading as something raised and turns into a wedge cut out of a disc.
  const brim = rank.brim;
  const cone = rank.hat;
  const lit  = rank.lit;
  // shadow on the floor
  ctx.fillStyle = "rgba(0,0,0,.45)";
  ctx.beginPath(); ctx.ellipse(1, 3, 16, 15, 0, 0, TAU); ctx.fill();

  // shoulders, leading the way — the brim sits back over them
  ctx.beginPath();
  ctx.ellipse(5.5, 0, 10.5, 13, 0, 0, TAU);
  ctx.fillStyle = robe; ctx.fill();
  ctx.globalAlpha = .45; ctx.strokeStyle = tint; ctx.lineWidth = 1.3; ctx.stroke();
  ctx.globalAlpha = 1;

  // The brim, flat on the floor. Its halo is a cached sprite — every wizard on
  // screen was otherwise costing two large blurred draws a frame, which at six
  // wizards was the most expensive thing left in the picture.
  blitSprite(haloSprite(tint, 15, w.hurt > 0 ? 24 : 9), 0, 0);
  ctx.beginPath(); ctx.arc(0, 0, 15, 0, TAU);
  ctx.fillStyle = brim; ctx.fill();
  ctx.strokeStyle = tint; ctx.lineWidth = 2; ctx.stroke();
  ctx.globalAlpha = .16; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, 12, 0, TAU); ctx.stroke();
  ctx.globalAlpha = 1;

  // The cone droops BACKWARDS, the way a real pointed hat does: it rises off the
  // crown and its tip trails behind the wizard. Pointing it forward laid the
  // point over their own face, which is what read wrong. Facing is carried by the
  // wand out front and the tail streaming behind, like a comet.
  // Traced twice — once offset as the shadow it throws across the brim, once properly.
  const conePath = (dx, dy) => {
    ctx.beginPath();
    ctx.arc(2.5 + dx, dy, 7.2, -Math.PI*0.5, Math.PI*0.5);
    ctx.quadraticCurveTo(-5 + dx, 6.4 + dy, -16.4 + dx, dy);
    ctx.quadraticCurveTo(-5 + dx, -6.4 + dy, 2.5 + dx, -7.2 + dy);
    ctx.closePath();
  };
  ctx.globalAlpha = .5; ctx.fillStyle = "#05060c";
  conePath(1.6, 2.8); ctx.fill();
  ctx.globalAlpha = 1;

  conePath(0, 0);
  ctx.fillStyle = w.hurt > 0 ? "#ff7d89" : cone; ctx.fill();
  ctx.strokeStyle = tint; ctx.lineWidth = 1.5; ctx.stroke();

  // the lit side of the cone, up along its back
  ctx.save();
  conePath(0, 0); ctx.clip();
  ctx.globalAlpha = .55; ctx.fillStyle = lit;
  ctx.beginPath();
  ctx.moveTo(12, -10);
  ctx.quadraticCurveTo(-4, -8.4, -18, -1.4);
  ctx.lineTo(-18, -4); ctx.lineTo(12, -4);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;

  // the hat band around the base of the cone
  ctx.globalAlpha = .55; ctx.strokeStyle = "#0a0d16"; ctx.lineWidth = 2.4;
  ctx.beginPath(); ctx.arc(2.5, 0, 7.2, -Math.PI*0.38, Math.PI*0.38); ctx.stroke();
  ctx.globalAlpha = 1;
  // a glint on the trailing tip
  ctx.fillStyle = w.hurt > 0 ? "#ff8a94" : tint; ctx.globalAlpha = .9;
  ctx.beginPath(); ctx.arc(-15.6, 0, 1.9, 0, TAU); ctx.fill();
  ctx.globalAlpha = 1;

  // struck: the whole figure blows out, white for a heavy hit, red for a graze
  if (flashK > 0.02){
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = flashK * .9;
    ctx.fillStyle = flashK > .55 ? "#ffffff" : "#ff4d5e";
    ctx.shadowColor = "#ff4d5e"; ctx.shadowBlur = 24*flashK;
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, TAU); ctx.fill();
    conePath(0, 0); ctx.fill();
    ctx.restore();
  }
  // arm sweep when they bat a spell aside
  const cast = w.swishKind === "cast";
  const sw = w.swish > 0 ? SIN((1 - w.swish/w.swishT0) * Math.PI) : 0;
  const swAng = sw * w.swishDir * (cast ? .8 : 1.15);
  if (sw > 0.02){
    ctx.save();
    ctx.shadowColor = w.swishColor; ctx.shadowBlur = 16;
    ctx.strokeStyle = w.swishColor;
    ctx.globalAlpha = sw * .8;
    ctx.lineWidth = 3.5;
    const a0 = swAng, a1 = swAng - w.swishDir * (cast ? .95 : 1.5);
    const rr = cast ? 24 : 30;
    ctx.beginPath();
    ctx.arc(0, 0, rr, Math.min(a0,a1), Math.max(a0,a1));
    ctx.stroke();
    ctx.globalAlpha = sw * .35;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(0, 0, rr + 7, Math.min(a0,a1), Math.max(a0,a1));
    ctx.stroke();
    ctx.restore();
  }
  ctx.save();
  ctx.rotate(swAng);
  // wand
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "#c8b48a"; ctx.lineWidth = 2.4;
  ctx.beginPath(); ctx.moveTo(9, 11); ctx.lineTo(28, 4); ctx.stroke();

  // charge glow at wand tip
  if (w.charge !== null){
    const s = SPELLS[w.charge];
    const k = s.maxChg ? w.chargeT/s.maxChg : 0;
    blitSprite(glowSprite(s.color, 3 + k*9, 10 + k*30), 29, 4);
    ctx.globalAlpha = .5;
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(29, 4, 4 + k*13, 0, TAU*k); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (w.fizzle > 0){
    ctx.shadowBlur = 0; ctx.globalAlpha = w.fizzle*2;
    ctx.strokeStyle = "#6b6188"; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(29, 4, 7, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  ctx.restore();
}

/* ---------------------------------------------------------- HUD */
const el = id => document.getElementById(id);
const book = el("book");
SPELLS.forEach((s, i) => {
  const c = document.createElement("div");
  c.className = "card"; c.style.setProperty("--c", s.color);
  const dots = s.chargeW
    ? Array.from({length: s.weight + s.chargeW}, (_,k) => `<i class="${k < s.weight ? "" : "hollow"}"></i>`).join("")
    : s.id === "beam" ? `<i></i><i></i><i></i><i></i>` : `<i></i><i></i><i></i>`;
  c.innerHTML =
    `<div class="ttl"><span class="k">${s.key}</span><span class="n">${s.name}</span></div>
     <div class="wt">${dots}</div>
     <div class="m"><span>${s.id === "beam" ? "31/s" : s.cost}</span><span>${
        s.id==="ward" ? "spark\u00b7rive" : s.id==="beam" ? "beam" : s.id==="grasp" ? "throw" : s.id==="rive" ? "1\u20135 shots" : "wt " + s.weight}</span></div>`;
  book.appendChild(c);
});
const cards = [...book.children];
const dashCard = document.createElement("div");
dashCard.className = "card";
dashCard.style.setProperty("--c", "#cfc8ff");
dashCard.innerHTML =
  '<div class="ttl"><span class="k">\u21E7</span><span class="n">Dash</span></div>' +
  '<div class="wt"><i></i><i class="hollow"></i><i class="hollow"></i></div>' +
  '<div class="m"><span>free</span><span>3s</span></div>';
book.appendChild(dashCard);

const railsBox = el("rails");
let railList = [];
function mk(tag, cls, parent){
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}
function buildRails(){
  railsBox.innerHTML = "";
  railList = wizards.map(w => {
    const d = mk("div", "plate", railsBox);
    d.style.setProperty("--tint", w.tint);
    const who = mk("div", "who", d);
    const nm = mk("b", null, who);
    nm.textContent = w.name;
    // the health number and the round pips share a line beneath the name, so a
    // long name has the row to itself instead of squeezing the pips off the end
    const line = mk("div", "line", d);
    const hpTxt = mk("span", null, line);
    const wins = mk("div", "wins", line);
    const pipN = matchCfg.mode === "lives" ? matchCfg.lives : Math.max(2, matchCfg.roundsToWin);
    const pips = [];
    for (let i = 0; i < pipN; i++) pips.push(mk("i", null, wins));
    const hpB = mk("i", null, mk("div", "meter hp", d));
    const mpB = mk("i", null, mk("div", "meter mp", d));
    return { w, d, nm, hpTxt, hpB, mpB, pips };
  });
  scheduleFit();   // six plates wrap to two rows; the arena has to give that room back
}
// A match is on screen from the countdown through to the last blow; anywhere
// else — the menus, the results — the plates are just clutter, so they fade.
const LIVE_PHASES = { count:1, fight:1, paused:1, tally:1 };
function syncRailsLive(){
  const on = !!LIVE_PHASES[phase];
  if (railsBox && railsBox.classList) railsBox.classList.toggle("live", on);
  const rl = el("roundLabel");
  if (rl && rl.classList) rl.classList.toggle("live", on);
}
function syncHUD(){
  syncRailsLive();
  if (railList.length !== wizards.length || railList.some((r, i) => r.w !== wizards[i])) buildRails();
  for (const r of railList){
    const w = r.w;
    r.nm.textContent = w.name;
    r.hpB.style.transform = `scaleX(${Math.max(0, w.hp)/(w.hpMax || 100)})`;
    r.mpB.style.transform = `scaleX(${w.mana/100})`;
    r.hpTxt.textContent = Math.ceil(Math.max(0, w.hp));
    r.d.classList.toggle("out", w.dead);
    r.d.classList.toggle("surge", w.surge > 0);
    r.d.classList.toggle("locked", you.lock === w);
    r.d.classList.toggle("hidden-wiz", matchCfg.fog && you && w !== you && !canSee(you, w));
    for (let i = 0; i < r.pips.length; i++)
      r.pips[i].classList.toggle("on", matchCfg.mode === "lives" ? i < w.lives : i < w.wins);
    if (matchCfg.mode === "lives") r.d.classList.toggle("out", w.dead && w.lives <= 0);
  }
  cards.forEach((c, i) => {
    const s = SPELLS[i];
    const active = (you.charge === i) || (s.id === "beam" && you.beamOn) || (s.id === "grasp" && you.held) || (s.id === "ward" && you.ward > 0);
    c.classList.toggle("lit", !!active);
    c.classList.toggle("broke", you.mana < s.cost*0.9);
    let chg = 0;
    if (you.charge === i && s.maxChg) chg = you.chargeT/s.maxChg;
    if (s.id === "beam" && you.beamOn) chg = Math.min(1, you.beamWind/byId.beam.cast);
    if (s.id === "ward" && you.ward > 0) chg = you.ward/Math.max(1,you.wardMax);
    c.style.setProperty("--chg", chg.toFixed(3));
  });
  const dashReady = you.dashCool <= 0;
  dashCard.classList.toggle("lit", dashReady);
  dashCard.classList.toggle("broke", !dashReady);
  dashCard.style.setProperty("--chg", dashReady ? "1" : (1 - you.dashCool/DASH_CD).toFixed(3));

  if (mode === "escalation"){
    const alive = Math.max(1, livingOf(1).length);
    const party = seats.length > 1
      ? ` · ${livingOf(0).length}/${seats.length} standing` : "";
    const boss = wizards.some(q => q.boss && !q.dead);
    el("roundLabel").textContent =
      `${Math.round(runScore).toLocaleString()} pts · Wave ${Math.max(1, waveNo)} · ` +
      (boss ? "BOSS" : `${alive} ${alive === 1 ? "rival" : "rivals"}`) + party;
  } else {
    el("roundLabel").textContent = matchCfg.mode === "lives"
      ? `Lives · ${matchCfg.lives} each`
      : `Round ${roundNo} · first to ${matchCfg.roundsToWin}`;
  }
  paintPing();
}

/* ---------------------------------------------------------- music */
const bgm = el("bgm"), lobbyBgm = el("lobbyBgm"), bossBgm = el("bossBgm"), bgmBtn = el("bgmBtn");
const beamSfx = { you: el("sfxBeamA"), foe: el("sfxBeamB") };
const chargeSfx = { you: el("sfxChargeA"), foe: el("sfxChargeB") };
const clashSfx = el("sfxClash");
function playSfx(a, vol){
  if (!a || muted) return;
  a.volume = vol;
  try { a.currentTime = 0; } catch (e) {}
  const p = a.play();
  if (p && p.catch) p.catch(() => {});
}
function stopSfx(a){
  if (!a) return;
  a.pause();
  try { a.currentTime = 0; } catch (e) {}
}
function chargeSound(w, on){
  const a = w.friendly ? chargeSfx.you : chargeSfx.foe;
  if (on){ logCast("charge", w, w.friendly || w.boss ? 0.6 : 0.45); playSfx(a, w.friendly || w.boss ? 0.6 : 0.45); } else stopSfx(a);
}
function clashSound(on){
  if (on) playSfx(clashSfx, 0.7); else stopSfx(clashSfx);
}
const castSfx = {
  spark: [el("sfxSpark1"), el("sfxSpark2"), el("sfxSpark3")].filter(Boolean),
  rive:  [el("sfxRive1"), el("sfxRive2"), el("sfxRive3")].filter(Boolean),
  hex:   [el("sfxHex1"), el("sfxHex2")].filter(Boolean),
  ward:  [el("sfxWard1"), el("sfxWard2"), el("sfxWard3")].filter(Boolean)
};
const hitSfx = {
  small: [el("sfxHitS1"), el("sfxHitS2")].filter(Boolean),
  big:   [el("sfxHitB1"), el("sfxHitB2")].filter(Boolean)
};
const dashS = el("sfxDash");
const lastClip = {};
// never the same clip twice running; where a pool is short, a little pitch
// jitter keeps repeats from sounding like a stuck record
function fromPool(pool, key, vol, jitter){
  if (!pool || !pool.length) return;
  let i = (vrand()*pool.length)|0;
  if (pool.length > 1 && i === lastClip[key]) i = (i + 1) % pool.length;
  lastClip[key] = i;
  const a = pool[i];
  if (jitter) { try { a.playbackRate = 1 + vrnd(-0.08, 0.08); } catch (e) {} }
  playSfx(a, vol);
}
function castSound(w, id){
  const pool = castSfx[id];
  if (!pool) return;
  const vol = w.friendly || w.boss ? 0.55 : 0.4;          // the Alchemist's own spells sound as yours do
  logCast("cast:" + id, w, vol);
  fromPool(pool, id, vol, pool.length < 3);
}
// (a short list of the spell sounds asked for, by name and by whom, for the test rig and nothing else)
function logCast(name, w, vol){
  sfxLog.push({ name, vol, boss: !!w.boss });
  if (sfxLog.length > 48) sfxLog.shift();
}
function hitSound(w, amount){
  const big = amount >= 14;
  fromPool(big ? hitSfx.big : hitSfx.small, big ? "hitB" : "hitS",
           (big ? 0.7 : 0.5) * (w.friendly ? 1 : 0.85), true);
}
const PLAYER_DASH_VOL = 0.5;
const BOSS_DASH_VOL = PLAYER_DASH_VOL * 0.8;    // 20% quieter than the player's own dash
function dashSound(w){
  if (dashS) { try { dashS.playbackRate = 1 + vrnd(-.06,.06); } catch (e) {} }
  const vol = w.friendly ? PLAYER_DASH_VOL : w.boss ? BOSS_DASH_VOL : 0.34;
  logCast("dash", w, vol);
  playSfx(dashS, vol);
}
/* One-off cues for the boss: the hat locking in and turning, the mirror, the fused orb, and the
   alert that comes before it. Each is logged by name as well as played (a short list, for the
   test rig and nothing else), so the rig can tell a cue was asked for even where there is nothing
   to play it.

   A cue can be shaped as it plays. `env` is { in, out, tail }: seconds to fade up from nothing at
   the start, seconds to fade down when it is told to stop (fadeOutCue), and seconds of the file's
   own end to fade down over, so it never ends on a step. audioTick runs the envelopes, on real
   time, like the music; nothing in the simulation ever reads them. */
const lockSfx = [el("sfxLockin"), el("sfxLockin3")];
const alertSfx = el("sfxBossAlert"), reflectSfx = el("sfxReflect"), reflect3Sfx = el("sfxReflect3");
const hexsparkSfx = el("sfxHexspark"), spinnerSfx = el("sfxSpinner"), slotSfx = el("sfxSlot");
const sparkriveSfx = el("sfxSparkrive");
const hexriveSfx = el("sfxHexrive"), prismlanceSfx = el("sfxPrismlance");
const sfxLog = [];
const fades = [];                                   // the cues that are being shaped right now
const easeIO = k => k * k * (3 - 2 * k);            // a smooth start and a smooth stop
function cue(name, a, vol, env){
  sfxLog.push({ name, vol });
  if (sfxLog.length > 48) sfxLog.shift();
  for (let i = fades.length - 1; i >= 0; i--) if (fades[i].name === name) fades.splice(i, 1);    // played again: the old envelope is done
  if (env) fades.push({ name, a, vol, t: 0, inT: env.in || 0, outT: env.out || 0, tail: env.tail || 0, out: -1, k: env.in ? 0 : 1 });
  if (!a || muted) return;
  a.volume = env && env.in ? 0 : vol;
  try { a.currentTime = 0; } catch (e) {}
  const p = a.play();
  if (p && p.catch) p.catch(() => {});
}
// let a shaped cue go: it fades down over `secs` (or the `out` it was given) and then stops
function fadeOutCue(name, secs){
  for (const f of fades) if (f.name === name && f.out < 0){ f.out = 0; if (secs > 0) f.outT = secs; if (!(f.outT > 0)) f.outT = .3; }
}
function fadeTick(dt){
  for (let i = fades.length - 1; i >= 0; i--){
    const f = fades[i], a = f.a;
    f.t += dt;
    let k = 1;
    if (f.inT > 0) k *= easeIO(Math.min(1, f.t / f.inT));
    if (f.out >= 0){ f.out += dt; k *= easeIO(Math.max(0, 1 - f.out / f.outT)); }
    const len = a && a.duration > 0 ? a.duration : 0;
    if (f.tail > 0 && len > 0) k *= easeIO(Math.max(0, Math.min(1, (len - f.t) / f.tail)));
    f.k = k;
    if (a && !muted) a.volume = Math.max(0, Math.min(1, f.vol * k));
    if ((f.out >= 0 && f.out >= f.outT) || (len > 0 && f.t >= len + .05) || (a && a.ended)){ stopSfx(a); fades.splice(i, 1); }
  }
}
// the hat has stopped and the two spells have locked in: two sounds at once, one sharp and one long
function lockSound(){
  cue("lockin", lockSfx[0], .6);
  cue("lockin3", lockSfx[1], .55);
}
// the hat whirls: a steady whirr that comes up as it starts and goes down as it stops
const SPIN_SND = { vol: .6, in: .35, out: .45 };
// ...and under it the slot-machine reels: they start at once, run for as long as the hat turns, and are stopped dead (a few
// hundredths of a second so it does not click) the moment the spells lock in, where the lock-in sounds take over
const SLOT_SND = { vol: .55, out: .06 };
function spinSound(on){
  if (on){
    cue("spinner", spinnerSfx, SPIN_SND.vol, { in: SPIN_SND.in, out: SPIN_SND.out, tail: .4 });
    cue("slotspin", slotSfx, SLOT_SND.vol, { out: SLOT_SND.out, tail: .3 });
  } else {
    fadeOutCue("spinner", SPIN_SND.out);
    fadeOutCue("slotspin", SLOT_SND.out);
  }
}
// the mirror: the raise (the hit lands as the hands come apart) and the beam going back out are two files, together
const REFLECT_SND = { vol: .6, vol3: .5, out: .5 };
const HEXSPARK_VOL = .6;           // the fused orb (Sparkwheel) as it leaves the wand
const SPARKRIVE_VOL = .6;          // the needle volley (Needle Rain) as it leaves the wand
const HEXRIVE_VOL = .6;            // the missile stream (Hexswarm) as it starts
const PRISMLANCE_VOL = .6;         // the Prism Lance the instant it fires
const PRISMLANCE_FADE = .12;       // how fast it is cut off when the lance ends — sharp, not a ring-out
let muted = false;
if (bgm) bgm.volume = 0;          // all three tracks start silent; the crossfade raises one
if (lobbyBgm) lobbyBgm.volume = 0;
if (bossBgm) bossBgm.volume = 0;
function beamSound(w, on){
  const a = w.friendly ? beamSfx.you : beamSfx.foe;
  if (!a) return;
  if (on){
    logCast("beam", w, w.friendly || w.boss ? 0.6 : 0.42);
    if (muted) return;
    a.volume = w.friendly || w.boss ? 0.6 : 0.42;
    try { a.currentTime = 0; } catch (e) {}
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
  } else {
    a.pause();
    try { a.currentTime = 0; } catch (e) {}
  }
}
function hushBeams(){
  for (const w of wizards){ w.beamSounding = false; w.beamCharging = false; }
  stopSfx(beamSfx.you); stopSfx(beamSfx.foe);
  stopSfx(chargeSfx.you); stopSfx(chargeSfx.foe);
  stopSfx(clashSfx);
  for (const k in castSfx) for (const a of castSfx[k]) stopSfx(a);
  for (const a of lockSfx.concat([alertSfx, reflectSfx, reflect3Sfx, hexsparkSfx, spinnerSfx, slotSfx, sparkriveSfx, hexriveSfx, prismlanceSfx])) stopSfx(a);
  fades.length = 0;
  alertQ.state = 0; duckTo = 1; musicDuck = 1;
}
/* Two tracks, one at a time: the lobby waits on the menu, the battle theme takes
 * over the moment a match starts, and each hands over by fading rather than
 * cutting. Both elements loop from the first interaction onward and it is only
 * their volume that moves — restarting an <audio> mid-fade clicks, and browsers
 * will not begin playback at all until the page has been touched.
 */
const MUSIC_VOL = { lobby: 0.38, battle: 0.42, boss: 0.42 };
const FADE_MS = 900;
/* The boss alert. When the last ordinary wave falls (or the boss test begins) the music is
   pulled down to a third of its level, the alert plays over it, and when the alert is done the
   music comes back up slowly. It is driven from the frame loop (audioTick), on real time, and
   nothing in the simulation ever reads it. */
const BOSS_ALERT_DUCK = .33;       // the music's level under the alert, as a fraction of its own
const BOSS_ALERT_LEAD = .6;        // seconds the music takes to go down before the alert begins
const BOSS_ALERT_VOL = .7;
const BOSS_ALERT_LEN = 6.9;        // how long it plays, if the browser will not say
const BOSS_ALERT_DOWN = .5, BOSS_ALERT_UP = 1.8;   // seconds to fade the music down, and back up
const BOSS_ALERT_IN = .6, BOSS_ALERT_OUT = 1.4;    // the alert itself fades up from nothing, and down over the end of the file
const BOSS_ALERT_OVERLAP = .5;     // the music starts back up this long before the alert has quite finished
let musicDuck = 1, duckTo = 1;
const alertQ = { state: 0, t: 0 };   // 0 idle, 1 the music is going down, 2 the alert is playing
function bossAlert(){
  if (alertQ.state || muted || !musicStarted) return;
  if (alertSfx && (alertSfx.error || alertSfx.networkState === 3)) return;     // the file did not load: no dip in the music for a sound that will not come
  alertQ.state = 1; alertQ.t = 0; duckTo = BOSS_ALERT_DUCK;
}
function applyDuck(){
  if (fadeTimer) return;                 // a crossfade is under way: it reads musicDuck itself
  const a = trackEl(musicTrack);
  if (a && !muted && musicStarted) a.volume = MUSIC_VOL[musicTrack] * musicDuck;
}
function audioTick(dt){
  dt = Math.min(Math.max(dt, 0), .1);
  if (alertQ.state === 1){
    alertQ.t += dt;
    if (alertQ.t >= BOSS_ALERT_LEAD){ alertQ.state = 2; alertQ.t = 0; cue("bossalert", alertSfx, BOSS_ALERT_VOL, { in: BOSS_ALERT_IN, tail: BOSS_ALERT_OUT }); }
  } else if (alertQ.state === 2){
    alertQ.t += dt;
    const len = alertSfx && alertSfx.duration > 0 ? alertSfx.duration : BOSS_ALERT_LEN;
    if (alertQ.t >= len - BOSS_ALERT_OVERLAP) duckTo = 1;          // the music comes back under the tail of the alert
    if (alertQ.t >= len + .1 || (alertQ.t > 1 && alertSfx && alertSfx.ended)){ alertQ.state = 0; duckTo = 1; }
  }
  fadeTick(dt);
  if (musicDuck !== duckTo){
    const step = (1 - BOSS_ALERT_DUCK) * dt / (duckTo < musicDuck ? BOSS_ALERT_DOWN : BOSS_ALERT_UP);
    musicDuck = duckTo < musicDuck ? Math.max(duckTo, musicDuck - step) : Math.min(duckTo, musicDuck + step);
    applyDuck();
  }
}
let musicTrack = "lobby";        // which one should be audible right now
let musicStarted = false;        // have we been allowed to play at all yet?
let fadeTimer = 0;
function trackEl(which){ return which === "lobby" ? lobbyBgm : which === "boss" ? bossBgm : bgm; }
function fadeMusic(){
  if (typeof clearInterval === "function" && fadeTimer) clearInterval(fadeTimer);
  if (typeof setInterval !== "function") return;
  const stepMs = 50, step = stepMs / FADE_MS;
  fadeTimer = setInterval(() => {
    let settled = true;
    for (const which of ["lobby", "battle", "boss"]){
      const a = trackEl(which);
      if (!a) continue;
      const want = (muted || !musicStarted || which !== musicTrack) ? 0 : MUSIC_VOL[which] * musicDuck;
      const now = a.volume;
      if (Math.abs(now - want) < 0.02){
        a.volume = want;
        // a track faded to nothing stops, so it is not burning battery in silence
        if (want === 0 && !a.paused) a.pause();
      } else {
        // never step past the target: a step bigger than the settle tolerance
        // would overshoot, come back, overshoot again — an audible wobble and a
        // timer that never clears
        const d = want - now;
        const moved = now + Math.sign(d) * Math.min(step, Math.abs(d));
        a.volume = Math.max(0, Math.min(1, moved));
        settled = false;
      }
    }
    if (settled && fadeTimer){ clearInterval(fadeTimer); fadeTimer = 0; }
  }, stepMs);
}
function playTrack(which){
  const a = trackEl(which);
  if (!a || muted || !musicStarted) return;
  const p = a.play();
  if (p && p.catch) p.catch(() => {});
}
// `startMusic` is the first-interaction unlock; `musicFor` is the switch.
function startMusic(){
  musicStarted = true;
  if (muted) return;
  playTrack(musicTrack);
  fadeMusic();
}
function musicFor(which){
  if (musicTrack === which && musicStarted) { fadeMusic(); return; }
  musicTrack = which;
  if (!musicStarted) return;      // nothing to fade into until we are allowed to play
  playTrack(which);
  fadeMusic();
}
function toggleMusic(){
  muted = !muted;
  if (muted){
    if (bgm) bgm.pause();
    if (lobbyBgm) lobbyBgm.pause();
    if (bossBgm) bossBgm.pause();
    if (bgm) bgm.volume = 0;
    if (lobbyBgm) lobbyBgm.volume = 0;
    if (bossBgm) bossBgm.volume = 0;
    if (fadeTimer && typeof clearInterval === "function"){ clearInterval(fadeTimer); fadeTimer = 0; }
    hushBeams();
  } else {
    playTrack(musicTrack);
    fadeMusic();
  }
  bgmBtn.textContent = muted ? "\u266A Music off" : "\u266A Music on";
  bgmBtn.setAttribute("aria-pressed", String(!muted));
}
if (bgmBtn) bgmBtn.addEventListener("click", toggleMusic);
// Browsers refuse to play audio until the page has been interacted with, so the
// lobby track starts on the first click or keypress. It is also attempted right
// away, for a visitor who has already earned autoplay on this origin.
if (typeof window !== "undefined" && window.addEventListener){
  window.addEventListener("pointerdown", startMusic, { once: true });
  window.addEventListener("keydown", startMusic, { once: true });
}
startMusic();

/* ---------------------------------------------------------- flow */
let seats = [];
let roomTotal = 4, roomHumans = 1;
// In a networked match the local player is whatever seat the server dealt, not
// necessarily seat 0 — the host's seat. Everything that means "this keyboard"
// keys off localSeat, and seatNames carries the roster the server sent.
let localSeat = 0, seatNames = null;
// Per-seat player level, sent once in the roster and used for nothing but
// drawing that player's cape. Never read by the simulation.
let seatLevels = null;

// Host match settings, applied identically on every client from the start
// message. The relay sanitises them server-side too, so the lockstep sim can
// trust they never diverge.
let matchCfg = { roundsToWin: 2, mode: "rounds", lives: 3, mapSize: "medium", fog: 0, mapPreset: "random", coop: 0, boss: 0 };
// Offline play (solo duel or escalation) gets the default world plus whatever
// arena the player picked in the solo panel. Multiplayer opts arrive from the
// relay's start message and are never carried into solo: the only thing that
// crosses over is the solo picker's own value, which the player can see.
function resetOfflineCfg(){
  matchCfg = sanitizeMatchCfg({ mapPreset: soloMapPreset });
}
function sanitizeMatchCfg(o){
  o = o || {};
  return {
    roundsToWin: Math.min(9, Math.max(1, o.roundsToWin | 0 || 2)),
    mode: o.mode === "lives" ? "lives" : "rounds",
    lives: Math.min(9, Math.max(1, o.lives | 0 || 3)),
    mapSize: ["small","medium","large"].includes(o.mapSize) ? o.mapSize : "medium",
    fog: o.fog ? 1 : 0,
    mapPreset: ["random","arena","gauntlet","crossfire","forest","castle"].includes(o.mapPreset) ? o.mapPreset : "random",
    coop: o.coop ? 1 : 0,
    // A boss rematch is co-op by definition (there is no solo slot in a hosted
    // room) — sanitised so it can never arrive true without coop, whatever a
    // stray client sends.
    boss: (o.coop && o.boss) ? 1 : 0
  };
}
// The host panel UI state (what the host is choosing in the lobby).
let hostRounds = 2, hostMode = "rounds", hostLives = 3,
    hostMapSize = "medium", hostFog = 0, hostMapPreset = "random", hostCoop = 0;   // 0 duel, 1 co-op survival, 2 co-op boss rematch
// The solo panel has its own arena picker, so a solo match never silently
// inherits a hosted room's map.
let soloMapPreset = "random";

// Map-size factor: scales the arena's spawn ring and prop placement bounds.
const MAP_SCALE = { small: 0.82, medium: 1.0, large: 1.28 };
function mapScale(){ return MAP_SCALE[matchCfg.mapSize] || 1; }

// Fixed map layouts — "always same layout" presets (deterministic, no RNG),
// plus "random" which keeps the seeded scatter. Positions are fractions of W/H
// so a layout reads the same on every machine.
const MAP_PRESETS = {
  arena:   [["pillar",.50,.18],["pillar",.50,.82],["pillar",.18,.50],["pillar",.82,.50],
            ["crate",.30,.30],["crate",.70,.70],["crate",.30,.70],["crate",.70,.30],
            ["stone",.50,.38],["stone",.50,.62],["lattice",.38,.50],["lattice",.62,.50]],
  gauntlet:[["stone",.26,.22],["stone",.26,.50],["stone",.26,.78],
            ["pillar",.74,.22],["pillar",.74,.50],["pillar",.74,.78],
            ["crate",.50,.14],["crate",.50,.86],["lattice",.38,.33],["lattice",.62,.67],
            ["barrel",.62,.33],["barrel",.38,.67]],
  crossfire:[["stone",.20,.35],["stone",.20,.65],["pillar",.80,.35],["pillar",.80,.65],
             ["crate",.40,.20],["crate",.60,.80],["barrel",.40,.80],["barrel",.60,.20],
             ["lattice",.50,.50],["chair",.33,.33],["stool",.67,.67],["urn",.50,.28]],

  /* A clearing ringed by trees you cannot cut down, with bushes to disappear
     into. Mirror-symmetric so neither spawn is favoured, and the middle is left
     open so the fight has somewhere to happen. */
  forest:  [["tree",.16,.20],["tree",.16,.80],["tree",.84,.20],["tree",.84,.80],
            ["tree",.50,.10],["tree",.50,.90],
            ["bush",.32,.38],["bush",.32,.62],["bush",.68,.38],["bush",.68,.62],
            ["log",.44,.24],["log",.56,.76],
            ["stump",.28,.50],["stump",.72,.50],
            ["rubble",.50,.50]],

  /* A hall: statues down the spine, braziers at the corners of the floor, and
     chests worth hiding behind until somebody breaks them. */
  castle:  [["statue",.50,.22],["statue",.50,.78],
            ["pillar",.22,.28],["pillar",.22,.72],["pillar",.78,.28],["pillar",.78,.72],
            ["brazier",.34,.50],["brazier",.66,.50],
            ["chest",.40,.30],["chest",.60,.70],
            ["chest",.40,.70],["chest",.60,.30],
            ["rubble",.50,.46],["rubble",.50,.54]]
};

// Fog of war: how far a wizard can see, scaled a little with the arena.
const FOG_R = 250;

function spawnRing(n){
  const pts = [];
  const s = mapScale();
  const rx = W*0.36*s, ry = H*0.33*s;
  for (let i = 0; i < n; i++){
    const a = Math.PI + (i/n)*TAU;
    pts.push({ x: W/2 + COS(a)*rx, y: H/2 + SIN(a)*ry });
  }
  return pts;
}
function makeSeats(){
  seats = [];
  if (mode === "match"){
    for (let i = 0; i < roomTotal; i++){
      const human = i < roomHumans;
      seats.push({
        human,
        name: human
          ? ((seatNames && seatNames[i]) || (i === localSeat ? playerName : "Player " + (i + 1)))
          : DIFF[difficulty].name + " " + (i - roomHumans + 1),
        tint: TINTS[i % TINTS.length],
        D: human ? null : DIFF[difficulty],
        wins: 0,
        lives: matchCfg.lives
      });
    }
  } else if (mode === "escalation"){
    // Co-op survival. Solo escalation is simply a party of one, so one code
    // path covers both: every seat here is an ALLY (team 0) and the waves are
    // the only thing on team 1.
    const n = coopParty();
    for (let i = 0; i < n; i++){
      const human = i < (matchCfg.coop ? roomHumans : 1);
      seats.push({
        human, ally: true,
        name: human
          ? ((seatNames && seatNames[i]) || (i === localSeat ? playerName : "Player " + (i + 1)))
          : DIFF[difficulty].name + " " + (i - roomHumans + 1),
        tint: TINTS[i % TINTS.length],
        D: human ? null : DIFF[difficulty],
        wins: 0
      });
    }
  } else {
    seats = [
      { human:true, name: playerName, tint: TINTS[0], D: null, wins: 0 },
      { human:false, name: DIFF[difficulty].name, tint: TINTS[2], D: DIFF[difficulty], wins: 0 }
    ];
  }
}
// How many wizards stand together in an escalation run. Solo is one; a co-op
// room is however many seats the host opened.
function coopParty(){
  return matchCfg.coop ? Math.max(1, roomTotal) : 1;
}
function buildRoster(){
  if (!seats.length) makeSeats();
  const n = seats.length;
  const pts = spawnRing(Math.max(2, n));
  wizards = [];
  p2 = null;
  seats.forEach((seat, i) => {
    const w = makeWizard(pts[i].x, pts[i].y, i === 0);
    w.seat = i;
    w.name = seat.name;
    w.tint = seat.tint;
    w.wins = seat.wins;
    w.lives = seat.lives != null ? seat.lives : matchCfg.lives;
    w.spawnSafe = 0;
    w.human = seat.human;
    w.D = seat.D;
    if (w.D && w.D.hp){ w.hpMax = w.D.hp; w.hp = w.D.hp; }
    // A match room is a free-for-all. A duel is you against the bot. Escalation —
    // solo or co-op — puts the whole party on team 0 and the waves on team 1;
    // every check that could hurt or target a wizard already goes through team,
    // so allies cannot shoot, beam, throw at or even lock onto each other.
    w.team = mode === "match" ? i : (mode === "escalation" || seat.human) ? 0 : 1;
    w.ally = w.team === 0 && mode === "escalation";
    if (seat.human) w.pad = (i === localSeat) ? PAD1 : PAD2;
    wizards.push(w);
    if (seat.human && i === 1) p2 = w;
  });
  /* `you` is a view concept — which wizard this client drives — and it must
     never change the simulation. This used to read
         you = wizards[localSeat] || wizards[0]; you.human = true;
     which rewrote whatever sat at localSeat into a human. w.human gates the AI,
     so a client whose seat index landed on a bot would stop running that bot's
     AI while every other client kept running it: a silent, one-sided desync.
     Now the local wizard is picked from the seats that are ALREADY human. */
  you = (wizards[localSeat] && wizards[localSeat].human)
      ? wizards[localSeat]
      : (wizards.find(w => w.human) || wizards[0]);
  if (mode === "escalation"){ waveNo = bossTest ? BOSS_AT : 0; waveLive = false; waveGap = 1.1; }
  bossAlerted = false; alertQ.state = 0; duckTo = 1; musicDuck = 1; stopSfx(alertSfx);
  for (const w of wizards) w.target = nearestEnemy(w);
  foe = nearestEnemy(you) || wizards[1];
  buildRails();
}
function resetWizards(){
  buildRoster();
  shots = []; bits = []; rings = []; ghosts = []; clashes = [];
  hitStop = 0; flash = 0; clashPrev = false; shake = 0;
  hushBeams();
}
// Escalation drops a fresh rival in somewhere you are not looking.
function spawnEnemy(tier){
  // Nothing in here may read `you`: that is a different wizard on every client,
  // so a spawn point chosen relative to it would put the wave in a different
  // place on each machine and desync the run on its first frame. The party is
  // the same list everywhere, in the same order.
  const party = livingOf(0);
  let x = W/2, y = H/2, guard = 0;
  while (guard++ < 300){
    x = rnd(50, W-50); y = rnd(50, H-50);
    if (party.some(a => dist({x,y}, a) < 300)) continue;
    if (debris.some(d => d.solid && dist({x,y}, d) < d.r + 26)) continue;
    break;
  }
  const e = makeWizard(x, y, false);
  e.D = DIFF[tier];
  e.tier = tier;
  if (e.D.hp){ e.hpMax = e.D.hp; e.hp = e.D.hp; }
  e.name = DIFF[tier].name;
  e.tint = TIER_TINT[tier];
  e.team = 1;
  e.ally = false;
  e.target = nearestEnemy(e);
  wizards.push(e);
  rings.push({ x, y, r:6, max:80, t:0, life:.55, color:e.tint, width:2.6 });
  puff(x, y, e.tint, 26);
  return e;
}
function spawnBoss(){
  // same rule as spawnEnemy: nothing here may read `you`
  const party = livingOf(0);
  let x = W/2, y = H/2, guard = 0;
  while (guard++ < 300){
    x = rnd(90, W-90); y = rnd(90, H-90);
    if (party.some(a => dist({x,y}, a) < 340)) continue;
    if (debris.some(d => d.solid && dist({x,y}, d) < d.r + BOSS_R + 24)) continue;
    break;
  }
  const e = makeWizard(x, y, false);
  e.r = BOSS_R;
  e.D = BOSS_D;
  e.tier = 2;
  e.boss = true;
  e.hpMax = e.hp = Math.round(BOSS_D.hp * (1 + 0.6 * (coopParty() - 1)));
  e.name = BOSS_D.name;
  e.tint = BOSS_TINT;
  e.team = 1;
  e.ally = false;
  e.spawnSafe = 1.3;
  e.target = nearestEnemy(e);
  if (e.target) e.facing = ATAN2(e.target.y - y, e.target.x - x);   // it arrives already looking at you
  bossInit(e);
  wizards.push(e);
  rings.push({ x, y, r:10, max:150, t:0, life:.9, color:BOSS_TINT, width:3.4 });
  rings.push({ x, y, r:6, max:90, t:0, life:.6, color:"#ffffff", width:2 });
  puff(x, y, BOSS_TINT, 44);
  return e;
}
function escTick(dt){
  survT += dt;
  runScore += dt * 5;
  // Clear away dead rivals, never dead party members — an ally bot is not
  // `human`, and filtering on that would have quietly deleted it from the run.
  if (wizards.some(w => w.dead && !w.ally))
    wizards = wizards.filter(w => w.ally || !w.dead);
  if (livingOf(1).length > 0) return;      // the set is still on its feet

  if (waveLive){                            // it just went down
    const wasBoss = waveNo === BOSS_AT + 1;
    waveLive = false;
    waveGap = 2.4;
    runScore += 200 * waveNo + (wasBoss ? 1500 : 0);
    msg = wasBoss
      ? { text: "The Alchemist falls", sub: "+" + (200*waveNo + 1500) + " points", t: 2.2, color: BOSS_TINT }
      : { text: "Wave " + waveNo + " cleared", sub: "+" + (200*waveNo) + " points", t: 1.6, color: "#5dffab" };
  }
  // the boss is next: the music goes down, and the alert sounds over it (once, whether the wave before it was
  // cleared just now or the boss test began with that wave already behind you)
  if (waveNo === BOSS_AT && !waveLive && !bossAlerted){ bossAlerted = true; bossAlert(); }
  waveGap -= dt;
  if (waveGap > 0) return;

  waveNo++;
  if (waveNo === BOSS_AT + 1){
    // the two Archmages were the last of the ordinary ladder for now: this wave is
    // one wizard, and it has four wands
    // The Alchemist is a set piece, not just another wave: the party comes to it
    // whole. Every wizard on the party's side, human or bot, is at full health
    // and full mana when it arrives, and a downed ally is back on its feet. This
    // walks the whole team rather than asking who `you` is: `you` is a different
    // wizard on every client, and the simulation may not read it.
    for (const a of wizards){
      if (a.team !== 0) continue;
      if (a.dead){
        if (!a.ally) continue;               // a downed human ends the run; it is not this loop's business
        respawnWizard(a);
      }
      a.hp = a.hpMax || 100;
      a.mana = 100;
    }
    spawnBoss();
    waveLive = true;
    unlockBoss();        // reached it — win or lose from here, it's yours to rematch from now on
    musicFor("boss");   // the boss is on the field: the ladder music fades out and the Alchemist's theme fades in
    msg = { text: "The Alchemist", sub: "Four wands. Two spells at a time.", t: 2.4, color: BOSS_TINT };
    shake = Math.min(shake + 8, 14);
    return;
  }
  // the boss took one slot in the count; the ladder carries on where it left off
  const comp = waveFor(waveNo - 1 - (waveNo > BOSS_AT + 1 ? 1 : 0), coopParty(), waveNo > BOSS_AT);
  // A new wave is also the party's second chance: anyone who went down in the
  // last one is back on their feet for this one, at part health. Being downed
  // costs you the rest of a wave, not the whole run.
  for (const a of wizards){
    if (a.ally && a.dead){ respawnWizard(a); a.hp = Math.round(a.hpMax * 0.6); }
  }
  for (const tier of comp) spawnEnemy(tier);
  waveLive = true;
  const tally = [0,0,0];
  for (const t of comp) tally[t]++;
  const label = tally.map((n, t) => n ? (n > 1 ? n + " " + DIFF[t].name + "s" : "1 " + DIFF[t].name) : null)
                     .filter(Boolean).join(" + ");
  msg = { text: "Wave " + waveNo, sub: label, t: 1.6, color: TIER_TINT[Math.max(...comp)] };
  shake = Math.min(shake + 5, 14);
}
function onDeath(w){
  if (mode === "escalation"){
    if (w.ally){
      // A downed ally is not out of the run — the next wave brings them back.
      // The run ends only when the whole party is down at the same moment.
      if (livingOf(0).length === 0) escGameOver();
      return;
    }
    kills++;
    if (w.lastBy && w.lastBy !== w) w.lastBy.kills++;
    runScore += 100 * ((w.tier || 0) + 1);
    if (w.boss){
      if (w.beamOn) stopBeam(w, true);
      for (const n of ["spinner", "slotspin", "reflect", "reflect3", "sparkrive", "hexrive", "prismlance"]) fadeOutCue(n, .35);      // whatever the boss was making goes quiet with it
      musicFor("battle");   // the Alchemist's theme hands back to the ladder music
      impact(w.x, w.y, 9, BOSS_TINT);
      rings.push({ x:w.x, y:w.y, r:10, max:220, t:0, life:.9, color:BOSS_TINT, width:4 });
      puff(w.x, w.y, "#ffffff", 40);
    }
    // The kill heals whoever landed it, not `you` — `you` is a different wizard
    // on every client, so healing it would desync a co-op run.
    const healer = (w.lastBy && w.lastBy.ally && !w.lastBy.dead) ? w.lastBy : null;
    if (healer) healer.hp = Math.min(healer.hpMax, healer.hp + 10 + (w.tier || 0)*4);
    impact(w.x, w.y, 5, w.tint);
    puff(w.x, w.y, w.tint, 30);
    return;
  }
  w.deaths++;                                  // this wizard went down
  if (w.lastBy && w.lastBy !== w) w.lastBy.kills++;
  // lives mode: a downed wizard spends a life and comes back; only a wizard
  // with no lives left is out, and the match ends when one wizard is standing.
  if (matchCfg.mode === "lives"){
    w.lives--;
    if (seats[w.seat]) seats[w.seat].lives = w.lives;
    if (w.lives > 0){
      respawnWizard(w);
      return;
    }
    // out of lives — stays dead; fall through to the standing check
  }
  const teams = new Set(wizards.filter(q => !q.dead).map(q => q.team));
  if (teams.size <= 1) endRound(wizards.find(q => !q.dead) || null);
}
function respawnWizard(w){
  const pts = spawnRing(Math.max(2, seats.length));
  const p = pts[w.seat % pts.length];
  w.x = p.x; w.y = p.y;
  w.hp = w.hpMax || 100; w.mana = 100;
  w.dead = false;
  w.beamOn = false; w.beamWind = 0; w.charge = null; w.chargeT = 0;
  w.ward = 0; w.wardMax = 0; w.held = null; w.lock = null;
  w.target = nearestEnemy(w);
  w.spawnSafe = 1.6;   // brief grace so nobody dies on top of the spawn point
  rings.push({ x:p.x, y:p.y, r:6, max:70, t:0, life:.7, color:w.tint, width:3 });
  puff(p.x, p.y, w.tint, 24);
  if (w === you) cvs.focus();
}


/* --------------------------------------------------- high scores */
// Escalation has two boards. The GLOBAL one — every signed-in wizard's best
// run, kept by the account server (cloudflare/worker/src/leaderboard.js) —
// is what "Escalation records" is supposed to mean. The LOCAL one is only
// this browser's own history, and it is a fallback now, not the board: it
// is what a guest sees (there is nowhere global to put a guest's score,
// the same reason a guest earns no experience either), and what anyone
// sees the instant a fetch fails or there is no server to ask at all (the
// single-file dist build, a file:// page). Before this, the local list WAS
// the board, unconditionally — which is why it could show six rows that
// all read the same name: that was never a leaderboard, it was one
// player's own recent runs, on the one device that played them.
const HS_KEY = "rpw.escalation.scores";
// Reaching the boss once (spawnBoss(), in a real ladder climb) unlocks a
// standing "fight it again" option, in the solo menu and in a hosted room's
// game picker alike. Same try/catch discipline as the scores above: a browser
// with storage blocked just never unlocks it, rather than throwing.
//
// The ".2" is deliberate: the first build's own README suggested setting this
// key by hand in devtools as a way to preview the option without climbing the
// ladder, and that stuck around in at least one browser and made the option
// look unlocked when it was not. Bumping the key orphans every flag anyone
// set that way (or any other leftover) — nobody has this new key until they
// actually reach the boss under this build.
const BOSS_UNLOCK_KEY = "rpw.boss.unlocked.2";
function bossUnlocked(){
  try { return localStorage.getItem(BOSS_UNLOCK_KEY) === "1"; }
  catch (e) { return false; }
}
function unlockBoss(){
  try { localStorage.setItem(BOSS_UNLOCK_KEY, "1"); }
  catch (e) {}
}
function loadLocalScores(){
  try { const v = JSON.parse(localStorage.getItem(HS_KEY)); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
function saveLocalScore(entry){
  try {
    const list = loadLocalScores();
    list.push(entry);
    list.sort((a,b) => b.s - a.s);
    localStorage.setItem(HS_KEY, JSON.stringify(list.slice(0, 8)));
  } catch (e) {}
}
// One failed request is enough to stop asking for the rest of the session —
// the same rule src/account.js uses for /api/*, and for the same reason: a
// dead or absent server should cost one round trip, not one per menu visit.
let boardOffline = false;
let boardCache = null, boardCacheAt = 0;
const BOARD_TTL_MS = 15000;   // modeCopy() re-asks every time the menu is opened; this just stops it hammering the endpoint while someone idles on it
async function fetchGlobalBoard(){
  if (boardOffline || typeof fetch !== "function") return null;
  const now = Date.now();
  if (boardCache && now - boardCacheAt < BOARD_TTL_MS) return boardCache;
  try {
    const res = await fetch("/api/leaderboard");
    if (!res.ok) { boardOffline = true; return null; }
    const data = await res.json();
    const rows = Array.isArray(data.rows) ? data.rows : [];
    boardCache = rows; boardCacheAt = now;
    return rows;
  } catch (e) { boardOffline = true; return null; }
}
function esc(str){
  return String(str).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
// Eight are kept locally, six are shown everywhere: the end screen has to
// fit the arena without scrolling, and the bottom rows are the least
// interesting ones on it.
function boardRowsHTML(rows, isNew){
  return '<ol>' + rows.slice(0, 6).map((r, i) =>
    '<li class="' + (isNew(r) ? "fresh" : "") + '"><span>' + (i+1) + '</span>' +
    '<span>' + esc(r.n || "Wizard") + ' · wave ' + r.w + ' · ' + r.k + (r.k === 1 ? " kill" : " kills") + '</span>' +
    '<b>' + r.s.toLocaleString() + '</b></li>'
  ).join("") + '</ol>';
}
let boardRequest = 0;   // lets a later renderBoard() call win over a slower earlier one
async function renderBoard(fresh){
  const box = el("board");
  const askedFor = ++boardRequest;
  box.hidden = false;
  scheduleFit();
  const rows = await fetchGlobalBoard();
  if (askedFor !== boardRequest) return;   // a newer call already landed; this one is stale
  if (rows){
    box.innerHTML = '<h4>Escalation records</h4>' + (rows.length
      ? boardRowsHTML(rows, r => !!fresh && r.n === fresh.n && r.s === fresh.s)
      : '<div class="none">No runs recorded yet.</div>');
  } else {
    const list = loadLocalScores();
    box.innerHTML = '<h4>Escalation records (this device)</h4>' + (list.length
      ? boardRowsHTML(list, r => !!fresh && r.s === fresh.s && r.d === fresh.d)
      : '<div class="none">No runs recorded yet on this device.</div>');
  }
  box.hidden = false;
  scheduleFit();
}
// Hides the board AND invalidates any renderBoard() still in flight, so a
// slow fetch cannot land after the player has already navigated away and
// pop the board back open behind them.
function hideBoard(){
  boardRequest++;
  el("board").hidden = true;
}
function escGameOver(){
  phase = "over"; phaseT = 1.2;
  const wave = Math.max(1, waveNo);
  const final = Math.round(runScore);
  const party = seats.length > 1;
  // The score and the wave belong to the party; the kill count is your own.
  const mine = (you && you.kills) | 0;
  if (!party && !bossTest) saveLocalScore({ s: final, k: kills, w: wave, d: Date.now(), n: playerName });
  msg = { text: party ? "The party falls" : "Fallen",
          sub: "Score " + final.toLocaleString(), t: 1.5, color: "#ff4d5e" };
  const banked = bossTest ? Promise.resolve(null) : bankRun(final, wave, party ? mine : kills);   // a boss test is a rehearsal, not a run
  setTimeout(() => {
    // show() rewrites the curtain copy, so it goes first and the report second
    show(NET.active ? "mp" : "solo");
    renderStats();
    el("curtainTitle").textContent = party
      ? "The party held out to wave " + wave
      : playerName + " held out to wave " + wave;
    const yours = party ? mine : kills;
    const report = final.toLocaleString() + " points · " + yours +
      (yours === 1 ? " wizard" : " wizards") + " put down" + (party ? " by you" : "") +
      " · " + Math.round(survT) + " seconds standing.";
    el("curtainText").textContent = report;
    if (!party){ el("goBtn").textContent = "Run it again"; renderBoard({ s: final, k: kills, w: wave, d: Date.now(), n: playerName }); }
    else hideBoard();
    el("curtain").hidden = false;
    banked.then(out => showEarned(out, report));
  }, 1600);
}

function newRound(){
  // every machine in a match derives the same arena from the same seed.
  // simFrame is intentionally NOT reset here: lockstep frames count up
  // continuously across the whole match (they restart in newMatch), so
  // round transitions can't race the netcode's input bookkeeping.
  seedRng((Math.imul(matchSeed, 7919) + roundNo * 104729) >>> 0);
  resetWizards();
  makeMap();
  phase = "count"; phaseT = 1.4;
  msg = mode === "escalation"
    ? { text: "Survive", sub: seats.length > 1 ? "Hold the line together." : "They keep coming.",
        t: 1.4, color: "#ff4d5e" }
    : matchCfg.mode === "lives"
      ? { text: `Round ${roundNo}`, sub: `${matchCfg.lives} lives each — last one standing`, t: 1.4, color: "#a97cff" }
      : { text: `Round ${roundNo}`, sub: "Wands up.", t: 1.4, color: "#a97cff" };
}
function readName(){
  // The name box is gone: you play as your signed-in wizard, or as Guest.
  playerName = (window.RPWA && window.RPWA.name) || "Guest";
}
function newMatch(seed){
  readName();
  matchSeed = (seed || ((Date.now() ^ (Math.random()*0xffffffff)) >>> 0)) >>> 0;
  startMusic();
  musicFor("battle");
  clearTaps();    // nothing pressed before the wands are up carries into the match
  roundNo = 1;
  simFrame = 0;   // frame counter restarts once per match, not per round
  shotSeq = 0;    // and the firing order restarts with it
  runScore = 0; kills = 0; survT = 0; waveNo = 0; waveLive = false; waveGap = 1.1;
  nextWizId = 0;
  makeSeats();
  newRound();
  el("curtain").hidden = true;
  hideBoard();
  el("pausePanel").hidden = true;
  // the menus hide these; a match puts them back
  const st = el("stats"); if (st) st.hidden = true;
  const rl = el("roundLabel"); if (rl) rl.hidden = false;   // fades in via .live
}
function renderStats(){
  const box = el("stats");
  const rows = wizards.slice().sort((a, b) =>
    (b.kills - a.kills) || (b.dmg - a.dmg) || (b.counters - a.counters) || a.name.localeCompare(b.name));
  const best = rows[0];
  const rowsHTML = rows.map(w =>
    '<tr' + (w === best ? ' class="best"' : '') + '>' +
      '<td class="who"><i></i>' + esc(w.name) + (w === you ? ' <em>you</em>' : '') + '</td>' +
      '<td>' + w.kills + '</td>' +
      '<td>' + w.deaths + '</td>' +
      '<td>' + Math.round(w.dmg) + '</td>' +
      '<td>' + w.counters + '</td>' +
    '</tr>').join("");
  // NOTE: each wizard's colour is painted below, through the CSSOM. It cannot
  // ride along as a style="" attribute — the site's CSP refuses inline styles.
  box.innerHTML =
    '<table class="statline">' +
      '<caption>Match report</caption>' +
      '<thead><tr><th>Wizard</th><th>Kills</th><th>Deaths</th><th>Dmg dealt</th><th>Counters</th></tr></thead>' +
      '<tbody>' + rowsHTML + '</tbody>' +
    '</table>';
  if (box.querySelectorAll){
    const dots = box.querySelectorAll("td.who i");
    rows.forEach((w, i) => { if (dots[i]) dots[i].style.setProperty("--c", w.tint); });
  }
  box.hidden = false;
  scheduleFit();
}
function endRound(win){
  if (phase === "over" || phase === "tally") return;
  if (win){
    win.wins++;
    if (seats[win.seat]) seats[win.seat].wins = win.wins;
  }
  phase = "tally"; phaseT = 2.0;
  const mine = win === you;
  msg = {
    text: win ? win.name : "Nobody",
    sub: win ? "takes the round." : "is left standing.",
    t: 2.0, color: win ? win.tint : "#8b81a8"
  };
  // lives mode ends the whole match on the last one standing — no round tally
  if (matchCfg.mode === "lives" || (win && win.wins >= matchCfg.roundsToWin)){
    phase = "over"; phaseT = 1.2;
    msg = { text: mine ? "Victory" : win.name + " wins", sub: null, t: 1.2, color: win.tint };
    // Ask for the experience now, not when the curtain appears — the answer is
    // then usually already in hand by the time there is somewhere to show it.
    const banked = bankMatch(mine, you ? you.wins : 0);
    setTimeout(() => {
      // a networked match drops you back at the multiplayer door, not the bot list
      const networked = NET.active;
      leaveRoom();
      show(networked ? "mp" : "solo");
      renderStats();
      el("curtainTitle").textContent = mine ? "You take the match" : win.name + " takes the match";
      // The line under the title is the match's payout, or nothing at all.
      el("curtainText").textContent = "";
      el("curtainText").hidden = true;
      if (!networked) el("goBtn").textContent = "Play again";
      el("curtain").hidden = false;
      banked.then(out => showEarned(out));
    }, 1400);
  } else {
    roundNo++;
  }
}
function togglePause(){
  // Pause is local-only and would desync a networked match (one client stops
  // advancing while the other keeps going, so round reseeds diverge and both
  // freeze). Disable it entirely in multiplayer.
  if (NET.active) return;
  if (phase === "fight"){ phase = "paused"; el("pausePanel").hidden = false; msg = null; }
  else if (phase === "paused"){ phase = "fight"; el("pausePanel").hidden = true; msg = null; }
}
function toMenu(){
  phase = "menu"; msg = null;
  hushBeams();
  leaveRoom();
  el("pausePanel").hidden = true;
  el("curtain").hidden = false;
  selectMode(mode === "escalation" ? (bossTest ? 4 : 3) : difficulty);
  show("home");
}

/* ------------------------------------------------- fitting the curtain
 * The end screen carries the most: a title, the match report, the name field,
 * the level picker, the buttons and the records board. On a short window that
 * used to overflow and the whole panel grew a scrollbar, which is not what a
 * game should do. The content is gathered into one inner box; if it still will
 * not fit, that box is scaled down as a unit so everything stays on screen.
 */
const curtainEl = el("curtain");
let curtainInner = null;
if (curtainEl && typeof document.createElement === "function" && ("firstChild" in curtainEl)){
  curtainInner = document.createElement("div");
  curtainInner.className = "curtain-inner";
  while (curtainEl.firstChild) curtainInner.appendChild(curtainEl.firstChild);
  curtainEl.appendChild(curtainInner);
}
function fitCurtain(){
  if (!curtainInner || !curtainEl) return;
  curtainInner.style.transform = "";
  curtainInner.style.height = "";
  /* Not on a phone. Scaling content down with a transform does not change its
     layout, so a centred panel spills as far above its box as below it — and
     nothing can be scrolled to above zero, which is how a title ended up
     permanently off the top of the menu. The phone menu is a top-anchored
     scroller instead (see html.touch .curtain), which needs this to keep its
     hands off. */
  if (TOUCH) return;
  if (curtainEl.hidden || curtainEl.clientHeight < 80) return;   // nothing to measure yet
  const avail = curtainEl.clientHeight - 36;                     // the 18px padding, top and bottom
  const need = curtainInner.scrollHeight;
  if (!need || need <= avail) return;
  const k = Math.max(0.55, avail / need);
  curtainInner.style.transform = "scale(" + k + ")";
  curtainInner.style.height = (need * k) + "px";                 // so the parent stops overflowing too
}
/* Cap the arena by HEIGHT as well as width.
   The canvas is 960x620 and scales to its box, so the box was free to grow
   taller than the window and push the health plates and the spell book off
   screen. Rather than guess a constant for the surrounding furniture, measure
   it: everything in the shell except the arena itself and the manual (which is
   meant to sit below the fold), plus the gaps between them and the body's own
   padding. Whatever is left is the tallest the arena may be, and its width
   follows from that. */
const STAGE_RATIO = 960 / 620;
function fitStage(){
  const stage = el("stage");
  if (!stage || !stage.parentNode || !stage.style || typeof getComputedStyle !== "function") return;
  const shell = stage.parentNode;
  if (!shell.children || !window.innerHeight) return;

  const gap = parseFloat(getComputedStyle(shell).rowGap) || 0;
  const body = getComputedStyle(document.body);
  let used = (parseFloat(body.paddingTop) || 0) + (parseFloat(body.paddingBottom) || 0);
  let inFlow = 0;
  for (const kid of shell.children){
    // audio elements and anything hidden take no room
    if (getComputedStyle(kid).display === "none") continue;
    if (kid.tagName === "DETAILS") continue;          // the manual lives below the fold
    inFlow++;
    if (kid !== stage) used += kid.getBoundingClientRect().height;
  }
  used += gap * Math.max(0, inFlow - 1);

  const room = window.innerHeight - used;
  // never collapse to nothing on a very short window — scrolling beats a sliver
  stage.style.maxWidth = Math.max(360, Math.round(room * STAGE_RATIO)) + "px";
}

let fitPending = false;
function scheduleFit(){
  if (fitPending || !curtainInner) return;
  fitPending = true;
  const run = () => { fitPending = false; fitStage(); fitCurtain(); };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else if (typeof setTimeout === "function") setTimeout(run, 0);
  else run();
}
if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("resize", scheduleFit);

/* --------------------------------------------------- menu wiring */
// The curtain is a stack of panels and exactly one is ever visible. Every
// button routes through show(); nothing else touches a panel's hidden flag.
const PANEL = {
  home: el("homePanel"), solo: el("soloPanel"), mp: el("mpPanel"),
  host: el("hostPanel"), join: el("joinPanel"), auth: el("authPanel")
};
const COPY = {
  home: ["Rock, Paper, Wizards",
         "Battle and level up your wizard, unlock new jewels to adorn your cloak, become the greatest Archmage."],
  mp:   ["Multiplayer",
         "Host a duel and you get a four-letter code to hand out. Join one and you paste the code you were given. Bots fill any seat nobody takes."],
  host: ["Hosting", "Send the code. Empty seats become bots."],
  join: ["Join a duel", "Four letters, from whoever is hosting."],
  auth: ["Your wizard", "Sign in and your wizard keeps its level, its experience and — before long — what it is wearing."]
};
let panel = "home";
let selectedLevel = 1;   // mirrors the solo diffRow's .sel button (1 = Adept, the markup's default)
function show(which){
  panel = which;
  musicFor("lobby");   // any menu, including the one a finished match drops you on
  scheduleFit();
  // A phone menu scrolls, so a tall panel can leave it parked halfway down;
  // the next panel would then open on its own middle.
  if (TOUCH && curtainEl) curtainEl.scrollTop = 0;
  for (const k in PANEL) PANEL[k].hidden = (k !== which);
  // the last match's report and round counter are not part of any menu — navigating
  // anywhere clears them, and renderStats() puts the report back after a match ends
  const st = el("stats"); if (st) st.hidden = true;
  const rl = el("roundLabel");
  if (rl) rl.hidden = false;     // it fades instead of hiding, so its space stays reserved
  if (which === "solo"){ const w = el("whoami"); if (w) w.hidden = false; modeCopy(); return; }
  hideBoard();
  el("curtainTitle").textContent = COPY[which][0];
  el("curtainText").textContent = COPY[which][1];
  // lobby panels carry their own controls; keep the banner overhead small
  const who = el("whoami"); if (who) who.hidden = (which === "auth");
  if (which === "host" || which === "join" || which === "auth"){
    el("curtainTitle").style.fontSize = "clamp(18px,3vw,26px)";
    el("curtainText").hidden = true;
  } else {
    el("curtainTitle").style.fontSize = "";
    el("curtainText").hidden = false;
  }
}
function modeCopy(){
  syncBossOption();
  if (mode === "escalation" && bossTest){
    el("goBtn").textContent = "Face the Alchemist";
    el("curtainTitle").textContent = "Rematch: The Alchemist";
    el("curtainText").textContent = "Straight to the boss, full health and mana, no ladder to climb first. Four wands, two spells at a time — read the gems on its hat, and watch its mana: when the bar runs dry its wands hold.";
    hideBoard();
  } else if (mode === "escalation"){
    el("goBtn").textContent = "Begin the run";
    el("curtainTitle").textContent = "Escalation";
    el("curtainText").textContent = "One Apprentice, then an Adept, then an Archmage — then pairs, then threes, each set harder than the last. Clear the set before the next arrives. You do not get a second round.";
    renderBoard(null);
  } else {
    el("goBtn").textContent = "Begin the duel";
    el("curtainTitle").textContent = "Choose your rival";
    el("curtainText").textContent = "Your wand tracks its target on its own — Tab switches targets. Read what is coming and answer it with something heavy enough to stop it.";
    hideBoard();
  }
}
// The fourth solo level only exists once this browser has reached the boss
// for real (see BOSS_UNLOCK_KEY) — everyone starts with three, same as a
// fresh install always has.
function syncBossOption(){
  const btn = el("bossOptBtn");
  if (btn) btn.hidden = !bossUnlocked();
  // A hidden option cannot be the selected one — if storage was cleared out
  // from under a run that had it picked, fall back to Escalation rather than
  // leave the panel on a level nothing points at.
  if (!bossUnlocked() && selectedLevel === 4) selectMode(3);
}
function selectMode(v){
  selectedLevel = v;
  bossTest = v === 4;
  if (v === 3 || v === 4) mode = "escalation";
  else { mode = "duel"; difficulty = v; }
  [...el("diffRow").children].forEach(c => {
    if (c.dataset && c.dataset.diff !== undefined) c.classList.toggle("sel", +c.dataset.diff === v);
  });
  if (panel === "solo") modeCopy();
  syncHUD();
}
function segRow(box, values, get, set, label){
  box.innerHTML = "";
  const btns = values.map(v => {
    const b = mk("button", null, box);
    b.textContent = label ? label(v) : v;
    b.addEventListener("click", () => { set(v); paint(); afterSeg(); });
    return b;
  });
  function paint(){ btns.forEach((b, i) => b.classList.toggle("sel", values[i] === get())); }
  paint();
  return paint;
}
let botLevel = 1;                       // who fills the empty seats in a hosted room
const paintTotal = segRow(el("segTotal"), [2,3,4,5,6], () => roomTotal, v => { roomTotal = v; });
const paintBotLvl = segRow(el("segBotLvl"), [0,1,2], () => botLevel, v => { botLevel = v; },
                           v => DIFF[v].name);
const paintMode = segRow(el("segMode"), ["rounds","lives"], () => hostMode, v => { hostMode = v; paintModeRows(); },
                         v => v === "lives" ? "Lives" : "Rounds");
const paintMapSize = segRow(el("segMapSize"), ["small","medium","large"], () => hostMapSize, v => { hostMapSize = v; },
                            v => v[0].toUpperCase() + v.slice(1));
const paintFog = segRow(el("segFog"), [0,1], () => hostFog, v => { hostFog = v; },
                        v => v ? "On" : "Off");
const PRESET_NAMES = ["random","arena","gauntlet","crossfire","forest","castle"];
const presetLabel = v => v === "random" ? "Random" : v[0].toUpperCase() + v.slice(1);
const paintPreset = segRow(el("segPreset"), PRESET_NAMES, () => hostMapPreset, v => { hostMapPreset = v; }, presetLabel);
const paintSoloPreset = segRow(el("segSoloPreset"), PRESET_NAMES, () => soloMapPreset, v => { soloMapPreset = v; }, presetLabel);
// The third option (jump straight to a rematch of the boss, with friends)
// only exists once this browser has reached the boss for real — so the row
// is rebuilt, not fixed at load, every time the host panel opens.
let paintCoop = null;
function refreshCoopOptions(){
  const unlocked = bossUnlocked();
  if (hostCoop === 2 && !unlocked) hostCoop = 0;   // storage cleared mid-session — fall back rather than get stuck on a hidden option
  paintCoop = segRow(el("segCoop"), unlocked ? [0,1,2] : [0,1], () => hostCoop,
                     v => { hostCoop = v; paintModeRows(); hostNote(); },
                     v => v === 2 ? "Rematch: The Alchemist" : v ? "Co-op survival" : "Duel");
}
refreshCoopOptions();
function paintModeRows(){
  // Co-op (survival or the boss rematch) has no rounds, no lives and no
  // last-one-standing, so the rows that describe those disappear rather than
  // sitting there doing nothing.
  const coop = !!hostCoop;
  el("hostTitle").textContent = hostCoop === 2 ? "Hosting a rematch: The Alchemist"
                                : coop ? "Hosting a survival run" : "Hosting a duel";
  const lives = hostMode === "lives";
  el("rowWinBy").hidden = coop;
  el("rowRounds").hidden = coop || lives;
  el("rowLives").hidden = coop || !lives;
}
el("hostRounds").addEventListener("input", e => { hostRounds = +e.target.value; el("hostRoundsVal").textContent = hostRounds; afterSeg(); });
el("hostLives").addEventListener("input", e => { hostLives = +e.target.value; el("hostLivesVal").textContent = hostLives; afterSeg(); });
function hostOpts(){
  return {
    roundsToWin: hostRounds,
    mode: hostMode,
    lives: hostLives,
    mapSize: hostMapSize,
    fog: hostFog,
    mapPreset: hostMapPreset,
    coop: hostCoop ? 1 : 0,
    boss: hostCoop === 2 ? 1 : 0
  };
}
function afterSeg(){
  hostNote();
  // the lobby only obeys the host, and only before the match starts
  if (panel === "host" && inRoom()) window.RPWNet.config({ total: roomTotal, difficulty: botLevel, opts: hostOpts() });
}
/* The round trip to the relay, in plain words. It is the single number that
   decides how a long-distance match feels, and until it was on screen nobody
   could tell a slow link from a broken one. */
/* How far away the relay is, as a corner readout on the arena.

   It used to be appended to the lobby's explanatory paragraph, which made a
   sentence that rewrote itself every second while you were reading it. The
   number is worth having and worth watching; it is just not prose. */
function pingWord(ms){
  return ms < 90 ? "sharp" : ms < 180 ? "fine" : ms < 320 ? "long, but playable" : "very long";
}
/* In a match, syncHUD() repaints this every frame. In a LOBBY nothing does:
   the round trip arrives from the relay a second or so after you open the room,
   and the only repaints are roster changes — so on a quiet lobby the readout
   would sit blank until somebody happened to join. One slow tick fixes it, and
   costs nothing because paintPing() returns early unless the number moved. */
let pingBeat = 0;
function startPingBeat(){
  if (typeof setInterval !== "function" || pingBeat) return;
  pingBeat = setInterval(() => { try { paintPing(); } catch (e) {} }, 1000);
}
let pingShown = null;
function paintPing(force){
  const tag = el("pingTag");
  if (!tag) return;
  const ms = RPW_NET_RTT();
  // syncHUD() runs every frame; the round trip changes about once a second
  if (!force && ms === pingShown) return;
  pingShown = ms;
  const live = !!(window.RPWNet && ms && (inRoom() || (NET && NET.active)));
  tag.hidden = !live;
  if (!live) return;
  tag.textContent = ms + "ms · " + pingWord(ms);
  tag.className = "pingtag " + (ms < 180 ? "good" : ms < 320 ? "far" : "bad");
}
function RPW_NET_RTT(){
  return (window.RPW && window.RPW.NET && window.RPW.NET.rtt) ? window.RPW.NET.rtt() : 0;
}
/* The lobby used to explain itself in a paragraph here — which game type this
   is, how many seats were still empty, and what would fill them. The seat
   blocks say all of that at a glance now: an empty seat is dashed and wears the
   bot mark, so the sentence was narrating the picture directly beneath it.

   The element stays. netFail() needs somewhere to put "could not reach the
   match server", and that is worth a sentence. `.note:empty` keeps it from
   taking any space the rest of the time. */
function hostNote(){
  const note = el("hostNote");
  if (!note) return;
  note.classList.remove("bad");
  note.textContent = "";
  paintPing();
}

/* ------------------------------------------------------ the relay */
// The game is static files; the relay that carries invite codes and input is a
// separate service. Point this at it. Setting window.RPW_RELAY before src/net.js
// loads overrides it, which is how local development talks to ws://localhost:8787.
// Read from a <meta> tag rather than an inline <script>, so the site can be
// served under a strict Content-Security-Policy with no inline scripts at all
// — a page carrying a password field is judged partly on exactly that.
const RELAY = (function(){
  if (typeof window === "undefined") return "";
  if (window.RPW_RELAY) return window.RPW_RELAY;            // local dev override
  const meta = document.querySelector && document.querySelector('meta[name="rpw-relay"]');
  return (meta && meta.getAttribute("content")) || "";
})();
function hasNet(){ return !!(window.RPWNet && RELAY); }
function inRoom(){ return !!(window.RPWNet && window.RPWNet.net.room); }
function ensureConnected(){
  if (!hasNet()) return Promise.reject(new Error("no relay configured"));
  bindNet();
  const n = window.RPWNet.net;
  if (n.state !== "offline") return Promise.resolve(n);
  return window.RPWNet.connect(RELAY);
}
// src/net.js loads after this file — it needs window.RPW to exist first — so
// window.RPWNet is still undefined while this runs. Bind on first use instead,
// by which time the script has definitely loaded.
let netBound = false;
function bindNet(){
  if (netBound || !window.RPWNet) return;
  netBound = true;
  window.RPWNet.onChange(onNetChange);
}
function netFail(which, why){
  const note = el(which === "host" ? "hostNote" : "joinNote");
  note.classList.add("bad");
  note.textContent = why ? why
    : RELAY ? "Could not reach the match server. It may be asleep or down — solo play is unaffected."
            : "No match server is configured yet, so there is nobody to invite. Point RPW_RELAY at the relay’s wss:// address and this screen comes alive.";
}
function setInvite(code){
  const b = el("inviteCode");
  b.classList.toggle("waiting", !code);
  b.textContent = code || "····";
  el("copyCode").disabled = !code;
  el("copyCode").classList.remove("done");
  el("copyCode").textContent = "Copy";
}
/* The seats, as blocks you can count at a glance.

   A lobby answers one question — who is coming? — and it used to answer it in
   rows of prose you had to read. Blocks answer it by colour: dim and dashed is
   an empty seat, amber is somebody who has turned up, green is somebody ready.
   Six of those read in about a second, which is roughly how long anyone spends
   looking at a lobby.

   An empty seat wears the bot mark rather than a blank, because that is what it
   will become the moment the host starts. */
const SVGNS = "http://www.w3.org/2000/svg";
const ICON = {
  // head and shoulders
  person: "M8 7.6a2.9 2.9 0 1 0 0-5.8 2.9 2.9 0 0 0 0 5.8Zm0 1.3c-2.7 0-4.9 1.6-4.9 3.6V14h9.8v-1.5c0-2-2.2-3.6-4.9-3.6Z",
  // a squared head with an aerial and two eyes
  bot: "M7.3 1.4h1.4v1.4H11a2 2 0 0 1 2 2v5.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4.8a2 2 0 0 1 2-2h2.3V1.4ZM6.1 6.3a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1Zm3.8 0a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1Z"
};
function seatIcon(kind, parent){
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "seat-ico");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVGNS, "path");
  path.setAttribute("d", ICON[kind]);
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  if (parent) parent.appendChild(svg);
  return svg;
}
function renderRoster(box){
  box.innerHTML = "";
  if (!inRoom()) return;
  const n = window.RPWNet.net;
  for (let i = 0; i < roomTotal; i++){
    const p = (n.players || []).find(x => x.seat === i);
    const state = !p ? "open" : (p.ready ? "ready" : "here");
    const cell = mk("div", "seat " + state + (p && i === n.seat ? " me" : ""), box);
    cell.setAttribute("data-seat", i);
    seatIcon(p ? "person" : "bot", cell);
    const body = mk("span", "seat-body", cell);
    const who = mk("b", "seat-name", body);
    who.textContent = p ? (p.name + (p.host ? " (host)" : "")) : "empty";
    const tag = mk("i", null, body);
    /* The host never presses Ready — they press Start — so "waiting" would sit
       under their name for the whole lobby and read as something they had
       forgotten to do. */
    tag.textContent = !p ? "bot at start"
                    : p.host ? "hosting"
                    : p.ready ? "ready" : "waiting";
    // rank, so you can see who you are up against before the wands come out
    if (p && p.lv > 1){
      const lv = mk("em", "lv", cell);
      lv.textContent = "Lv " + p.lv;
    }
  }
}
let iAmReady = false;
function paintJoin(){
  const btn = el("joinGo");
  if (inRoom()){
    el("codeInput").disabled = true;
    btn.textContent = iAmReady ? "Ready ✓" : "Ready";
    btn.classList.toggle("done", iAmReady);
  } else {
    el("codeInput").disabled = false;
    btn.textContent = "Join";
    btn.classList.remove("done");
  }
  renderRoster(el("joinRoster"));
  paintPing(true);
  // the joiner is the one who usually has the long link, so show them the number
  if (inRoom()){
    const note = el("joinNote");
    if (note && !note.classList.contains("bad"))
      note.textContent = "Waiting for the host to start.";
  }
}
function onNetChange(n){
  if (n.error){
    netFail(panel === "host" ? "host" : "join", n.error);
    n.error = null;
    return;
  }
  if (panel === "host"){ setInvite(n.room); renderRoster(el("hostRoster")); hostNote(); }
  else if (panel === "join"){
    paintJoin();
    if (inRoom()){
      const note = el("joinNote");
      note.classList.remove("bad");
      note.textContent = "You are in room " + n.room + ". The match begins when everyone is ready, or when the host starts it.";
    }
  }
}

/* ---------------------------------------------------- the buttons */
el("soloBtn").addEventListener("click", () => { leaveRoom(); show("solo"); });
el("mpBtn").addEventListener("click", () => {
  show("mp");
});
el("diffRow").addEventListener("click", e => {
  const b = e.target.closest ? e.target.closest("button[data-diff]") : null;
  if (b) selectMode(+b.dataset.diff);
});
el("goBtn").addEventListener("click", () => {
  leaveRoom();
  if (mode === "match") mode = "duel";
  resetOfflineCfg();
  newMatch();
  cvs.focus();
});
el("hostBtn").addEventListener("click", () => {
  show("host");
  refreshCoopOptions();
  paintModeRows();
  setInvite(null);
  renderRoster(el("hostRoster"));
  hostNote();
  ensureConnected()
    .then(() => window.RPWNet.create({ total: roomTotal, difficulty: botLevel, private: true, opts: hostOpts() }))
    .catch(() => netFail("host"));
});
el("joinBtn").addEventListener("click", () => {
  show("join");
  iAmReady = false;
  paintJoin();
  const note = el("joinNote");
  note.classList.remove("bad");
  note.textContent = "Paste the code the host sent you.";
});
el("copyCode").addEventListener("click", () => {
  const code = el("inviteCode").textContent.trim();
  if (!code || code.startsWith("·")) return;
  const done = () => { el("copyCode").textContent = "Copied"; el("copyCode").classList.add("done"); };
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(code).then(done, () => {});
  }
});
el("codeInput").addEventListener("input", e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
});
el("joinGo").addEventListener("click", () => {
  if (inRoom()){ iAmReady = !iAmReady; window.RPWNet.ready(iAmReady); paintJoin(); return; }
  const code = (el("codeInput").value || "").trim().toUpperCase();
  if (code.length < 4){ netFail("join", "An invite code is four characters."); return; }
  ensureConnected()
    .then(() => {
      window.RPWNet.join(code);
      const note = el("joinNote");
      note.classList.remove("bad");
      note.textContent = "Knocking…";
    })
    .catch(() => netFail("join"));
});
el("startRoom").addEventListener("click", () => {
  // selectMode() used to be forced here to drag the solo panel out of
  // escalation; a hosted room now decides its own game type below.
  difficulty = botLevel;
  if (inRoom()){ window.RPWNet.start(); return; }   // the server hands everyone the same seed
  matchCfg = sanitizeMatchCfg(hostOpts());
  mode = matchCfg.coop ? "escalation" : "match";
  bossTest = !!matchCfg.boss;   // the host picked "Rematch: The Alchemist" — everyone jumps straight to it
  roomHumans = 1;
  newMatch();
  cvs.focus();
});
function leaveRoom(){
  if (window.RPWNet && window.RPWNet.net.room) window.RPWNet.leave();
  iAmReady = false;
}
// bound by id rather than delegated off document, so the headless rigs — whose
// document stub is getElementById and nothing else — can drive the menu too
el("soloBack").addEventListener("click", () => show("home"));
el("mpBack").addEventListener("click", () => show("home"));
el("hostBack").addEventListener("click", () => { leaveRoom(); show("mp"); });
el("joinBack").addEventListener("click", () => { leaveRoom(); show("mp"); });
/* ------------------------------------------------- the signed-in wizard
   src/account.js owns the session and the profile; everything here is the
   menu's side of it — the character strip, the sign-in form, and banking a
   finished match. All of it degrades to a guest if there is no account
   server to reach (the single-file build, a file:// page, an outage), so
   the game never depends on being signed in. */

const ACCT = () => window.RPWA || null;

function renderWho(profile){
  const card = el("whoCard"), guest = el("whoGuest");
  if (!card || !guest) return;
  if (profile){
    guest.hidden = true;
    card.hidden = false;
    el("whoName").textContent = profile.name;
    el("whoLevel").textContent = "Lv " + profile.level;
    el("whoXp").textContent = profile.into + " / " + profile.need;
    el("whoRec").textContent = profile.wins + "W \u00b7 " + profile.losses + "L";
    const pct = profile.need ? (profile.into / profile.need) * 100 : 0;
    el("whoFill").style.width = Math.max(profile.into > 0 ? 3 : 0, Math.round(pct)) + "%";
  } else {
    card.hidden = true;
    guest.hidden = false;
  }
  refreshMarks(profile);            // the cape wears the same jewels
  renderPass(profile);
  readName();                       // seats and the relay use this name
  scheduleFit();
}

/* The cloak track. Nothing is wearable yet — this is the ladder of what
   levelling is FOR, drawn from the jewel table in src/account.js. A guest sees
   the whole ladder locked, which is the honest answer to "what do I get".

   Built with createElement rather than innerHTML because each tier carries its
   stone's two colours as custom properties, and a style="" attribute is exactly
   what the site's Content-Security-Policy refuses. Setting them through the
   CSSOM is not an inline style and is allowed. */
function renderPass(profile){
  const box = el("pass"), list = el("passTrack"), note = el("passNext");
  const acct = ACCT();
  if (!box || !list || !note || !acct || !acct.track) return;
  if (!document.createElement) return;          // headless rigs have no DOM

  const t = acct.track(profile ? profile.level : 1);
  const earned = profile ? t.rows.filter(r => r.earned).length : 0;

  list.innerHTML = "";
  let focus = null;
  for (const r of t.rows){
    const li = document.createElement("li");
    li.className = "tier" + (!profile ? "" : r.earned ? " earned" : r.next ? " next" : "");
    li.title = r.name + " — level " + r.at;
    li.style.setProperty("--g1", r.from);

    const lv = document.createElement("span");
    lv.className = "lv"; lv.textContent = "Lv " + r.at;
    // CSS handles lit versus locked.
    let jewel;
    if (document.createElement){
      jewel = document.createElement("canvas");
      jewel.className = "jewel";
      jewel.width = jewel.height = 30;
      const g = jewel.getContext && jewel.getContext("2d");
      if (g){
        // The tile is a scrap of that rung's cloth with its emblem on it, drawn
        // by the same code that puts it on a cape — so the ladder is a picture
        // of what you will be wearing, not a decorative stand-in.
        // the same dark-shoulder-to-pale-hem gradient the cape is drawn with
        // the same one-colour fade the cape is drawn with, over the tile's own
        // dark ground, so the tile is a scrap of that rung's actual cloth
        g.fillStyle = "#0d0a18"; g.fillRect(3, 3, 24, 24);
        const grd = g.createLinearGradient(0, 3, 0, 27);
        grd.addColorStop(0, rgba(r.base, .95));
        grd.addColorStop(1, rgba(r.base, .16));
        g.fillStyle = grd; g.fillRect(3, 3, 24, 24);
        if (r.wedge){
          g.globalAlpha = r.wedge === "#ffffff" ? .22 : .7;
          g.fillStyle = r.wedge; g.fillRect(12, 3, 6, 24); g.globalAlpha = 1;
        }
        g.globalAlpha = .85; g.strokeStyle = "#ffffff"; g.lineWidth = 1;
        g.beginPath(); g.moveTo(3, 19.5); g.lineTo(27, 19.5); g.stroke();
        g.globalAlpha = 1;
        g.translate(15, 23.5); paintEmblem(g, 5.4, r.emblem, "#ffffff");
      }
    } else {
      jewel = document.createElement("span");
      jewel.className = "jewel";
    }
    const nm = document.createElement("span");
    nm.className = "nm"; nm.textContent = r.name;

    li.appendChild(lv); li.appendChild(jewel); li.appendChild(nm);
    list.appendChild(li);
    if (profile && (r.next || r.earned)) focus = li;   // ends on next, or the last earned
  }

  note.textContent = !profile
    ? "Sign in to start earning"
    : t.nextAt < 0
      ? earned + " of " + t.rows.length + " — the cloak is complete"
      : earned + " of " + t.rows.length + " · next at level " + t.nextAt;

  // On a normal screen the whole ladder is visible and there is nothing to do.
  // On something narrow it scrolls, and the tier being worked towards should be
  // the thing in view — one slot in from the left, so the jewel just earned
  // still shows beside it. offsetLeft is measured against the offsetParent, not
  // the scroller, so both are taken relative to the first tile.
  if (focus && list.scrollWidth > list.clientWidth + 1){
    const first = list.firstChild;
    const step = focus.offsetWidth + 6;                 // tile + the track's gap
    list.scrollLeft = Math.max(0, (focus.offsetLeft - first.offsetLeft) - step);
  }
}

/* Sign in and sign up are two buttons on one form, not one button and a mode.
   The old screen had a single "Sign in" button plus a "New here? Create a
   wizard" link that silently swapped what that button did — so the button you
   were looking at was not always the button you wanted, and nothing on screen
   said which state you were in. Now each button does its own thing when
   pressed, and there is no state to be in. */
let authFrom = "home";              // where Back and a finished sign-in return to

function authNote(text, kind){
  const n = el("authNote");
  if (!n) return;
  n.textContent = text;
  n.className = "note" + (kind ? " " + kind : "");
}
const AUTH_HELP = "Your wizard keeps its level and experience wherever you sign in. " +
                  "New here? Fill the same two boxes and press Sign up.";
function openAuth(){
  authFrom = (panel === "auth") ? authFrom : panel;
  el("authPass").value = "";
  authNote(AUTH_HELP);
  show("auth");
}
async function authSubmit(mode){
  const acct = ACCT();
  if (!acct) return;
  const up = mode === "up";
  const name = (el("authName").value || "").trim();
  const pass = el("authPass").value || "";
  // A new wizard is checked here as well as on the server, so the rule is on
  // screen before the round trip rather than as a rejection after it.
  const L = (window.RPWA && window.RPWA.limits) || { NAME_MIN: 3, PASS_MIN: 8 };
  if (up && (name.length < L.NAME_MIN || pass.length < L.PASS_MIN)){
    authNote(`A new wizard needs a name of at least ${L.NAME_MIN} characters, ` +
             `and a password of at least ${L.PASS_MIN}.`, "bad");
    return;
  }
  el("authGo").disabled = true; el("authNew").disabled = true;
  authNote(up ? "Creating your wizard\u2026" : "Signing you in\u2026");
  const res = up ? await acct.register(name, pass) : await acct.signIn(name, pass);
  el("authGo").disabled = false; el("authNew").disabled = false;
  if (!res || !res.ok){
    authNote((res && res.error) || "Something went wrong.", "bad");
    return;
  }
  el("authPass").value = "";
  show(authFrom === "auth" ? "home" : authFrom);
}

el("signInBtn").addEventListener("click", openAuth);
el("signOutBtn").addEventListener("click", () => { if (ACCT()) ACCT().signOut(); });
el("authBack").addEventListener("click", () => show(authFrom === "auth" ? "home" : authFrom));
el("authNew").addEventListener("click", () => authSubmit("up"));
// Enter in either box is the same as pressing Sign in, which is what a return
// key means on a form you have typed a known name and password into.
el("authForm").addEventListener("submit", e => { e.preventDefault(); authSubmit("in"); });

/* ---- banking a finished match --------------------------------------- */

// Who you just fought, in the shape the server prices: a person is worth
// more than a bot, and a harder bot is worth more than an easy one.
function rivalsFought(){
  const meSeat = (mode === "match") ? localSeat : 0;
  return seats
    .filter((s, i) => i !== meSeat)
    .map(s => s.human ? { human: true } : { human: false, level: difficulty })
    .slice(0, 5);
}
// Fired the moment the match ends so the answer is usually already back by
// the time the curtain is drawn 1.4s later.
function bankMatch(won, roundsWon){
  const acct = ACCT();
  if (!acct || !acct.signedIn) return Promise.resolve(null);
  return acct.report({ mode: "duel", won: !!won, roundsWon: roundsWon | 0, opponents: rivalsFought() });
}
function bankRun(score, waves, kills){
  const acct = ACCT();
  if (!acct || !acct.signedIn) return Promise.resolve(null);
  return acct.report({ mode: "escalation", score: score | 0, waves: waves | 0, kills: kills | 0 });
}
// Say what the match was worth. Guests get the one line that tells them why
// they got nothing; signed-in wizards get the number and where it left them.
function showEarned(out, prefix){
  const txt = el("curtainText");
  if (!txt) return;
  let line = "";
  if (!out){
    const acct = ACCT();
    if (!acct || !acct.signedIn) line = "Sign in and duels like that one earn experience.";
  } else if (out.gained > 0){
    const p = out.profile;
    line = (out.leveled > 0 ? "Level " + p.level + ". " : "") +
           "+" + out.gained + " experience \u00b7 " + p.into + " / " + p.need + " to level " + (p.level + 1) + ".";
    if (out.leveled > 0){
      const card = el("whoCard");
      if (card && card.classList){
        card.classList.remove("rankup");
        void card.offsetWidth;
        card.classList.add("rankup");
      }
    }
  }
  if (!line){ txt.hidden = true; return; }
  txt.textContent = (prefix ? prefix + " " : "") + line;
  txt.hidden = false;
  scheduleFit();
}

el("resumeBtn").addEventListener("click", () => { if (phase === "paused") togglePause(); });
el("menuBtn").addEventListener("click", toMenu);
// The how-to-play picture slots fall back to a labelled placeholder when the
// file is not there yet. Bound here rather than with an inline onerror= — the
// page is served with a script-src that allows no inline JavaScript.
if (document.querySelectorAll){
  for (const img of document.querySelectorAll(".shot img")){
    const mark = () => { const fig = img.closest(".shot"); if (fig) fig.classList.add("empty"); };
    if (img.complete && img.naturalWidth === 0) mark();
    img.addEventListener("error", mark);
  }
}
el("codeInput").addEventListener("keydown", e => {
  if (e.key === "Enter"){ e.preventDefault(); el("joinGo").click(); }
});
// Draw the character strip as a guest straight away, then turn any stored
// session back into a profile. Nothing waits on the network.
if (window.RPWA){
  window.RPWA.onChange(renderWho);
  window.RPWA.resume();
} else {
  renderWho(null);
}
show("home");

/* ---------------------------------------------------------- loop */
// The simulation only ever advances in fixed STEP slices. Two machines fed the
// same seed and the same input masks therefore produce identical frames, which
// is what the netcode in src/net.js is built on.
function simStep(){
  let dt = STEP;
  if (msg && msg.t < 90) msg.t -= dt;
  flash *= Math.max(0, 1 - dt*7);
  if (hitStop > 0){ hitStop -= dt; dt *= 0.14; }
  pumpInput();
  if (phase === "count"){
    phaseT -= STEP;
    if (phaseT <= 0){ phase = "fight"; msg = null; }
    update(dt*0.001);
  } else if (phase === "fight"){
    if (mode === "escalation") escTick(dt);
    update(dt);
  } else if (phase === "tally"){
    phaseT -= STEP;
    update(dt*0.35);
    if (phaseT <= 0 && phase === "tally") newRound();
  } else if (phase === "over"){
    update(dt*0.3);
  }
  simFrame++;
  NET.onStep(simFrame);
}
let last = performance.now(), acc = 0;
// Browsers stop requestAnimationFrame in a hidden tab. In a lockstep match that
// is fatal for EVERYONE, not just the person who tabbed away: their client stops
// stepping, so it stops sending input masks, so every peer waits on a frame that
// will never arrive and the whole match freezes. So the loop has two drivers —
// rAF while the tab is visible, a plain timer while it is not — and the hidden
// one skips drawing (nothing to draw to) but keeps the simulation, and therefore
// the outgoing masks, flowing.
function hiddenTab(){
  return typeof document !== "undefined" && document.hidden === true;
}
/* The clock that keeps a match honest.

   The simulation must advance sixty times a second in REAL time. It is not a
   solo game where running slow merely feels sluggish: in a lockstep match every
   client steps together, so one machine simulating at three quarters speed puts
   the whole room in slow motion. Measured on a full six-Archmage arena, that is
   exactly what used to happen — 46 simulation frames a second against a wall
   clock wanting 60.

   Two things caused it, and both were in these few lines:

   1. The step cap was five. A frame that renders in 77ms owes 4.6 steps, so any
      jitter at all pushed past the cap.
   2. On hitting the cap the leftover time was thrown away (`acc = 0`). That is
      not a catch-up policy, it is a leak — the time never comes back, and the
      match silently runs slow for everybody.

   Now the cap is generous enough to absorb a slow frame, the backlog is carried
   rather than dumped (bounded, so it can never spiral), and if the simulation
   is still behind after all that, the frame skips its PICTURE instead. Drawing
   is the expensive part by two orders of magnitude; a step is about a
   millisecond. Better to show one fewer frame than to hold five other players
   in treacle. */
const STEP_CAP = 12;        // steps one frame may run before it gives up
const MAX_BACKLOG = 12;     // steps of debt we are willing to carry
const MAX_SKIP = 1;         // never drop two pictures in a row
let skipped = 0;
function pump(now){
  const bg = hiddenTab();
  // background timers are clamped to about a second, so a hidden tab wakes up
  // owing a lot of frames; let it pay them off in one go rather than fall behind
  const real = Math.min((now - last)/1000, bg ? 2 : .25);
  last = now;
  acc += real;
  let steps = 0, waiting = false;
  const cap = bg ? 300 : STEP_CAP;
  while (acc >= STEP && steps < cap){
    if (NET.active && !NET.ready(simFrame)) { waiting = true; break; }   // a peer owes us input
    acc -= STEP;
    simStep();
    steps++;
  }
  // Waiting on a peer is not the same as being slow. Do not bank the waiting
  // time, or the moment their input lands we fast-forward through everything
  // that happened while we sat there.
  /* Tell the relay we are still here — a client waiting on a distant peer sends
     no input at all, and silence is what the stall sweep looks for — and tell
     the netcode how long we waited, so it can reach further ahead next time. */
  if (waiting){
    if (NET.alive) NET.alive();
    if (NET.waiting) NET.waiting(real * 1000);
  }
  if (waiting) acc = Math.min(acc, STEP * 2);
  else if (acc > STEP * MAX_BACKLOG) acc = STEP * MAX_BACKLOG;

  /* Held-Spark repeat lives ABOVE the draw-skip return: it is input, and input
     a busy frame quietly drops is input the player will swear they gave. */
  padRapid(real);
  audioTick(real);

  if (bg) return;
  syncHUD();
  if (!waiting && acc >= STEP && skipped < MAX_SKIP){ skipped++; return; }
  skipped = 0;
  updateCapes(real);
  updateBossView(real);
  draw();
  drawPad();
}
function frame(now){
  pump(now);
  requestAnimationFrame(frame);
}
let bgTimer = 0;
function stopBgPump(){
  if (bgTimer && typeof clearInterval === "function") clearInterval(bgTimer);
  bgTimer = 0;
}
function syncPumpToVisibility(){
  stopBgPump();
  // only in a networked match: a solo game politely pauses when you look away
  if (hiddenTab() && NET.active && typeof setInterval === "function"){
    bgTimer = setInterval(() => { try { pump(performance.now()); } catch (e) {} }, 16);
  }
}
if (typeof document !== "undefined" && document.addEventListener){
  document.addEventListener("visibilitychange", syncPumpToVisibility);
}
startPingBeat();
makeMap();
resetWizards();
msg = null;
requestAnimationFrame(frame);

/* ------------------------------------------------------------- desync report

   The relay tells us WHICH components stopped matching, not just that something
   did. Turn that into one plain sentence: a player learns it was not their
   connection, and we learn which part of the simulation to open. The names come
   from hashParts() and must keep meaning the same thing on both ends. */
let lastDesync = null;
const DESYNC_WORDS = {
  wizards: "the wizards themselves",
  spells:  "the spells in flight",
  scenery: "the scenery",
  rolls:   "the run of random rolls"
};
function desyncNote(d){
  if (!d) return "";
  const at = d.frame > 0 ? " at frame " + (d.frame | 0) : "";
  const named = (d.parts || []).map(k => DESYNC_WORDS[k]).filter(Boolean);
  if (!named.length) return "The two worlds parted company" + at + ".";
  let list = named[0];
  if (named.length === 2) list = named[0] + " and " + named[1];
  else if (named.length > 2) list = named.slice(0, -1).join(", ") + " and " + named[named.length - 1];
  return "What stopped matching: " + list + at + ".";
}

/* ============================================================ touch controls

   A phone has no keyboard, and this game asks for eight-way movement, six
   spells that charge while held, a dash and a target cycle. The temptation is
   a grid of little buttons; six 48px targets under one thumb is how you lose
   every duel to someone on a keyboard.

   So the right thumb gets a STICK, not buttons. The six spells sit in sectors
   around it, laid out to mirror the keyboard exactly — y u i across the top,
   h j k across the bottom — and the direction you push chooses which one.
   Push and let go quickly and you get a quick cast; push and hold and it
   charges, and it fires when you let the stick go.

   That last part is not a special case: it is precisely what the keyboard
   already does. Engaging a sector presses that spell's key and releasing lifts
   it, so a flick is a short hold and a hold is a long one. Which means NONE of
   this reaches the simulation. Touch sets the same `keys[]` and `tapped[]`
   entries a keyboard sets, `localMask()` reads them the way it always has, and
   the bit mask that goes over the wire is indistinguishable from a desktop
   player's. Determinism, the netcode and the relay never learn that phones
   exist, and a phone can duel a laptop.

   Everything here is behind TOUCH. On a desktop nothing is created, no
   listener is registered, and drawPad() returns on its first line. */


/* ------------------------------------------------------ the real viewport

   window.innerWidth/innerHeight and CSS's own 100dvh both assume a phone's
   browser chrome either always shows or always hides. Neither is reliably
   true — some browsers keep the address bar pinned and never collapse it,
   in which case dvh should already exclude it, but on at least one real
   tablet this shipped to it did not: the health plates ended up laid out
   at the top of a box taller than what was actually on screen, with the
   pinned bar sitting over them.

   visualViewport is the one number a browser cannot get wrong — it is
   defined as "the area actually visible right now" — so every place that
   used to read innerWidth/innerHeight to size or lay out the touch pad
   reads this instead, and style.css mirrors it into a --vvh custom
   property (see syncViewportVars()) for the same reason on the CSS side. */
function viewportSize(){
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (vv) return { w: vv.width, h: vv.height };
  return { w: typeof window !== "undefined" ? window.innerWidth : 0,
           h: typeof window !== "undefined" ? window.innerHeight : 0 };
}
/* Mirrors visualViewport into plain pixel custom properties so CSS has the
   same escape hatch: `height:var(--vvh, 100dvh)` falls back to dvh until
   this has run once, then wins over it everywhere dvh alone was not enough. */
function syncViewportVars(){
  if (typeof document === "undefined") return;
  const { w, h } = viewportSize();
  if (!w || !h) return;
  const root = document.documentElement.style;
  root.setProperty("--vvw", w + "px");
  root.setProperty("--vvh", h + "px");
}

/* Where the spells sit around the stick. Sector s spans [s*60, s*60+60) degrees
   measured clockwise from due right, so its centre is s*60+30 — and the six
   centres land on the eight-way diagonals and the vertical, which is what makes
   them findable by thumb without looking.

       upper-left  y      up  u      upper-right  i        <- keyboard top row
       lower-left  h    down  j      lower-right  k        <- keyboard bottom row  */
const PAD_SECTOR = [5, 4, 3, 0, 1, 2];      // sector index -> SPELLS index
const PAD_ANGLE = [30, 90, 150, 210, 270, 330];

const padPtr = { move: null, cast: null };  // pointerId -> which stick owns it
let padCtx = null, padEl = null;

/* ------------------------------------------------------ spell input: wedges

   A second way to work the same six spells: instead of dragging toward a
   name, each of the six compass slots is its own tap target. Press picks the
   spell and starts it charging (exactly what padCastEngage() already does —
   only what triggers it changes), release fires it, same as the stick. The
   slots and their spells are IDENTICAL to the stick's (PAD_SECTOR/PAD_ANGLE),
   on purpose: a player who already knows "Rive is straight up" from the stick
   should not have to relearn anything to use the wedges.

   PAD_WEDGE_INNER is the empty hole at the centre — a dead zone so a thumb
   that lands dead-centre (grabbing for the stick out of habit) does not fire
   whichever sector happens to sit at angle zero. PAD_WEDGE_OUTER is how far
   past the drawn edge a touch still counts, the same kind of forgiveness the
   aim and pause buttons already get via padHit(..., r + 8) — a phone thumb
   cannot see what it is covering, so the hit area is deliberately more
   generous than the drawn one. Both numbers are shared between the hit test
   here and the drawing in drawPad(), so the ring the player sees stays the
   ring the code triggers on (the same rule the dash rim holds itself to). */
const PAD_WEDGE_INNER = 0.22;
const PAD_WEDGE_OUTER = 1.12;

/* Pure: which spell (if any) a touch at (dx, dy) from the wedges' centre
   lands on, for a stick of radius R. No canvas, no pointer — same reasoning
   as padSpellAt/padAt, and what lets tools/touch-test.js check the geometry
   without a browser. */
function padWedgeSpellAt(dx, dy, R){
  const rad = HYPOT(dx, dy);
  if (rad < R * PAD_WEDGE_INNER || rad > R * PAD_WEDGE_OUTER) return null;
  return padSpellAt(padAngle(dx, dy));
}

/* ---------------------------------------------------- spell input: the mode

   Which of the two gestures above is live, remembered the same way the local
   scoreboard is (see HS_KEY) so the choice survives a reload. */
const PAD_MODE_KEY = "rpw.pad.spellMode";
function loadPadMode(){
  try { return localStorage.getItem(PAD_MODE_KEY) === "wedge" ? "wedge" : "stick"; }
  catch (e) { return "stick"; }
}
function savePadMode(mode){
  try { localStorage.setItem(PAD_MODE_KEY, mode); } catch (e) {}
}
let padSpellMode = loadPadMode();

/* ------------------------------------------------------------- the dash

   Dash is: push the stick out until it touches its outer ring. It goes the way
   you pushed, and only if the cooldown has come back.

   Two earlier attempts were worse. A double tap made you lift your thumb at the
   exact moment you were trying to move. A stutter — shove, ease off, shove
   again — kept the thumb down but was fiddly, and it fought the game: movement
   here is DIGITAL, eight directions on or off, so there is no reason at all not
   to rest the stick at full stretch, and a gesture built out of magnitude has to
   fight that. The rim is the honest version of the same idea. It is one motion,
   it is visible on the stick, and reaching it is a decision.

   The ring is armed by coming back INSIDE it. So resting against the rim spends
   one dash and no more, and a thumb that starts a touch already out past the rim
   — grabbing for the stick and landing wide — cannot dash until it has been
   inside once. A dash you did not ask for is worse than one you have to ask for
   twice. */
const PAD_DASH_RIM = 0.92;     // fraction of the stick's radius that counts as the ring
const PAD_DASH_REARM = 0.70;   // and how far back inside it must come to count again
let padArmed = false;          // a fresh touch is NOT armed; see above
let padDashAt = 0, padDenyAt = 0;

/* Returns what happened, which is what makes this testable: the arming rules
   and the cooldown gate are the whole of the behaviour, and neither needs a
   pointer, a canvas or a real second to check.

   `ready` is passed in rather than read from the world so a test can drive the
   cooldown branch directly. tryDash() remains the authority on whether a dash
   actually happens; this only decides whether to ASK, and what to show. */
function padRimDash(mag, R, ready, at){
  if (mag < R * PAD_DASH_REARM){ padArmed = true; return "armed"; }
  if (mag < R * PAD_DASH_RIM) return "inside";
  if (!padArmed) return "held";
  padArmed = false;
  const now = at != null ? at
            : (typeof performance !== "undefined" ? performance.now() : Date.now());
  if (!ready){ padDenyAt = now; return "cooldown"; }
  tapped[PAD1.dash] = true;    // exactly what a tap of shift does
  padDashAt = now;
  return "dash";
}

function padLayout(){
  const { w: vw, h: vh } = viewportSize();
  const R = Math.max(42, Math.min(76, Math.min(vw, vh) * 0.21));
  /* The rings the sticks wear — dash cooldown on the left, spell charge on the
     right — are drawn OUTSIDE the stick at 1.14 of its radius, so the margin
     has to clear those and not just the stick. Clearing only R put both rings
     a few pixels off the edge of the screen. */
  const m = R * 1.14 + 10;
  const aimY = vh - m - R - 26;
  /* The mode switch sits in a small row above the aim button, not "below"
     the spell control the way a settings mock might first suggest — the
     cast stick already sits hard against the bottom edge in landscape, so
     there is no room under it on an actual phone. Stacking upward in the
     same right-side thumb column is the nearest real estate that is still a
     single thumb's reach from the spell control it belongs to. */
  const modeY = aimY - 38;
  return { vw, vh, R,
           move:  { x: m, y: vh - m },
           cast:  { x: vw - m, y: vh - m },
           aim:   { x: vw - m, y: aimY, r: 19 },
           pause: { x: 24, y: 24, r: 17 },
           modeStick: { x: vw - m - 17, y: modeY, r: 14 },
           modeWedge: { x: vw - m + 17, y: modeY, r: 14 } };
}
function padHit(p, cx, cy, r){
  const dx = p.clientX - cx, dy = p.clientY - cy;
  return dx * dx + dy * dy <= r * r;
}
// Angle from a stick's centre, clockwise from due right, 0..360.
function padAngle(dx, dy){
  let a = ATAN2(dy, dx) * 180 / Math.PI;
  return (a + 360) % 360;
}

/* ------- the movement stick: eight directions, spelled as the same four keys */
/* Which of the eight directions a push means, as the four keys a keyboard would
   have held down. Pure, and separate from the pressing, so it can be checked
   without a pointer, a canvas or a phone. */
function padDirKeys(deg){
  const dir = Math.round(((deg % 360) + 360) % 360 / 45) % 8;   // 0 right, 2 down, 4 left, 6 up
  return { right: dir === 7 || dir === 0 || dir === 1,
           down:  dir === 1 || dir === 2 || dir === 3,
           left:  dir === 3 || dir === 4 || dir === 5,
           up:    dir === 5 || dir === 6 || dir === 7 };
}
/* Which spell a push means. Same deal: the sector maths is the part that can be
   wrong in a way nobody notices until a duel goes badly. */
function padSpellAt(deg){
  return PAD_SECTOR[Math.floor((((deg % 360) + 360) % 360) / 60) % 6];
}
function padMove(dx, dy, R){
  const dead = R * 0.30;
  const P = PAD1;
  if (HYPOT(dx, dy) < dead){
    keys[P.up] = keys[P.down] = keys[P.left] = keys[P.right] = false;
    return;
  }
  const k = padDirKeys(padAngle(dx, dy));
  keys[P.right] = k.right; keys[P.down] = k.down; keys[P.left] = k.left; keys[P.up] = k.up;
}
function padMoveOff(){
  const P = PAD1;
  keys[P.up] = keys[P.down] = keys[P.left] = keys[P.right] = false;
}

/* ------- the spell stick: push to pick, hold to charge, let go to cast

   The spell is LOCKED once the stick engages. Letting the sector follow the
   thumb sounds helpful and is not: sliding across a boundary mid-charge would
   fire the spell you were charging and start another one you did not ask for,
   which in a duel reads as the game casting at random. One push, one spell. */
function padCastEngage(st, idx){
  if (st.idx === idx) return;
  padCastRelease(st);
  st.idx = idx;
  const k = SPELLS[idx].key;
  keys[k] = true;
  tapped[k] = true;        // survive to the next sampled step even on a fast flick
  padFireT = 0; padFiring = false;
}
function padCastRelease(st){
  if (st.idx == null) return;
  keys[SPELLS[st.idx].key] = false;
  st.idx = null;
  padFireT = 0; padFiring = false;
}

/* ------------------------------------------------- Spark, held, on a phone

   Spark is the cheap fast one, and on a keyboard you use it by mashing Y. A
   thumb on a stick cannot mash: to fire twice you have to push out, come back
   inside, and push out again. So on a phone, holding the Spark sector repeats
   it instead of charging it.

   This is INPUT SYNTHESIS, not a rule change. The pad lets the key go and
   presses it again, which is the same stream of press and release edges a
   desktop player produces by hand. `applyMask()` sees nothing unusual, the
   twelve-bit mask on the wire is identical, and the simulation and the relay
   never learn that a thumb was involved. Nothing here can desync a match.

   It is also not free. Each Spark costs 9 mana against a 17/s regen — and the
   regen drops to 6/s while a spell is charging — so a full bar buys about
   eleven in a burst and then the rate settles near one a second. Mana does the
   balancing, which is why this needed no cooldown of its own.

   The re-press waits for `castLock` to clear rather than running on a fixed
   period: `beginCharge()` returns early while that lock is up, so a press
   timed inside it is silently swallowed and every other shot goes missing. */
const PAD_RAPID = 0;             // SPELLS index that repeats when held (Spark)
const PAD_RAPID_HOLD = 0.075;    // seconds held before it lets go and fires
let padFireT = 0, padFiring = false;

function padRapid(step){
  const c = padPtr.cast;
  if (!TOUCH || !c || c.idx !== PAD_RAPID || !you || you.dead){
    padFireT = 0; padFiring = false;
    return "idle";
  }
  const k = SPELLS[PAD_RAPID].key;
  if (!padFiring){
    padFireT += step;
    if (padFireT < PAD_RAPID_HOLD) return "hold";
    keys[k] = false;             // the release edge is what casts
    padFiring = true; padFireT = 0;
    return "fire";
  }
  if ((you.castLock || 0) > 0) return "locked";
  keys[k] = true; tapped[k] = true;
  padFiring = false; padFireT = 0;
  return "press";
}

/* Where the thumb is, what that means, and whether it just asked for a dash.
   Shared by the first touch and every move after it, so putting a thumb down
   already off-centre counts as a shove exactly like sliding there would. */
function padMoveUpdate(ptr, x, y, L){
  ptr.dx = x - ptr.ox; ptr.dy = y - ptr.oy;
  const mag = HYPOT(ptr.dx, ptr.dy);
  padMove(ptr.dx, ptr.dy, L.R);
  padRimDash(mag, L.R, !you || (you.dashCool || 0) <= 0);
}
function padSwitchMode(mode){
  if (padSpellMode === mode) return;
  padSpellMode = mode;
  savePadMode(mode);
  // a mode swap mid-charge would otherwise leave a key stuck down from the
  // gesture that is no longer live
  if (padPtr.cast){ padCastRelease(padPtr.cast); padPtr.cast = null; }
}
function padDown(e){
  if (!padPlaying()) return;
  const L = padLayout();
  if (padHit(e, L.move.x, L.move.y, L.R * 1.5) && e.clientX < L.vw / 2){
    padPtr.move = { id: e.pointerId, ox: L.move.x, oy: L.move.y, dx: 0, dy: 0 };
    padArmed = false;      // grabbing the stick is not a dash, wherever it lands
    padMoveUpdate(padPtr.move, e.clientX, e.clientY, L);
    e.preventDefault();
    return;
  }
  if (padHit(e, L.aim.x, L.aim.y, L.aim.r + 8)){ tapped["tab"] = true; e.preventDefault(); return; }
  if (padHit(e, L.pause.x, L.pause.y, L.pause.r + 8)){
    if (!NET.active && (phase === "fight" || phase === "paused")) togglePause();
    e.preventDefault();
    return;
  }
  if (padHit(e, L.modeStick.x, L.modeStick.y, L.modeStick.r + 8)){
    padSwitchMode("stick");
    e.preventDefault();
    return;
  }
  if (padHit(e, L.modeWedge.x, L.modeWedge.y, L.modeWedge.r + 8)){
    padSwitchMode("wedge");
    e.preventDefault();
    return;
  }
  if (padHit(e, L.cast.x, L.cast.y, L.R * 1.5) && e.clientX > L.vw / 2){
    padPtr.cast = { id: e.pointerId, ox: L.cast.x, oy: L.cast.y, dx: 0, dy: 0, idx: null };
    if (padSpellMode === "wedge"){
      // a tap picks its spell on contact — no drag to get right, and holding
      // still (even off the wedge) keeps charging exactly like a held key
      const idx = padWedgeSpellAt(e.clientX - L.cast.x, e.clientY - L.cast.y, L.R);
      if (idx != null) padCastEngage(padPtr.cast, idx);
    }
    e.preventDefault();
  }
}
function padMoveEvt(e){
  const L = padLayout();
  const m = padPtr.move, c = padPtr.cast;
  if (m && m.id === e.pointerId){
    padMoveUpdate(m, e.clientX, e.clientY, L);
    e.preventDefault();
  }
  if (c && c.id === e.pointerId){
    c.dx = e.clientX - c.ox; c.dy = e.clientY - c.oy;
    if (padSpellMode === "stick"){
      const d = HYPOT(c.dx, c.dy);
      if (d < L.R * 0.32) padCastRelease(c);          // back to the middle: let it go
      else padCastEngage(c, padSpellAt(padAngle(c.dx, c.dy)));
    }
    // wedge mode picked its spell on padDown() and does not re-check as the
    // thumb moves — that is the whole point of a button over a stick
    e.preventDefault();
  }
}
function padUp(e){
  const m = padPtr.move, c = padPtr.cast;
  if (m && m.id === e.pointerId){ padPtr.move = null; padMoveOff(); padArmed = false; }
  if (c && c.id === e.pointerId){ padCastRelease(c); padPtr.cast = null; }
}
/* A match that is not running should not be holding keys down for you — and
   neither should a manual you are reading. The How to play sheet covers the
   whole screen on a phone, so scrolling it would otherwise be a thumb dragging
   the movement stick. */
function padManualOpen(){
  const d = typeof document !== "undefined" && document.getElementById
          ? document.getElementById("manual") : null;
  return !!(d && d.open);
}
function padPlaying(){
  return TOUCH && phase !== "menu" && !padPortrait() && !padManualOpen();
}
function padPortrait(){
  if (typeof window === "undefined") return false;
  const { w, h } = viewportSize();
  return h > w;
}
function padClear(){
  padMoveOff();
  padArmed = false;
  padFireT = 0; padFiring = false;
  if (padPtr.cast) padCastRelease(padPtr.cast);
  padPtr.move = padPtr.cast = null;
}

/* ------------------------------------------------------------------ drawing */
function padResize(){
  if (!padEl) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { w, h } = viewportSize();
  padEl.width = Math.round(w * dpr);
  padEl.height = Math.round(h * dpr);
  padCtx = padEl.getContext("2d");
  padCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function padRing(g, x, y, r, from, to, color, width){
  g.beginPath();
  g.arc(x, y, r, from, to);
  g.strokeStyle = color; g.lineWidth = width; g.lineCap = "round";
  g.stroke();
}
/* How full the ring is, and what it means. Beam and Grasp have no charge level
   at all — Beam is a channel you hold open and Grasp is something you are
   carrying — so neither gets a charge sweep it does not have. Showing one would
   be inventing a number. */
function padCharge(w, idx){
  if (!w || idx == null) return null;
  const s = SPELLS[idx];
  if (s.id === "beam") return w.beamOn ? { kind: "channel", lvl: 1 } : null;
  if (s.id === "grasp") return w.held ? { kind: "hold", lvl: 1 } : null;
  if (w.charge !== idx || !s.maxChg) return null;
  return { kind: "charge", lvl: clamp(w.chargeT / s.maxChg, 0, 1) };
}
function drawPad(){
  if (!TOUCH || !padCtx) return;
  const g = padCtx, L = padLayout();
  g.clearRect(0, 0, L.vw, L.vh);
  if (!padPlaying()) return;
  const w = you;

  /* --- movement stick, wearing the dash cooldown as a ring ---

     The desktop reads dash readiness off its HUD card. A phone has no HUD card
     and the stick is the only thing the thumb is looking at, so the ring goes
     there: it fills as the cooldown runs down and closes when the dash is back.
     Same number the card uses, so the two can never disagree. */
  const m = padPtr.move;
  const ready = w ? clamp(1 - (w.dashCool || 0) / DASH_CD, 0, 1) : 1;
  g.globalAlpha = 1;
  padRing(g, L.move.x, L.move.y, L.R * 1.14, 0, TAU, "rgba(60,52,90,.55)", 4);
  if (ready > 0.001){
    // a fresh dash flashes the ring, so the gesture is acknowledged even when
    // the wizard is off the edge of the thumb's attention
    const flash = Math.max(0, 1 - (performance.now() - padDashAt) / 260);
    g.globalAlpha = ready >= 1 ? 0.9 : 0.75;
    padRing(g, L.move.x, L.move.y, L.R * 1.14, -Math.PI / 2,
            -Math.PI / 2 + TAU * ready,
            ready >= 1 ? (w && w.tint) || "#8b81a8" : "#5b5182", 4);
    if (flash > 0){
      g.globalAlpha = flash * 0.8;
      padRing(g, L.move.x, L.move.y, L.R * 1.14, 0, TAU, "#ffffff", 3);
    }
  }
  /* The ring is the dash, so it has to look like a thing you can reach: it
     lights in the wizard's tint while the dash is available, and the knob's
     travel is scaled so its EDGE meets the ring at exactly the magnitude that
     triggers one. A control whose gesture you cannot see is a control nobody
     finds — the first version clamped the knob at 0.62 of the radius, so the
     rim it was supposed to touch was permanently out of reach. */
  const KNOB = 0.34;
  const mag = m ? HYPOT(m.dx, m.dy) : 0;
  const atRim = mag >= L.R * PAD_DASH_RIM;
  const live = ready >= 1;
  const deny = Math.max(0, 1 - (performance.now() - padDenyAt) / 300);
  g.globalAlpha = m ? 0.95 : (live ? 0.7 : 0.45);
  padRing(g, L.move.x, L.move.y, L.R, 0, TAU,
          deny > 0 ? "#ff4d5e"
                   : live ? ((w && w.tint) || "#8b81a8") : "#3b3357",
          atRim && live ? 3.2 : 2);
  let kx = L.move.x, ky = L.move.y;
  if (m && mag > 0.001){
    // [0 .. rim] of real travel maps to [0 .. R-knob] of drawn travel
    const cl = Math.min(mag, L.R * PAD_DASH_RIM) * ((1 - KNOB) / PAD_DASH_RIM);
    kx += m.dx / mag * cl; ky += m.dy / mag * cl;
  }
  g.beginPath(); g.arc(kx, ky, L.R * KNOB, 0, TAU);
  g.fillStyle = atRim && live ? rgba((w && w.tint) || "#8b81a8", 0.34)
                              : "rgba(140,130,190,.30)";
  g.fill();
  g.strokeStyle = atRim && live ? ((w && w.tint) || "#8b81a8") : "#8b81a8";
  g.lineWidth = 1.5; g.stroke();

  /* --- spell input: the stick, or the wedges, whichever is picked below --- */
  const c = padPtr.cast;
  if (padSpellMode === "stick"){
    g.globalAlpha = c ? 0.95 : 0.62;
    padRing(g, L.cast.x, L.cast.y, L.R, 0, TAU, "#3b3357", 2);

    // the six names, in their own colours, dimmed when the mana is not there
    g.textAlign = "center"; g.textBaseline = "middle";
    g.font = "600 " + Math.round(L.R * 0.19) + "px ui-monospace, monospace";
    for (let s = 0; s < 6; s++){
      const idx = PAD_SECTOR[s], sp = SPELLS[idx];
      const a = PAD_ANGLE[s] * Math.PI / 180;
      const tx = L.cast.x + COS(a) * L.R * 0.70, ty = L.cast.y + SIN(a) * L.R * 0.70;
      const poor = w && w.mana < sp.cost * 0.95;
      if (c && c.idx === idx){
        g.globalAlpha = 1;
        g.beginPath();
        g.moveTo(L.cast.x, L.cast.y);
        g.arc(L.cast.x, L.cast.y, L.R, (PAD_ANGLE[s] - 30) * Math.PI / 180,
                                       (PAD_ANGLE[s] + 30) * Math.PI / 180);
        g.closePath();
        g.fillStyle = rgba(sp.color, 0.16); g.fill();
      }
      g.globalAlpha = poor ? 0.3 : (c && c.idx === idx ? 1 : 0.8);
      g.fillStyle = sp.color;
      g.fillText(sp.name, tx, ty);
    }

    // the charge ring, and only when there is really something to show
    const ch = padCharge(w, c && c.idx);
    if (ch){
      const sp = SPELLS[c.idx];
      g.globalAlpha = 1;
      padRing(g, L.cast.x, L.cast.y, L.R * 1.14, 0, TAU, "rgba(60,52,90,.55)", 4);
      if (ch.kind === "charge"){
        padRing(g, L.cast.x, L.cast.y, L.R * 1.14, -Math.PI / 2,
                -Math.PI / 2 + TAU * ch.lvl, sp.color, 4);
      } else {
        // a channel or a carried stone: full ring, breathing, no fake level
        g.globalAlpha = 0.55 + 0.35 * SIN(performance.now() / 140);
        padRing(g, L.cast.x, L.cast.y, L.R * 1.14, 0, TAU, sp.color, 4);
      }
    }

    // knob
    g.globalAlpha = c ? 0.95 : 0.62;
    let sx = L.cast.x, sy = L.cast.y;
    if (c){
      const d = HYPOT(c.dx, c.dy) || 1, cl = Math.min(d, L.R * 0.62);
      sx += c.dx / d * cl; sy += c.dy / d * cl;
    }
    g.beginPath(); g.arc(sx, sy, L.R * 0.30, 0, TAU);
    g.fillStyle = "rgba(140,130,190,.30)"; g.fill();
    g.strokeStyle = "#8b81a8"; g.lineWidth = 1.5; g.stroke();
  } else {
    /* --- spell wedges: same six compass slots as the stick, each its own tap
       target. No knob to draw — the wedge itself is the whole control, so
       what would have been the knob's glow becomes that wedge's fill. */
    const innerR = L.R * PAD_WEDGE_INNER;
    g.textAlign = "center"; g.textBaseline = "middle";
    for (let s = 0; s < 6; s++){
      const idx = PAD_SECTOR[s], sp = SPELLS[idx];
      const a = PAD_ANGLE[s] * Math.PI / 180;
      const a0 = a - Math.PI / 6 + 0.045, a1 = a + Math.PI / 6 - 0.045;
      const engaged = !!(c && c.idx === idx);
      const poor = w && w.mana < sp.cost * 0.95;

      g.beginPath();
      g.moveTo(L.cast.x + COS(a0) * innerR, L.cast.y + SIN(a0) * innerR);
      g.lineTo(L.cast.x + COS(a0) * L.R, L.cast.y + SIN(a0) * L.R);
      g.arc(L.cast.x, L.cast.y, L.R, a0, a1);
      g.lineTo(L.cast.x + COS(a1) * innerR, L.cast.y + SIN(a1) * innerR);
      g.arc(L.cast.x, L.cast.y, innerR, a1, a0, true);
      g.closePath();
      g.globalAlpha = poor ? 0.3 : (engaged ? 0.9 : 0.6);
      g.fillStyle = rgba(sp.color, engaged ? 0.26 : 0.10);
      g.fill();
      g.strokeStyle = sp.color;
      g.lineWidth = engaged ? 2.4 : 1.5;
      g.stroke();

      const midR = (innerR + L.R) * 0.58;
      const tx = L.cast.x + COS(a) * midR, ty = L.cast.y + SIN(a) * midR;
      g.globalAlpha = poor ? 0.35 : (engaged ? 1 : 0.85);
      g.fillStyle = sp.color;
      g.font = "600 " + Math.round(L.R * 0.155) + "px ui-monospace, monospace";
      g.fillText(sp.name, tx, ty);
    }
    padRing(g, L.cast.x, L.cast.y, innerR * 0.86, 0, TAU, "#3b3357", 1.6);

    // same charge signal as the stick's ring, drawn around the one engaged
    // wedge instead of the whole circle — there is only one spell it could
    // possibly be about
    const ch = padCharge(w, c && c.idx);
    if (ch){
      const sp = SPELLS[c.idx];
      const s = PAD_SECTOR.indexOf(c.idx);
      const a = PAD_ANGLE[s] * Math.PI / 180;
      const wa0 = a - Math.PI / 6, wa1 = a + Math.PI / 6;
      g.globalAlpha = 1;
      if (ch.kind === "charge"){
        padRing(g, L.cast.x, L.cast.y, L.R * 1.06, wa0, wa0 + (wa1 - wa0) * ch.lvl, sp.color, 4);
      } else {
        g.globalAlpha = 0.55 + 0.35 * SIN(performance.now() / 140);
        padRing(g, L.cast.x, L.cast.y, L.R * 1.06, wa0, wa1, sp.color, 4);
      }
    }
  }

  /* --- the two small buttons --- */
  g.globalAlpha = 0.6;
  padRing(g, L.aim.x, L.aim.y, L.aim.r, 0, TAU, "#3b3357", 2);
  g.font = "600 " + Math.round(L.aim.r * 0.9) + "px ui-monospace, monospace";
  g.fillStyle = "#8b81a8"; g.fillText("⊕", L.aim.x, L.aim.y + 1);
  if (!NET.active){
    padRing(g, L.pause.x, L.pause.y, L.pause.r, 0, TAU, "#3b3357", 2);
    g.fillStyle = "#8b81a8";
    g.font = "600 " + Math.round(L.pause.r * 0.8) + "px ui-monospace, monospace";
    g.fillText(phase === "paused" ? "▶" : "‖", L.pause.x, L.pause.y + 1);
  }

  /* --- spell-input mode switch ---

     Small on purpose: this is a settings control living on a fight screen,
     not a third thing to watch during one. */
  const stickSel = padSpellMode === "stick", wedgeSel = !stickSel;
  g.globalAlpha = 0.85;
  padRing(g, L.modeStick.x, L.modeStick.y, L.modeStick.r, 0, TAU,
          stickSel ? "#a97cff" : "#3b3357", stickSel ? 2.2 : 1.5);
  g.font = "700 " + Math.round(L.modeStick.r * 0.6) + "px ui-monospace, monospace";
  g.fillStyle = stickSel ? "#fff" : "#8b81a8";
  g.fillText("ST", L.modeStick.x, L.modeStick.y + 1);

  padRing(g, L.modeWedge.x, L.modeWedge.y, L.modeWedge.r, 0, TAU,
          wedgeSel ? "#a97cff" : "#3b3357", wedgeSel ? 2.2 : 1.5);
  g.fillStyle = wedgeSel ? "#fff" : "#8b81a8";
  g.fillText("WD", L.modeWedge.x, L.modeWedge.y + 1);

  g.globalAlpha = 1;
}

/* Portrait is not a playable shape for a 960x620 arena, so say so plainly
   rather than letterboxing the fight into a strip. */
function padOrient(){
  if (!TOUCH) return;
  syncViewportVars();
  const rot = el("rotate");
  const portrait = padPortrait();
  if (rot) rot.hidden = !portrait;
  if (portrait) padClear();
  padResize();
}
if (TOUCH && typeof document !== "undefined"){
  document.documentElement.classList.add("touch");
  /* The manual is open by default on a desktop, where it is a page section you
     scroll past. On a phone it is a sheet over the arena, so it starts shut. */
  const man = el("manual");
  if (man){
    man.open = false;
    // opening it mid-fight must let go of whatever the thumbs were holding
    man.addEventListener("toggle", () => { if (man.open) padClear(); });
  }
  padEl = el("pad");
  if (padEl){
    padEl.hidden = false;
    syncViewportVars();
    padResize();
    window.addEventListener("pointerdown", padDown, { passive: false });
    window.addEventListener("pointermove", padMoveEvt, { passive: false });
    window.addEventListener("pointerup", padUp);
    window.addEventListener("pointercancel", padUp);
    window.addEventListener("resize", padOrient);
    window.addEventListener("orientationchange", padOrient);
    /* window's own resize event does not always fire for a browser chrome
       show/hide that doesn't change window.innerHeight (some browsers only
       move visualViewport) — this is the one event guaranteed to fire when
       the actually-visible area changes for any reason at all. */
    if (window.visualViewport){
      window.visualViewport.addEventListener("resize", padOrient);
      window.visualViewport.addEventListener("scroll", syncViewportVars);
    }
    padOrient();
  }
}

// handed to src/net.js so the network layer can drive a match without
// reaching into the simulation's internals
window.RPW = {
  NET, BIT, STEP,
  seedRng,
  // net.js samples this once per frame to send. Consuming the tap latch here is
  // what stops a sub-frame press being sent twice — or not at all.
  localMask: () => { const m = localMask(you); clearTaps(); return m; },
  // net.js calls this whenever a match starts or ends, so the hidden-tab pump
  // starts and stops with the match and not only on a visibility change
  pumpSync: () => syncPumpToVisibility(),
  // net.js calls this when a match cannot continue. Saying plainly what happened
  // beats leaving somebody standing in an arena that has stopped agreeing with
  // everyone else's.
  endMatch(reason, detail){
    phase = "menu"; msg = null;
    hushBeams();
    el("pausePanel").hidden = true;
    el("curtain").hidden = false;
    show("mp");
    if (reason === "build"){
      el("curtainTitle").textContent = "You are running different copies";
      el("curtainText").textContent = "Your game and the other player's are not the same build, so they were never going to agree about the arena. Usually one browser is still holding an older copy of the game it saved earlier — the version number can look identical and the code underneath still differ. Both of you do a hard refresh (Ctrl+Shift+R, or Cmd+Shift+R on a Mac) and host again.";
    } else if (reason === "dropped"){
      el("curtainTitle").textContent = "You dropped out";
      el("curtainText").textContent = "Your game stopped sending input for long enough that the others carried on without you — your wizard finished the match as a bot. Join again to get back in.";
    } else {
      el("curtainTitle").textContent = "The match fell out of sync";
      // Name what stopped matching. A player reads "the spells in flight" and
      // knows it was not their connection; we read it and know which function
      // to open. Without it every report is the same report.
      el("curtainText").textContent =
        "Two players stopped agreeing about the state of the arena, so the match was stopped rather than left to drift apart. "
        + desyncNote(detail)
        + " Host or join again to play on.";
      lastDesync = detail || null;
    }
    el("curtainText").hidden = false;
  },
  seatOf: () => you.seat,
  frameNow: () => simFrame,
  // test hook: how many beams are currently locked against each other. A clash
  // test that never produced a clash is not evidence about clashes.
  clashing: () => clashes.length,
  // test hook: what the last desync report actually said
  lastDesync: () => lastDesync,
  // test hooks for the touch pad: what it thinks it is, and where it puts things.
  // padAt() is pure and works on a desktop too, so the sector and direction
  // maths can be checked by the headless suite rather than only in a browser.
  touch: () => TOUCH,
  // drive the dash gesture directly: how far out the stick is as a fraction of
  // its radius, and whether the cooldown is back. Returns what happened —
  // "armed", "inside", "held", "cooldown" or "dash" — so the arming rules and
  // the cooldown gate can be checked without a pointer or a canvas.
  padPush: (frac, ready) => padRimDash(frac * 100, 100, ready !== false),
  padDashReset: () => { padArmed = false; },
  padAt: (deg) => ({ spell: SPELLS[padSpellAt(deg)].key,
                     name: SPELLS[padSpellAt(deg)].name,
                     dirs: padDirKeys(deg) }),
  // the wedges' hit test, driven directly: (dx, dy) from the wedges' own
  // centre and a radius, same as padPush() drives the dash without a pointer.
  // Returns a key ("y".."k") or null, exactly what a real touch would engage.
  padWedgeAt: (dx, dy, R) => {
    const idx = padWedgeSpellAt(dx, dy, R != null ? R : 100);
    return idx == null ? null : SPELLS[idx].key;
  },
  // the spell-input mode, exercised the same way a pointerdown on the
  // buttons would. padSetMode and padForceMode are the same call now that
  // there is no lock to bypass — both names kept so existing tests read the
  // same either way.
  padMode: () => padSpellMode,
  padSetMode: (mode) => { padSwitchMode(mode === "wedge" ? "wedge" : "stick"); return padSpellMode; },
  padForceMode: (mode) => { padSwitchMode(mode === "wedge" ? "wedge" : "stick"); return padSpellMode; },
  // engages a spell the way a real touch would, without needing a pointer
  // event to synthesize — so a test can put something mid-charge and then
  // check what a mode switch does to it
  padDebugEngage: (key) => {
    const idx = SPELLS.findIndex(s => s.key === key);
    if (idx < 0) return null;
    padPtr.cast = { id: -1, ox: 0, oy: 0, dx: 0, dy: 0, idx: null };
    padCastEngage(padPtr.cast, idx);
    return padPtr.cast.idx;
  },
  padInfo: () => ({
    on: TOUCH, playing: padPlaying(), portrait: padPortrait(),
    layout: TOUCH ? padLayout() : null,
    manual: padManualOpen(),
    move: padPtr.move ? { dx: padPtr.move.dx, dy: padPtr.move.dy } : null,
    cast: padPtr.cast ? { dx: padPtr.cast.dx, dy: padPtr.cast.dy, idx: padPtr.cast.idx } : null,
    sectors: PAD_SECTOR.map((i, s) => ({ deg: PAD_ANGLE[s], key: SPELLS[i].key, name: SPELLS[i].name })),
    charge: padCharge(you, padPtr.cast && padPtr.cast.idx),
    dash: { ready: you ? clamp(1 - (you.dashCool || 0) / DASH_CD, 0, 1) : 1,
            cd: DASH_CD, rim: PAD_DASH_RIM, armed: padArmed },
    rapid: { spell: SPELLS[PAD_RAPID].key, hold: PAD_RAPID_HOLD,
             engaged: !!(padPtr.cast && padPtr.cast.idx === PAD_RAPID),
             releasing: padFiring },
    spellMode: padSpellMode
  }),
  desyncNote,
  startMatch(opts){
    // The game type rides in the sanitised opts rather than as its own protocol
    // field, so all three relays already agree on it and src/net.js does not
    // need to know co-op exists.
    matchCfg = sanitizeMatchCfg(opts.opts || null);
    mode = matchCfg.coop ? "escalation" : (opts.mode || "match");
    bossTest = !!matchCfg.boss;   // the sanitised opts came off the relay, so every seat agrees on this the same way it agrees on the seed
    difficulty = opts.difficulty != null ? opts.difficulty : difficulty;
    roomTotal = opts.total || roomTotal;
    roomHumans = opts.humans || 1;
    localSeat = opts.seat != null ? opts.seat : 0;
    seatNames = opts.names || null;
    seatLevels = opts.levels || null;
    if (opts.name) playerName = opts.name;
    newMatch(opts.seed);
  },
  seats: () => seats.map(x => ({ name: x.name, human: x.human })),
  // test hook: where everyone is and what they are being told to do, so a rig
  // can follow a keypress all the way through to the wizard actually moving
  where: () => wizards.map(w => ({
    seat: w.seat, human: w.human, dead: w.dead,
    x: Math.round(w.x * 100) / 100, y: Math.round(w.y * 100) / 100,
    mx: w.moveX || 0, my: w.moveY || 0,
    mana: Math.round(w.mana * 10) / 10, charge: w.charge, beam: !!w.beamOn
  })),
  // test hook: every shot in the air, regardless of owner.
  allShots: () => shots.map(s => ({
    x: s.x, y: s.y, vx: s.vx, vy: s.vy, weight: s.weight, r: s.r,
    kind: s.kind, ownerId: s.owner ? s.owner.id : -1, seq: s.seq
  })),
  // test hook: the cape's cloth for a seat. The spine, the two derived hems,
  // and the turn taken at each joint — that last one is what a test needs to
  // assert the cloth cannot fold through itself.
  capeOf(seat){
    const w = wizards.find(x => x.seat === seat);
    if (!w || !w.cape || !w.cape.p) return null;
    const c = w.cape, P = c.p, last = P.length - 1;
    const dx = COS(w.facing), dy = SIN(w.facing);
    const rel = p => {
      const ox = p.x - w.x, oy = p.y - w.y;
      return { x: ox, y: oy, lateral: ox * -dy + oy * dx };
    };
    const dirAt = i => {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(last, i + 1)];
      let ux = b.x - a.x, uy = b.y - a.y;
      const d = HYPOT(ux, uy) || 1;
      return { x: ux / d, y: uy / d };
    };
    const L = [], R = [];
    for (let i = 0; i <= last; i++){
      const u = dirAt(i), h = capeHalf(i, last, capeWide(capeMarks(w).at),
                                       capeMarks(w).flare || 0, c.wob);
      L.push(rel({ x: P[i].x - u.y * h, y: P[i].y + u.x * h }));
      R.push(rel({ x: P[i].x + u.y * h, y: P[i].y - u.x * h }));
    }
    return {
      rung: capeMarks(w).at, emblem: capeMarks(w).emblem, seams: capeMarks(w).seams,
      tail: capeMarks(w).tail, flare: capeMarks(w).flare,
      nodes: P.map(rel), left: L, right: R,
      segs: P.slice(1).map((p, i) => HYPOT(p.x - P[i].x, p.y - P[i].y)),
      // the bend at each joint, in radians
      turns: c.a.slice(1).map((a, i) => {
        let d = (a - c.a[i]) % TAU;
        if (d > Math.PI) d -= TAU;
        if (d < -Math.PI) d += TAU;
        return d;
      }),
      widths: P.map((p, i) => capeHalf(i, last, capeWide(capeMarks(w).at)) * 2)
    };
  },
  // test hook: land a finishing blow on a seat, so a rig can reach the end of
  // a round (and of a match) without playing one out in real time
  /* Test hook: put a live shot in the air from one wizard aimed straight at
     another, bypassing targeting entirely. Normal play cannot aim an ally at an
     ally — which is exactly why the no-friendly-fire rule needs a way to be
     tested rather than assumed. Uses only view-safe values and is never called
     during a real match. */
  fireAt(fromId, toId, dmg = 40, weight = 3){
    const a = wizards.find(x => x.id === fromId);
    const b = wizards.find(x => x.id === toId);
    if (!a || !b) return false;
    const ang = ATAN2(b.y - a.y, b.x - a.x);
    shots.push({
      x: a.x + COS(ang)*22, y: a.y + SIN(ang)*22,
      vx: COS(ang)*600, vy: SIN(ang)*600,
      weight, w0: weight, dmg, r: 9, glow: 22,
      color: "#fff", kind: "spark", owner: a, life: 4, trail: [], spin: 0,
      seek: null, lvl: 0, seq: shotSeq++
    });
    return true;
  },
  // Test hook: who is on whose side, and what each wizard is aiming at.
  sides: () => wizards.map(w => ({
    id: w.id, seat: w.seat, team: w.team, ally: !!w.ally, dead: !!w.dead,
    hp: Math.round(w.hp * 100) / 100, hpMax: w.hpMax, mana: Math.round(w.mana * 10) / 10,
    beamOn: !!w.beamOn, beamWind: w.beamWind, beamLen: Math.round(w.beamLen || 0), x: w.x, y: w.y, facing: w.facing,
    target: w.target ? w.target.team : null,
    lock: w.lock ? w.lock.team : null
  })),
  waveNow: () => waveNo,
  // whether this browser has reached the boss for real and so has the
  // "Rematch: The Alchemist" option unlocked, in the solo menu and in a
  // hosted room's game picker alike
  bossReached: () => bossUnlocked(),
  // test hooks for the Alchemist. bossTest() starts the menu's "Boss test" run
  // without a click; bossState() is what a rig reads to know where the fight is;
  // autoplay() hands `you` to a bot so a recording does not need hands. None of
  // them is reachable from a real match.
  bossTest(seed){
    leaveRoom(); selectMode(4); resetOfflineCfg(); newMatch(seed);
  },
  bossState(){
    const b = wizards.find(q => q.boss);
    if (!b) return null;
    const B = b.boss;
    return { dead: !!b.dead, hp: Math.round(b.hp*100)/100, hpMax: b.hpMax, phase: B.phase, pair: B.pair,
             fires: B.fires, next: B.next, x: b.x, y: b.y, facing: b.facing, beamOn: !!b.beamOn,
             lock: B.lock.map(i => SPELLS[i].id), slots: B.slots.slice(), spinK: B.spinK,
             combo: B.combo ? B.combo.id : null, fuse: B.fuse ? { stage: B.fuse.stage, t: B.fuse.t } : null, flashN: B.flashN,
             prism: !!B.prism, mana: Math.round(b.mana*10)/10, dashes: B.dashes, dodges: B.dodges, wards: B.wards,
             dry: Math.max(...B.arms.map(A => A.dry)), sensed: B.sense ? { hit: B.sense.hit, weight: B.sense.weight, beam: B.sense.beam } : null,
             dashCool: b.dashCool, target: b.target ? { x: b.target.x, y: b.target.y } : null,
             refl: B.refl ? { t: B.refl.t, ang: B.refl.ang, half: B.refl.half, out: B.refl.out.map(o => ({ id: o.id, x: o.x, y: o.y, ang: o.ang, len: o.len })) } : null,
             reflN: B.reflN, reflCd: B.reflCd, beamUp: bossBeamUp(b), r: b.r,
             arms: B.arms.map((A, i) => ({ id: BOSS_ARMS[i].id, spell: SPELLS[A.spell].id, st: A.st, out: A.k, cf: A.cf, rc: A.rc, rw: A.rw,
                                           k: A.st === 0 ? clamp(A.t / A.dur, 0, 1) : (A.st === 3 ? 0 : 1),
                                           live: bossLive(B, i), foc: A.foc })),
             shots: shots.filter(q => q.owner === b).map(q => ({ kind: q.kind, x: q.x, y: q.y, vx: q.vx, vy: q.vy, life: q.life })),
             los: b.target ? lineClear(b, b.target, true) : true,
             held: !!b.held, ward: b.ward };
  },
  // test hook: the boss's soft parts — where each drawn hand is against where the
  // simulation wants it, the hat's turn, and the cloth's links — so the springs and
  // the cloth can be checked for overshoot, settling and stretch without a screen
  bossView(){
    const b = wizards.find(q => q.boss && !q.dead);
    if (!b || !b.view) return null;
    const v = b.view;
    const chainInfo = ch => {
      let worst = 0;
      for (let i = 0; i < ch.n - 1; i++) worst = Math.max(worst, Math.abs(HYPOT(ch.x[i+1]-ch.x[i], ch.y[i+1]-ch.y[i]) / ch.seg - 1));
      let sag = 0;
      for (let i = 1; i < ch.n; i++){
        const r = ch.rest[i], c = COS(v.cf), s2 = SIN(v.cf);
        sag = Math.max(sag, HYPOT(ch.x[i] - (b.x + c*r[0] - s2*r[1]), ch.y[i] - (b.y + s2*r[0] + c*r[1])));
      }
      const finite = ch.x.every(Number.isFinite) && ch.y.every(Number.isFinite);
      // how far any link of it points from straight behind the cloth's own heading, and where its hem is
      let swing = 0;
      for (let i = 0; i < ch.n - 1; i++) swing = Math.max(swing, Math.abs(angleTo(v.cf + Math.PI, ATAN2(ch.y[i+1]-ch.y[i], ch.x[i+1]-ch.x[i]))));
      const N = ch.n - 1, dx = ch.x[N] - b.x, dy = ch.y[N] - b.y;
      return { stretch: worst, away: sag, finite, swing, tip: angleTo(v.face + Math.PI, ATAN2(dy, dx)) };
    };
    return {
      face: v.face, simFace: b.facing, hat: v.hat, ring: v.ring, star: v.star ? v.star.t : null, stream: v.stream, cf: v.cf,
      arms: v.arms.map((a, i) => { const T = bzTarget(b, i, v.face); return { E: a.E.slice(), H: a.H.slice(), tE: T.E, tH: T.H, live: bossLive(b.boss, i), out: b.boss.arms[i].k }; }),
      cloth: bzCloth(v).map(chainInfo), raw: { cloak: v.cloak, under: v.under }
    };
  },
  // test hooks: the one-off cues asked for so far (whether or not there was anything to play them), and where the music is
  sfxLog: () => sfxLog.slice(),
  sfxClear(){ sfxLog.length = 0; },
  audioState: () => ({ duck: musicDuck, duckTo, alert: alertQ.state, alerted: bossAlerted, track: musicTrack,
                       fades: fades.map(f => ({ name: f.name, k: f.k, v: f.vol * f.k, t: f.t, out: f.out >= 0 })) }),
  // test hook: jump an escalation run to just after wave n, before anything has spawned
  skipToWave(n){ waveNo = n; waveLive = false; waveGap = 0; },
  autoplay(level){
    if (!you) return;
    you.human = false; you.D = DIFF[level == null ? 2 : level];
  },
  smite(id){
    const w = wizards.find(x => x.id === id) || wizards.find(x => x.seat === id);
    if (w && w.hp > 0) strike(w, 9999, w.x, w.y, "spark", false);
  },
  // test hook: sweep every prop off the floor.
  clearScenery: () => { debris.length = 0; },
  // test hook: sweep every shot out of the air too.
  clearShots: () => { shots.length = 0; },
  // test hook: open (or close) a wizard's beam the way pressing the key does, for a rig that wants to beam the boss
  forceBeam(id, on){
    const w = wizards.find(x => x.id === id);
    if (!w || w.dead) return false;
    w.beamForced = !!on;                                  // a bot that is being made to beam does not take the hint from the mirror
    if (on){ if (!w.beamOn){ w.beamOn = true; w.beamWind = 0; w.charge = null; } }
    else if (w.beamOn) stopBeam(w, true);
    return true;
  },
  // test hook: raise the Alchemist's mirror on the spot, with no beam and no charge to it, and hold it up (until released with hold=false)
  bossMirror(hold){
    const b = wizards.find(q => q.boss && !q.dead);
    if (!b) return false;
    if (hold === false){ if (b.boss.refl) b.boss.refl.hold = false; return true; }
    if (!b.boss.refl) bossReflectOpen(b, b.target);
    b.boss.refl.hold = true;
    return true;
  },
  // test hook: make the Alchemist dash along (ax, ay), as it does to get out of a lane
  bossDash(ax, ay){
    const b = wizards.find(q => q.boss && !q.dead);
    return b ? tryDash(b, ax, ay) : false;
  },
  // test hook: set a wizard's health and mana (a rig cannot otherwise arrange "the party arrives hurt and dry")
  setVitals(id, hp, mana){
    const w = wizards.find(x => x.id === id);
    if (w){ w.hp = hp; w.mana = mana; }
  },
  matchCfg: () => ({ ...matchCfg }),
  phase: () => phase,
  // a cheap checksum of everything the simulation owns, for determinism tests
  /* The same checksum, taken in pieces.

     `hash()` answers "do we still agree?". When the answer is no, that single
     number says nothing about WHAT stopped agreeing, and finding out has meant
     asking two people in different countries to play again and guess with me.
     These four say where to look:

       wizards   position, health, mana, facing
       spells    everything in flight
       scenery   the props, where they are and what is left of them
       rolls     the seeded random stream, and the frame it is on

     A divergence in `rolls` alone means somebody drew from the seeded stream
     when they should not have — the shape of every desync this game has shipped.
     One in `wizards` but not `rolls` means the inputs or the timestep differed.
     Four small numbers a second, and the next failure names itself. */
  hashParts(){
    const acc = { wizards: 2166374761, spells: 2166374761, scenery: 2166374761, rolls: 2166374761 };
    const mix = (k, v) => { let h = acc[k]; h ^= (v * 1000) | 0; acc[k] = Math.imul(h, 16777619) >>> 0; };
    mix("rolls", simFrame); mix("rolls", rngState & 0xffff);
    mix("spells", shots.length); mix("scenery", debris.length);
    for (const w of wizards){
      mix("wizards", w.x); mix("wizards", w.y); mix("wizards", w.hp);
      mix("wizards", w.mana); mix("wizards", w.facing);
    }
    for (const s of shots){ mix("spells", s.x); mix("spells", s.y); mix("spells", s.weight); }
    for (const d of debris){
      mix("scenery", d.x); mix("scenery", d.y);
      mix("scenery", d.hp === Infinity ? 9 : d.hp);
    }
    for (const k in acc) acc[k] = acc[k] >>> 0;
    return acc;
  },
  hash(){
    let h = 2166136261 >>> 0;
    const mix = v => { h ^= (v * 1000) | 0; h = Math.imul(h, 16777619) >>> 0; };
    mix(simFrame); mix(shots.length); mix(debris.length); mix(rngState & 0xffff);
    for (const w of wizards){ mix(w.x); mix(w.y); mix(w.hp); mix(w.mana); mix(w.facing); }
    for (const s of shots){ mix(s.x); mix(s.y); mix(s.weight); }
    for (const d of debris){ mix(d.x); mix(d.y); mix(d.hp === Infinity ? 9 : d.hp); }
    return h >>> 0;
  },
  version: "0.1.0"
};
})();
