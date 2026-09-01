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
const WARD_BLOCKS = { spark:1, rive:1 };
const KEYMAP = {"y":0,"u":1,"i":2,"h":3,"j":4,"k":5};
const KEYMAP2 = {"1":0,"2":1,"3":2,"4":3,"5":4,"6":5};   // player two, top row or numpad
// Input is sampled once per simulation step into a bit mask. Local play reads the
// keyboard; a networked match reads the same mask off the wire instead.
const BIT = { up:1, down:2, left:4, right:8, spell:16, dash:1024, tab:2048 };
function localMask(w){
  const C = w.pad;
  let m = 0;
  if (keys[C.up]) m |= BIT.up;
  if (keys[C.down]) m |= BIT.down;
  if (keys[C.left]) m |= BIT.left;
  if (keys[C.right]) m |= BIT.right;
  const km = w.seat === localSeat ? KEYMAP : KEYMAP2;
  for (const k in km) if (keys[k]) m |= BIT.spell << km[k];
  if (keys[C.dash]) m |= BIT.dash;
  if (C.tab && keys.tab) m |= BIT.tab;
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
const dist2 = (a,b) => (a.x-b.x)**2 + (a.y-b.y)**2;
const dist = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);
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
  return (px-cx)**2 + (py-cy)**2 <= r*r;
}

/* ---------------------------------------------------------- state */
let debris = [], shots = [], bits = [], rings = [], ghosts = [], floor = null;
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
const TIER_TINT = ["#5dffab", "#4aa3ff", "#c58cff"];
const TINTS = ["#7ee9ff", "#ffd24a", "#ff9d6b", "#c58cff", "#5dffab", "#ff6b9d"];
let playerName = "Wizard";
const PAD1 = { up:"w", down:"s", left:"a", right:"d", dash:"shiftL", tab:true };
const PAD2 = { up:"arrowup", down:"arrowdown", left:"arrowleft", right:"arrowright", dash:"shiftR", tab:false };

function makeWizard(x,y,friendly){
  return {
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
  stool:   { solid:0, stopsShot:0, stopsBeam:0, hp:1,        lift:1, r:[9,12],  chip:"#c09566" }
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
  // Presets are a multiplayer host choice only. In solo, duel, or escalation the
  // arena ALWAYS uses the seeded random scatter — never a fixed layout — no
  // matter what state a previous networked match left behind.
  const preset = NET.active ? MAP_PRESETS[matchCfg.mapPreset] : null;
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
  g.fillStyle = "#0c0918"; g.fillRect(0,0,W,H);
  // flagstones
  for (let y = 0; y < H; y += 40){
    for (let x = 0; x < W; x += 40){
      g.fillStyle = `rgba(255,255,255,${0.006 + rand()*0.012})`;
      g.fillRect(x+1, y+1, 38, 38);
    }
  }
  // duelling circle
  g.save();
  g.translate(W/2, H/2);
  g.strokeStyle = "rgba(169,124,255,.14)";
  g.lineWidth = 1.4;
  g.beginPath(); g.arc(0,0,190,0,TAU); g.stroke();
  g.beginPath(); g.arc(0,0,168,0,TAU); g.stroke();
  g.strokeStyle = "rgba(63,231,255,.10)";
  for (let i = 0; i < 12; i++){
    const a = i/12*TAU;
    g.beginPath();
    g.moveTo(Math.cos(a)*168, Math.sin(a)*168);
    g.lineTo(Math.cos(a)*190, Math.sin(a)*190);
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
  floor = f;
}

/* ---------------------------------------------------------- input */
const keys = {};
const held = {};   // spell index -> true while key down
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
  if (keys[k]) return;
  keys[k] = true;
  if (k === "p" && (phase === "fight" || phase === "paused")) togglePause();
  if (k === "r" && phase !== "menu") { resetOfflineCfg(); newMatch(); }
});
window.addEventListener("keyup", e => {
  if (typing(e)) return;
  const k = e.key.toLowerCase();
  keys[k] = false;
  if (k === "shift") keys[(e.code || "") === "ShiftRight" ? "shiftR" : "shiftL"] = false;
});
window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; if (phase === "fight" && !NET.active) togglePause(); });

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
function cast(w, idx, lvl){
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
  const a = w.facing;
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
        x: w.x + Math.cos(a)*20 - Math.sin(a)*off*46,
        y: w.y + Math.sin(a)*20 + Math.cos(a)*off*46,
        vx: Math.cos(ang)*sp, vy: Math.sin(ang)*sp,
        weight: 1, w0: 1,
        dmg: 9 * (1 + lvl*0.35) * dmgMul(w),
        r: 6.5,
        color: s.color, kind: s.id, owner: w, life: 3.4, trail: [], spin: 0,
        seek: { turn: .6, wob: .85, vMin: sp, vMax: sp, phase: rand()*TAU },
        glow: 16, lvl
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
      turn: 0.18 + 2.35*Math.pow(lvl, 1.8),
      wob:  (1 - lvl) * 1.35,
      vMin: speed,
      vMax: 265 + 355*lvl,
      phase: rand()*TAU
    };
  }
  shots.push({
    x: w.x + Math.cos(a)*22, y: w.y + Math.sin(a)*22,
    vx: Math.cos(a)*speed, vy: Math.sin(a)*speed,
    weight, w0: weight,
    dmg: s.dmg * (1 + lvl*0.9) * dmgMul(w),
    r: hexR || (s.radius + weight*1.6),
    glow: s.id === "hex" ? 8 + 30*lvl : 22,
    color: s.color, kind: s.id, owner: w, life: seek ? 5.2 : 4, trail: [], spin: 0,
    seek, lvl
  });
  swish(w, s.color, "cast");
  castSound(w, s.id);
  shake = Math.min(shake + (REDUCED ? 0 : weight*0.55), 9);
}
function throwHeld(w){
  const d = w.held; if (!d) return;
  const a = w.facing;
  d.owner = null; d.thrown = 1.6;
  d.vx = Math.cos(a)*520; d.vy = Math.sin(a)*520;
  d.thrower = w;
  w.held = null;
  swish(w, byId.grasp.color, "cast");
  shake = Math.min(shake + (REDUCED?0:4), 9);
}

const DASH_CD = 3;
function tryDash(w, ax, ay){
  if (w.dead || w.dashCool > 0 || w.dashT > 0 || w.beamOn) return false;
  let dx = ax, dy = ay;
  if (Math.hypot(dx, dy) < .01){ dx = Math.cos(w.facing); dy = Math.sin(w.facing); }
  const L = Math.hypot(dx, dy) || 1;
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
    if (!REDUCED) ghosts.push({ x:w.x, y:w.y, facing:w.facing, friendly:w.friendly, tint:w.tint, t:0, life:.26 });
    return;
  }
  const beamSlow = (w.beamOn && w.beamWind >= byId.beam.cast) ? .35 : 1;
  const chargeSlow = w.charge !== null ? .55 : 1;
  const holdSlow = w.held ? .82 : 1;
  const spd = 190 * beamSlow * chargeSlow * holdSlow;
  const m = Math.hypot(ax,ay) || 1;
  const tx = (ax/m)*spd*(Math.hypot(ax,ay) > .01 ? 1 : 0);
  const ty = (ay/m)*spd*(Math.hypot(ax,ay) > .01 ? 1 : 0);
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
    x, y, vx: Math.cos(a)*400, vy: Math.sin(a)*400,
    weight: 9, w0: 9, dmg: 42 * dmgMul(w), r: 17,
    color: byId.beam.color, kind: "orb", owner: w, life: 2.4, trail: [], spin: 0,
    seek: null, glow: 44, lvl: 1, orb: true
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
  const dx = Math.cos(w.facing), dy = Math.sin(w.facing);
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
    puff(w.x + Math.cos(w.facing)*22, w.y + Math.sin(w.facing)*22, "#6b6188", 10);
  }
}
function dmgMul(w){ return w && w.D && w.D.dmg ? w.D.dmg : 1; }
function beamPower(w){
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
    const d = Math.hypot(toX,toY) || 1;
    const sp = Math.hypot(s.vx,s.vy) || 1;
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
    const dd = Math.hypot(toX,toY)||1;
    const sp = Math.hypot(d.vx,d.vy)||1;
    if ((d.vx*toX + d.vy*toY)/(sp*dd) > .85 && dd/sp < 1.3){ weight += 3; soonest = Math.min(soonest, dd/sp); }
  }
  return { weight, light, soonest };
}
function lineClear(a, b, forShots){
  for (const d of debris){
    if (d.owner) continue;
    if (forShots ? !d.stopsShot : !d.stopsBeam) continue;
    if (segCircle(a.x,a.y,b.x,b.y,d.x,d.y,d.r+2)) return false;
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
    const L = Math.hypot(ax,ay) || 1;
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
    const d = Math.hypot(toX,toY) || 1;
    const sp = Math.hypot(s.vx,s.vy) || 1;
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
    const dx = bx - w.x, dy = by - w.y, L = Math.hypot(dx,dy) || 1;
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
  const d = Math.hypot(w.x - bx, w.y - by);

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
  }

  // ---- offense
  const calm = threat.weight === 0 || threat.soonest > 0.5;
  if (w.think <= 0 && w.castLock <= 0 && w.charge === null && !w.beamOn && calm){
    w.think = rnd(.3,.85) / (0.35 + D.greed*0.9);
    if (losShoot && w.mana > 18){
      const roll = rand();
      if (w.held && rand() < .5) throwHeld(w);
      else if (roll < .10 && w.mana > 60 && los && w.beamCool <= 0 && (D.power|0) >= 2) { w.beamOn = true; }
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
    const moved = Math.hypot(w.x - (w.lastPX == null ? w.x : w.lastPX),
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
    if (Math.hypot(tx - w.x, ty - w.y) < 60) return [tx - w.x, ty - w.y];
    const wp = navNext(w.x, w.y, tx, ty);
    return wp ? [wp.x - w.x, wp.y - w.y] : [tx - w.x, ty - w.y];
  };
  if (w.panic > 0 && w.goal){
    [ax, ay] = routeTo(w.goal.x, w.goal.y);
    if (Math.hypot(w.goal.x - w.x, w.goal.y - w.y) < 26) { w.panic = 0; w.goal = null; }
  } else if (w.goal && !losShoot){
    [ax, ay] = routeTo(w.goal.x, w.goal.y);
    if (Math.hypot(w.goal.x - w.x, w.goal.y - w.y) < 30) w.goal = null;
  } else if (!seen && w.seenX != null && Math.hypot(w.x - bx, w.y - by) > 90){
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
  return Math.cos(angDiff(Math.atan2(sy - w.y, sx - w.x), w.facing)) > WARD_COS;
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
  if (power >= 3 && !REDUCED){
    hitStop = Math.max(hitStop, .035 + power*.007);
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
    bits.push({ x:w.x, y:w.y, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp, life:vrnd(.3,.6), t:0, color:SURGE_COLOR, r:vrnd(1,2.4) });
  }
}
function puff(x,y,color,n){
  if (REDUCED) n = Math.min(n, 4);
  for (let i = 0; i < n; i++){
    const a = vrand()*TAU, s = vrnd(30,220);
    bits.push({ x, y, vx: Math.cos(a)*s, vy: Math.sin(a)*s, life: vrnd(.2,.6), t:0, color, r: vrnd(1,3) });
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
      aiTick(w, w.target, dt);
    }
  }

  for (const w of wizards){
    // the wand tracks what the wizard can see. Lose sight and it holds on the
    // last place they were, rather than following them through the wall.
    if (w.target){
      if (perceives(w, w.target)){
        w.seenX = w.target.x; w.seenY = w.target.y; w.seenT = 0;
        w.facing = Math.atan2(w.target.y - w.y, w.target.x - w.x);
      } else if (w.seenX != null){
        w.facing = Math.atan2(w.seenY - w.y, w.seenX - w.x);
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
      bits.push({ x: w.x + Math.cos(a)*rr, y: w.y + Math.sin(a)*rr,
                  vx: Math.cos(a)*vrnd(4,18), vy: Math.sin(a)*vrnd(4,18) - 22,
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
        w.mana -= byId.beam.cost * dt;
        if (w.mana <= 0){ w.mana = 0; stopBeam(w); }
      } else {
        w.mana -= 10*dt;
      }
    } else { w.beamT = 0; }
    const firing = w.beamOn && w.beamWind >= byId.beam.cast;
    if (firing !== w.beamSounding){
      beamSound(w, firing);
      w.beamSounding = firing;
      if (firing) swish(w, byId.beam.color, "cast");
    }
    const winding = w.beamOn && w.beamWind < byId.beam.cast;
    if (winding !== w.beamCharging){
      chargeSound(w, winding);
      w.beamCharging = winding;
    }
    if (winding && !REDUCED){
      // red motes drawn in out of the dark towards the wand
      const k = w.beamWind / byId.beam.cast;
      const tx = w.x + Math.cos(w.facing)*24, ty = w.y + Math.sin(w.facing)*24;
      const n = 1 + (vrand()*3|0);
      for (let i = 0; i < n; i++){
        const ang = vrnd(0, TAU), rad = vrnd(18, 54) * (1.15 - k*0.55);
        const px = tx + Math.cos(ang)*rad, py = ty + Math.sin(ang)*rad;
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
      const tx = w.x + Math.cos(w.facing)*54, ty = w.y + Math.sin(w.facing)*54;
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
      if (Math.cos(a.facing)*(b.x-a.x) + Math.sin(a.facing)*(b.y-a.y) <= 0) continue;
      if (Math.cos(b.facing)*(a.x-b.x) + Math.sin(b.facing)*(a.y-b.y) <= 0) continue;

      const prev = wasClashing.find(c => (c.a === a && c.b === b) || (c.a === b && c.b === a));
      let t = prev ? (prev.a === a ? prev.t : 1 - prev.t) : 0.5;
      const pA = beamPower(a), pB = beamPower(b);
      const target = pA / (pA + pB);
      const even = Math.abs(target - 0.5) < 0.045;
      // the orb slides, it never snaps: whoever has the mana walks it forward
      const rate = 0.5 * dt;
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
        a.vx -= Math.cos(a.facing)*90*dt; a.vy -= Math.sin(a.facing)*90*dt;
        if (!REDUCED) puff(cx, cy, "#fff", 2);
      } else if (t > 1 - touch){
        hurt(b, 62*dt*dmgMul(a), a);
        b.vx -= Math.cos(b.facing)*90*dt; b.vy -= Math.sin(b.facing)*90*dt;
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
          const ang = Math.atan2(b.y-a.y, b.x-a.x) + Math.PI/2 * (vrand()<.5?1:-1) + vrnd(-.8,.8);
          const sp = vrnd(120,340);
          bits.push({ x:cx, y:cy, vx:Math.cos(ang)*sp, vy:Math.sin(ang)*sp, life:vrnd(.15,.45), t:0,
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
    const ex = w.x + Math.cos(w.facing)*w.beamLen, ey = w.y + Math.sin(w.facing)*w.beamLen;
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
    const ex = w.x + Math.cos(w.facing)*w.beamLen, ey = w.y + Math.sin(w.facing)*w.beamLen;
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
      const dd = Math.hypot(mark.x - s.x, mark.y - s.y);
      const prox = clamp(1 - dd/560, 0, 1);
      const want = s.seek.vMin + (s.seek.vMax - s.seek.vMin) * prox * prox;
      s.seek.phase += dt*5.5;
      const desired = Math.atan2(mark.y - s.y, mark.x - s.x) + Math.sin(s.seek.phase)*s.seek.wob*0.4;
      const cur = Math.atan2(s.vy, s.vx);
      const step = clamp(angDiff(desired, cur), -s.seek.turn*dt, s.seek.turn*dt);
      const na = cur + step;
      s.vx = Math.cos(na)*want; s.vy = Math.sin(na)*want;
      s.spin += dt*(2.5 + prox*9);
      if (!REDUCED && vrand() < prox*0.5*(0.3 + (s.lvl||0)*0.9))
        bits.push({ x:s.x, y:s.y, vx:vrnd(-30,30), vy:vrnd(-30,30), life:vrnd(.2,.45), t:0, color:byId.hex.color, r:vrnd(1,2.4) });
      }
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
      if (dist2(s,d) < (d.r + s.r)**2){
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
      if (dist2(s,o) < (s.r + o.r)**2){
        const cx = (s.x+o.x)/2, cy = (s.y+o.y)/2;
        let near = null, nd = Infinity;
        for (const q of wizards){
          const qd = (cx-q.x)**2 + (cy-q.y)**2;
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
          surge(s.owner, o.weight); surge(o.owner, s.weight);
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
      if (dist2(s,q) < (q.r + s.r)**2){ tgt = q; break; }
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
        if (dist2(d,q) < (d.r + q.r)**2){ tgt = q; break; }
      }
      if (tgt && Math.hypot(d.vx,d.vy) > 80){
        strike(tgt, byId.grasp.dmg * dmgMul(d.thrower), d.x, d.y, "prop", false, d.thrower);
        impact(d.x, d.y, 3.4, byId.grasp.color);
        d.vx = d.vy = 0; d.thrown = 0; d.hp -= 2;
        if (d.hp <= 0) { breakProp(d); continue; }
      }
      for (const o of debris){
        if (o === d || o.gone || o.owner || o.thrown > 0 || !o.solid) continue;
        if (dist2(d,o) < (d.r+o.r)**2){
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
  for (const d of debris) drawDebris(d);
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

  // vignette
  const vg = ctx.createRadialGradient(W/2,H/2,H*0.32,W/2,H/2,H*0.92);
  vg.addColorStop(0,"rgba(0,0,0,0)");
  vg.addColorStop(1,"rgba(0,0,0,.72)");
  ctx.fillStyle = vg; ctx.fillRect(0,0,W,H);
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
      const dd = Math.hypot(dx, dy);
      if (dd <= d.r + 2 || dd - d.r > fr) continue;   // standing in it, or past the light
      // the two tangent rays from the eye graze the prop; everything beyond them is dark
      const a = Math.atan2(dy, dx);
      const sp = Math.asin(Math.min(1, d.r / dd));
      const L = Math.sqrt(Math.max(1, dd*dd - d.r*d.r));
      const a1 = a - sp, a2 = a + sp;
      g.beginPath();
      g.moveTo(you.x + Math.cos(a1)*L,   you.y + Math.sin(a1)*L);
      g.lineTo(you.x + Math.cos(a1)*FAR, you.y + Math.sin(a1)*FAR);
      g.lineTo(you.x + Math.cos(a2)*FAR, you.y + Math.sin(a2)*FAR);
      g.lineTo(you.x + Math.cos(a2)*L,   you.y + Math.sin(a2)*L);
      g.closePath(); g.fill();
    }
    ctx.drawImage(fogCv, 0, 0);
    // a faint visible boundary so the edge of the world reads as fog, not void
    ctx.strokeStyle = "rgba(160,150,220,0.10)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(you.x, you.y, fr*0.98, 0, TAU); ctx.stroke();
  }

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
        const rr = d.r * (0.82 + 0.22*Math.sin(d.seed + i*2.1));
        ctx[i?"lineTo":"moveTo"](Math.cos(ang)*rr, Math.sin(ang)*rr);
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
        ctx.moveTo(Math.cos(ang)*d.r*.6, Math.sin(ang)*d.r*.6);
        ctx.lineTo(Math.cos(ang)*d.r, Math.sin(ang)*d.r);
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
        ctx.beginPath(); ctx.arc(Math.cos(ang)*d.r*.6, Math.sin(ang)*d.r*.6, 1.6, 0, TAU); ctx.fill();
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
      ctx.moveTo(Math.cos(ang)*d.r*.15, Math.sin(ang)*d.r*.15);
      ctx.lineTo(Math.cos(ang+.4)*d.r*.6, Math.sin(ang+.4)*d.r*.6);
      ctx.lineTo(Math.cos(ang)*d.r*.9, Math.sin(ang)*d.r*.9);
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
  ctx.shadowColor = s.color; ctx.shadowBlur = s.glow || 22;
  ctx.fillStyle = s.color;
  ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.shadowBlur = 8;
  ctx.beginPath(); ctx.arc(s.x, s.y, s.r*0.42, 0, TAU); ctx.fill();
  if (s.seek && s.kind === "hex" && s.lvl > .4){
    ctx.translate(s.x, s.y);
    ctx.rotate(s.spin);
    ctx.strokeStyle = s.color; ctx.lineWidth = 1 + s.lvl; ctx.globalAlpha = .35 + s.lvl*.55;
    ctx.beginPath();
    for (let i = 0; i < 6; i++){
      const ang = i/6*TAU, rr = s.r*1.5;
      ctx[i?"lineTo":"moveTo"](Math.cos(ang)*rr, Math.sin(ang)*rr);
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
      ctx.moveTo(s.x + Math.cos(a)*(s.r+4), s.y + Math.sin(a)*(s.r+4));
      ctx.lineTo(s.x + Math.cos(a)*(s.r+9), s.y + Math.sin(a)*(s.r+9));
      ctx.stroke();
    }
    ctx.restore();
  }
}

function jag(x1,y1,x2,y2,segs,amp){
  const pts = [];
  const dx = x2-x1, dy = y2-y1, L = Math.hypot(dx,dy) || 1;
  const nx = -dy/L, ny = dx/L;
  for (let i = 0; i <= segs; i++){
    const t = i/segs;
    const taper = Math.sin(t*Math.PI);
    const off = (vrand()*2-1) * amp * taper;
    pts.push(x1 + dx*t + nx*off, y1 + dy*t + ny*off);
  }
  return pts;
}
function strokeJag(pts, color, width, alpha){
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i+1]);
  ctx.stroke();
  ctx.globalAlpha = 1;
}
function drawBeam(w){
  const winding = w.beamWind < byId.beam.cast;
  const a = w.facing;
  const len = winding ? 90 : w.beamLen;
  const ex = w.x + Math.cos(a)*len, ey = w.y + Math.sin(a)*len;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  if (winding){
    const k = w.beamWind/byId.beam.cast;
    ctx.strokeStyle = byId.beam.color;
    ctx.globalAlpha = .35 + k*.5;
    ctx.lineWidth = 1 + k*2;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(w.x + Math.cos(a)*20, w.y + Math.sin(a)*20);
    ctx.lineTo(w.x + Math.cos(a)*(20 + 600*k), w.y + Math.sin(a)*(20 + 600*k));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowColor = byId.beam.color; ctx.shadowBlur = 20*k;
    ctx.fillStyle = byId.beam.color;
    ctx.beginPath(); ctx.arc(w.x + Math.cos(a)*22, w.y + Math.sin(a)*22, 3 + k*7, 0, TAU); ctx.fill();
    const tx = w.x + Math.cos(a)*24, ty = w.y + Math.sin(a)*24;
    if (!REDUCED){
      const now = performance.now();
      const dots = 8;
      for (let i = 0; i < dots; i++){
        const ang = now/280 * (w.friendly ? 1 : -1) + i/dots*TAU;
        const rad = 8 + 42*(1-k) + Math.sin(now/130 + i)*2.5;
        ctx.globalAlpha = .3 + .65*k;
        ctx.fillStyle = i % 3 ? byId.beam.color : "#ffd6df";
        ctx.shadowColor = byId.beam.color; ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(tx + Math.cos(ang)*rad, ty + Math.sin(ang)*rad, .9 + 2.2*k, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (k > .25) for (let i = 0; i < 2; i++){
        const ang = vrnd(0, TAU), L2 = vrnd(6, 10 + k*22);
        strokeJag(jag(tx, ty, tx + Math.cos(ang)*L2, ty + Math.sin(ang)*L2, 3, 5), "#fff", 1, .55*k);
      }
    }
  } else {
    const now = performance.now();
    const flick = 1 + Math.sin(now/40)*0.12;
    const sx = w.x + Math.cos(a)*18, sy = w.y + Math.sin(a)*18;
    ctx.shadowColor = byId.beam.color; ctx.shadowBlur = 26;
    ctx.strokeStyle = byId.beam.color;
    ctx.globalAlpha = .5;
    ctx.lineWidth = 17*flick;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 6*flick;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();

    // arcing filaments crawling along the shaft
    if (!REDUCED){
      const segs = Math.max(4, Math.min(22, (len/26)|0));
      ctx.shadowBlur = 14;
      strokeJag(jag(sx, sy, ex, ey, segs, 11), "#ffd8e6", 1.6, .85);
      strokeJag(jag(sx, sy, ex, ey, segs, 19), byId.beam.color, 1.2, .55);
      // forks that leap off the shaft
      const forks = 1 + (vrand()*3|0);
      for (let f = 0; f < forks; f++){
        const t = vrand();
        const bx = sx + (ex-sx)*t, by = sy + (ey-sy)*t;
        const ang = a + Math.PI/2*(vrand()<.5?1:-1) + vrnd(-.6,.6);
        const L2 = vrnd(14,46);
        strokeJag(jag(bx, by, bx + Math.cos(ang)*L2, by + Math.sin(ang)*L2, 4, 7), "#fff", 1.1, .5);
      }
      ctx.shadowBlur = 0;
    }
    // muzzle bloom at the wand
    ctx.fillStyle = "#fff"; ctx.shadowColor = byId.beam.color; ctx.shadowBlur = 30;
    ctx.beginPath(); ctx.arc(sx, sy, 5 + Math.sin(now/50)*1.6, 0, TAU); ctx.fill();

    if (w.clash && w.clashOrb){
      const orb = w.clashOrb;
      // the shiver lives here, in the drawing, so the simulated orb stays put
      const j = (orb.jit && !REDUCED) ? orb.jit : 0;
      const ox = orb.x + (j ? vrnd(-j, j) : 0), oy = orb.y + (j ? vrnd(-j, j) : 0);
      const pulse = Math.sin(now/55);
      const r = 15 + pulse*4 + orb.press*7;
      const lead = orb.lead ? orb.lead.tint : "#fff";
      ctx.shadowBlur = 45;
      ctx.fillStyle = byId.beam.color; ctx.globalAlpha = .5;
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
          strokeJag(jag(ex, ey, ex + Math.cos(ang)*L2, ey + Math.sin(ang)*L2, 5, 9),
                    i % 2 ? "#fff" : byId.beam.color, 1.5, .75);
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
   A rank worn on your back. Every wizard trails a short cloak with a row of
   diamonds down its spine: one to begin with, and one more for every cloak
   jewel earned (the same ladder as GEMS in src/account.js), so a wizard who
   has been at it a while is visibly heavier dressed. The cloth is longer at
   higher rank too.

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

const CAPE_NODES = 8;
const CAPE_SEG_MIN = 5.6, CAPE_SEG_MAX = 8.4;   // per-segment length, low rank to high
const CAPE_MAX_MARKS = 13;                      // one plain mark plus twelve jewels

/* How many marks a wizard has earned, and in what colours.

   Only a LEVEL crosses the wire (see currentLevel() in src/net.js) — never the
   colours. Cloak jewels are earned strictly in level order, so every client
   rebuilds the identical row of stones from the shared GEMS table. One small
   integer, carried in the roster that already flows on join, leave and start;
   nothing here rides the per-frame input stream, so no cape can cost anybody a
   frame however many jewels are on it.

   Ranks are per-level, not per-wizard, so this is memoised: six capes at sixty
   frames a second would otherwise rebuild the same twelve-row table 360 times a
   second for nothing. */
const rankCache = new Map();
function rankFor(level){
  const lv = Math.max(1, Math.min(999, Math.floor(Number(level)) || 1));
  let r = rankCache.get(lv);
  if (!r){
    const acct = ACCT();
    const earned = (acct && acct.track) ? acct.track(lv).rows.filter(x => x.earned) : [];
    r = { n: 1 + earned.length, gems: earned.map(x => x.from) };
    rankCache.set(lv, r);
  }
  return r;
}
let myRank = { n: 1, gems: [] };
function refreshMarks(profile){
  rankCache.clear();
  myRank = profile ? rankFor(profile.level) : { n: 1, gems: [] };
}
function capeMarks(w){
  if (w === you) return myRank;                                        // your own profile
  if (w.D) return { n: 1 + Math.max(0, DIFF.indexOf(w.D)), gems: [] }; // a bot wears its tier
  return rankFor(seatLevels && seatLevels[w.seat]);                    // another player, from the roster
}
function capeSeg(marks){
  const k = Math.min(1, (marks - 1) / (CAPE_MAX_MARKS - 1));
  return CAPE_SEG_MIN + (CAPE_SEG_MAX - CAPE_SEG_MIN) * k;
}
function makeCape(w, seg){
  const dx = Math.cos(w.facing), dy = Math.sin(w.facing), n = [];
  for (let i = 0; i < CAPE_NODES; i++){
    const x = w.x - dx * (3 + i * seg), y = w.y - dy * (3 + i * seg);
    n.push({ x, y, px: x, py: y });
  }
  return n;
}
function updateCapes(dt){
  if (!(dt > 0)) return;
  const t = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
  const drag = Math.pow(0.86, dt * 60);        // how much of last frame's motion carries
  const pull = 1 - Math.pow(0.84, dt * 60);    // how hard it is drawn back to rest
  for (const w of wizards){
    const seg = capeSeg(capeMarks(w).n);
    if (!w.cape || w.cape.length !== CAPE_NODES) w.cape = makeCape(w, seg);
    const c = w.cape;
    const dx = Math.cos(w.facing), dy = Math.sin(w.facing);
    // pinned at the shoulders, a little behind centre
    const ax = w.x - dx * 3, ay = w.y - dy * 3;
    c[0].px = c[0].x; c[0].py = c[0].y;
    c[0].x = ax; c[0].y = ay;

    // moving fast lifts the cloth and makes it snap harder
    const speed = Math.min(1, Math.hypot(w.vx || 0, w.vy || 0) / 190);
    const phase = w.seat * 1.7;                // so six wizards do not ripple in step

    for (let i = 1; i < c.length; i++){
      const p = c[i], prev = c[i - 1], k = i / (c.length - 1);
      const vx = (p.x - p.px) * drag, vy = (p.y - p.py) * drag;
      p.px = p.x; p.py = p.y;

      // where it wants to hang: behind, with a wave running down the cloth
      const sway = Math.sin(t * 2.4 - i * 0.62 + phase) * (1.1 + k * 5.2) * (0.55 + speed * 0.75);
      const rx = ax - dx * (i * seg) - dy * sway;
      const ry = ay - dy * (i * seg) + dx * sway;

      p.x += vx + (rx - p.x) * pull;
      p.y += vy + (ry - p.y) * pull;

      // the cloth does not stretch
      let sx = p.x - prev.x, sy = p.y - prev.y;
      const d = Math.hypot(sx, sy) || 1, f = (d - seg) / d;
      p.x -= sx * f; p.y -= sy * f;
    }
  }
}

// Drawn in the wizard's translated (but unrotated) space, so the cloth keeps
// its own world-space shape instead of turning rigidly with the hat.
function drawCape(w){
  const c = w.cape;
  if (!c || c.length < 3) return;
  const { n: marks, gems } = capeMarks(w);
  const hem  = w.friendly ? "#1b2947" : "#331a24";   // deep, at the hem
  const back = w.friendly ? "#415c97" : "#7a4353";   // lit, at the shoulders

  // Spine and edges, in coordinates relative to the wizard. The outline is
  // traced as curves rather than as the raw eight-point polyline — straight
  // segments made it read as a folded paper wedge instead of cloth.
  const P = c.map(p => ({ x: p.x - w.x, y: p.y - w.y }));
  const last = P.length - 1;

  // half-width of the cloth at each node, narrow at the collar and flaring to
  // the hem. A cloak seen from above is WIDER than the wizard wearing it.
  const halfAt = i => {
    const k = i / last;
    return (4.0 + k * 16.5) * (1 - Math.pow(k, 10) * 0.14);
  };
  // unit vector along the spine at a node
  const dirAt = i => {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(last, i + 1)];
    let ux = b.x - a.x, uy = b.y - a.y;
    const d = Math.hypot(ux, uy) || 1;
    return { x: ux / d, y: uy / d };
  };
  // both edges at a given fraction of the full width
  const edges = scale => {
    const L = [], R = [];
    for (let i = 0; i <= last; i++){
      const u = dirAt(i), h = halfAt(i) * scale;
      L.push({ x: P[i].x - u.y * h, y: P[i].y + u.x * h });
      R.push({ x: P[i].x + u.y * h, y: P[i].y - u.x * h });
    }
    const u = dirAt(last), h = halfAt(last) * scale;
    return { L, R, bulge: { x: P[last].x + u.x * h * 1.15, y: P[last].y + u.y * h * 1.15 } };
  };

  // a smooth run through a list of points, midpoint-to-midpoint
  const runThrough = pts => {
    for (let i = 1; i < pts.length - 1; i++){
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  };
  const trace = (scale = 1) => {
    const e = edges(scale);
    ctx.beginPath();
    ctx.moveTo(e.L[0].x, e.L[0].y);
    runThrough(e.L);
    ctx.quadraticCurveTo(e.bulge.x, e.bulge.y, e.R[last].x, e.R[last].y);   // round hem
    const rev = e.R.slice().reverse();
    runThrough(rev);
    ctx.closePath();
  };
  // just the hem, for the braid: up one edge's last stretch, round the bottom,
  // back down the other — an open curve, not the whole silhouette
  const traceHem = scale => {
    const e = edges(scale), from = Math.max(1, last - 3);
    ctx.beginPath();
    ctx.moveTo(e.L[from].x, e.L[from].y);
    runThrough(e.L.slice(from));
    ctx.quadraticCurveTo(e.bulge.x, e.bulge.y, e.R[last].x, e.R[last].y);
    runThrough(e.R.slice(from).reverse());
  };

  ctx.save();
  // the shadow it throws on the floor
  ctx.globalAlpha = .32; ctx.fillStyle = "#04050b";
  ctx.save(); ctx.translate(1.6, 2.6); trace(); ctx.fill(); ctx.restore();
  ctx.globalAlpha = 1;

  // Lit at the shoulders, deep at the hem — a gradient down the spine, not a
  // flat fill. Flat, the cloak sank into the floor at this size.
  const tail = P[last];
  const grad = ctx.createLinearGradient(P[0].x, P[0].y, tail.x, tail.y);
  grad.addColorStop(0, back);
  grad.addColorStop(1, hem);
  trace();
  ctx.fillStyle = grad; ctx.fill();
  ctx.globalAlpha = .75; ctx.strokeStyle = w.tint; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.globalAlpha = 1;

  // two gold braids following the hem
  ctx.strokeStyle = "#e8cfa0"; ctx.lineCap = "round";
  ctx.globalAlpha = .85; ctx.lineWidth = 1.5; traceHem(0.9); ctx.stroke();
  ctx.globalAlpha = .55; ctx.lineWidth = 0.9; traceHem(0.78); ctx.stroke();
  ctx.globalAlpha = 1;

  // The marks down the spine: one plain to begin with, then one per cloak
  // jewel earned, in that jewel's own colour. Past six they go two abreast —
  // thirteen in single file on a fifty-pixel cloak merges into a stripe.
  const n = Math.min(marks, CAPE_MAX_MARKS);
  const perRow = n > 6 ? 2 : 1;
  const rows = Math.ceil(n / perRow);
  for (let m = 0; m < n; m++){
    const row = (m / perRow) | 0, col = m % perRow;
    const alone = (row === rows - 1) && (n - row * perRow) === 1;
    const f = rows === 1 ? 0.46 : 0.24 + (row / (rows - 1)) * 0.64;
    const at = f * (P.length - 1);
    const i0 = Math.min(P.length - 2, at | 0), fr = at - i0;
    const a = P[i0], b = P[i0 + 1];
    let ux = b.x - a.x, uy = b.y - a.y;
    const d = Math.hypot(ux, uy) || 1; ux /= d; uy /= d;
    // across the cloth, spread scaled to how wide it is at this point
    const spread = (perRow === 1 || alone) ? 0 : (col === 0 ? -1 : 1) * (2.6 + f * 3.6);
    const x = a.x + (b.x - a.x) * fr - uy * spread;
    const y = a.y + (b.y - a.y) * fr + ux * spread;
    const size = 2.4 + f * 1.9;
    const paint = m === 0 ? "#eef2ff" : (gems[m - 1] || "#eef2ff");
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(uy, ux));
    ctx.beginPath();
    ctx.moveTo(size, 0); ctx.lineTo(0, size); ctx.lineTo(-size, 0); ctx.lineTo(0, -size);
    ctx.closePath();
    ctx.fillStyle = paint; ctx.globalAlpha = .95;
    ctx.shadowColor = paint; ctx.shadowBlur = 6;
    ctx.fill();
    ctx.globalAlpha = .8; ctx.shadowBlur = 0;
    ctx.strokeStyle = "#0a0d18"; ctx.lineWidth = .7; ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function drawWizard(w){
  const a = w.facing;
  const tint = w.tint;
  const robe = w.friendly ? "#1b2b40" : "#3a1f2a";
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
    const puls = 22 + Math.sin(performance.now()/140)*1.6 + k*3;
    ctx.beginPath(); ctx.arc(0, 0, puls, 0, TAU); ctx.stroke();
    ctx.globalAlpha = (.12 + k*.22);
    ctx.beginPath(); ctx.arc(0, 0, puls*1.35, 0, TAU); ctx.stroke();
    ctx.restore();
  }

  // ward
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
    ctx.beginPath(); ctx.arc(0, 0, WARD_R, -half, half); ctx.stroke();
    ctx.globalAlpha = .18;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, WARD_R - 6, -half, half); ctx.stroke();
    // motes running the length of the wall, thinning out as it is spent
    const motes = 5 + Math.round(k*5);
    const spin = performance.now()/1100;
    ctx.shadowBlur = 14;
    for (let i = 0; i < motes; i++){
      const f = ((i/motes) + spin) % 1;
      const ang = -half + f*half*2;
      const rr = (WARD_R - 3) + Math.sin(spin*7 + i*1.7)*3.5;
      ctx.globalAlpha = (.35 + k*.6) * Math.sin(f*Math.PI);
      ctx.fillStyle = i % 4 ? byId.ward.color : "#dcffec";
      ctx.beginPath();
      ctx.arc(Math.cos(ang)*rr, Math.sin(ang)*rr, 1.3 + k*1.7, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.rotate(a);
  const flashK = clamp(w.hurt, 0, 1);
  // Straight down on a wizard you see a hat: a dark brim lying flat, and the
  // cone on top of it catching the light. Tone does the work at thirty pixels —
  // the cone has to be LIGHTER than the brim and cast a shadow onto it, or it
  // stops reading as something raised and turns into a wedge cut out of a disc.
  const brim = w.friendly ? "#1b2739" : "#331a23";
  const cone = w.friendly ? "#3f5f88" : "#8a4257";
  const lit  = w.friendly ? "#5b81ad" : "#b06176";
  // shadow on the floor
  ctx.fillStyle = "rgba(0,0,0,.45)";
  ctx.beginPath(); ctx.ellipse(1, 3, 16, 15, 0, 0, TAU); ctx.fill();

  // shoulders, leading the way — the brim sits back over them
  ctx.beginPath();
  ctx.ellipse(5.5, 0, 10.5, 13, 0, 0, TAU);
  ctx.fillStyle = robe; ctx.fill();
  ctx.globalAlpha = .45; ctx.strokeStyle = tint; ctx.lineWidth = 1.3; ctx.stroke();
  ctx.globalAlpha = 1;

  // the brim, flat on the floor
  ctx.shadowColor = tint; ctx.shadowBlur = w.hurt > 0 ? 24 : 9;
  ctx.beginPath(); ctx.arc(0, 0, 15, 0, TAU);
  ctx.fillStyle = brim; ctx.fill();
  ctx.strokeStyle = tint; ctx.lineWidth = 2; ctx.stroke();
  ctx.shadowBlur = 0;
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
  const sw = w.swish > 0 ? Math.sin((1 - w.swish/w.swishT0) * Math.PI) : 0;
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
    ctx.shadowColor = s.color; ctx.shadowBlur = 10 + k*30;
    ctx.fillStyle = s.color;
    ctx.beginPath(); ctx.arc(29, 4, 3 + k*9, 0, TAU); ctx.fill();
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
    el("roundLabel").textContent =
      `${Math.round(runScore).toLocaleString()} pts · Wave ${Math.max(1, waveNo)} · ${alive} ${alive === 1 ? "rival" : "rivals"}`;
  } else {
    el("roundLabel").textContent = matchCfg.mode === "lives"
      ? `Lives · ${matchCfg.lives} each`
      : `Round ${roundNo} · first to ${matchCfg.roundsToWin}`;
  }
}

/* ---------------------------------------------------------- music */
const bgm = el("bgm"), lobbyBgm = el("lobbyBgm"), bgmBtn = el("bgmBtn");
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
  if (on) playSfx(a, w.friendly ? 0.6 : 0.45); else stopSfx(a);
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
  fromPool(pool, id, w.friendly ? 0.55 : 0.4, pool.length < 3);
}
function hitSound(w, amount){
  const big = amount >= 14;
  fromPool(big ? hitSfx.big : hitSfx.small, big ? "hitB" : "hitS",
           (big ? 0.7 : 0.5) * (w.friendly ? 1 : 0.85), true);
}
function dashSound(w){
  if (dashS) { try { dashS.playbackRate = 1 + vrnd(-.06,.06); } catch (e) {} }
  playSfx(dashS, w.friendly ? 0.5 : 0.34);
}
let muted = false;
if (bgm) bgm.volume = 0;          // both tracks start silent; the crossfade raises one
if (lobbyBgm) lobbyBgm.volume = 0;
function beamSound(w, on){
  const a = w.friendly ? beamSfx.you : beamSfx.foe;
  if (!a) return;
  if (on){
    if (muted) return;
    a.volume = w.friendly ? 0.6 : 0.42;
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
}
/* Two tracks, one at a time: the lobby waits on the menu, the battle theme takes
 * over the moment a match starts, and each hands over by fading rather than
 * cutting. Both elements loop from the first interaction onward and it is only
 * their volume that moves — restarting an <audio> mid-fade clicks, and browsers
 * will not begin playback at all until the page has been touched.
 */
const MUSIC_VOL = { lobby: 0.38, battle: 0.42 };
const FADE_MS = 900;
let musicTrack = "lobby";        // which one should be audible right now
let musicStarted = false;        // have we been allowed to play at all yet?
let fadeTimer = 0;
function trackEl(which){ return which === "lobby" ? lobbyBgm : bgm; }
function fadeMusic(){
  if (typeof clearInterval === "function" && fadeTimer) clearInterval(fadeTimer);
  if (typeof setInterval !== "function") return;
  const stepMs = 50, step = stepMs / FADE_MS;
  fadeTimer = setInterval(() => {
    let settled = true;
    for (const which of ["lobby", "battle"]){
      const a = trackEl(which);
      if (!a) continue;
      const want = (muted || !musicStarted || which !== musicTrack) ? 0 : MUSIC_VOL[which];
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
    if (bgm) bgm.volume = 0;
    if (lobbyBgm) lobbyBgm.volume = 0;
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
let matchCfg = { roundsToWin: 2, mode: "rounds", lives: 3, mapSize: "medium", fog: 0, mapPreset: "random" };
// Offline play (solo duel, escalation, or a local fallback match) always gets
// the fresh default world. Multiplayer opts are set by startMatch from the
// relay's start message and must NOT be carried into solo — solo has no map
// selector, so a preset left over from a hosted game would otherwise replace
// the random-scatter arena forever.
function resetOfflineCfg(){
  matchCfg = { roundsToWin: 2, mode: "rounds", lives: 3, mapSize: "medium", fog: 0, mapPreset: "random" };
}
function sanitizeMatchCfg(o){
  o = o || {};
  return {
    roundsToWin: Math.min(9, Math.max(1, o.roundsToWin | 0 || 2)),
    mode: o.mode === "lives" ? "lives" : "rounds",
    lives: Math.min(9, Math.max(1, o.lives | 0 || 3)),
    mapSize: ["small","medium","large"].includes(o.mapSize) ? o.mapSize : "medium",
    fog: o.fog ? 1 : 0,
    mapPreset: ["random","arena","gauntlet","crossfire"].includes(o.mapPreset) ? o.mapPreset : "random"
  };
}
// The host panel UI state (what the host is choosing in the lobby).
let hostRounds = 2, hostMode = "rounds", hostLives = 3,
    hostMapSize = "medium", hostFog = 0, hostMapPreset = "random";

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
             ["lattice",.50,.50],["chair",.33,.33],["stool",.67,.67],["urn",.50,.28]]
};

// Fog of war: how far a wizard can see, scaled a little with the arena.
const FOG_R = 250;

function spawnRing(n){
  const pts = [];
  const s = mapScale();
  const rx = W*0.36*s, ry = H*0.33*s;
  for (let i = 0; i < n; i++){
    const a = Math.PI + (i/n)*TAU;
    pts.push({ x: W/2 + Math.cos(a)*rx, y: H/2 + Math.sin(a)*ry });
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
    seats = [{ human:true, name: playerName, tint: TINTS[0], D: null, wins: 0 }];
  } else {
    seats = [
      { human:true, name: playerName, tint: TINTS[0], D: null, wins: 0 },
      { human:false, name: DIFF[difficulty].name, tint: TINTS[2], D: DIFF[difficulty], wins: 0 }
    ];
  }
}
function buildRoster(){
  if (!seats.length) makeSeats();
  const n = mode === "escalation" ? 2 : seats.length;
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
    // duel and escalation are player-versus-everyone; a match room is a free-for-all
    w.team = mode === "match" ? i : (seat.human ? 0 : 1);
    if (seat.human) w.pad = (i === localSeat) ? PAD1 : PAD2;
    wizards.push(w);
    if (seat.human && i === 1) p2 = w;
  });
  you = wizards[localSeat] || wizards[0];
  you.human = true;
  if (mode === "escalation"){ waveNo = 0; waveLive = false; waveGap = 1.1; }
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
  let x = W/2, y = H/2, guard = 0;
  while (guard++ < 300){
    x = rnd(50, W-50); y = rnd(50, H-50);
    if (dist({x,y}, you) < 300) continue;
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
  e.target = you;
  wizards.push(e);
  rings.push({ x, y, r:6, max:80, t:0, life:.55, color:e.tint, width:2.6 });
  puff(x, y, e.tint, 26);
  return e;
}
function escTick(dt){
  survT += dt;
  runScore += dt * 5;
  if (wizards.some(w => w.dead && !w.human))
    wizards = wizards.filter(w => w.human || !w.dead);
  if (livingOf(1).length > 0) return;      // the set is still on its feet

  if (waveLive){                            // it just went down
    waveLive = false;
    waveGap = 2.4;
    runScore += 200 * waveNo;
    msg = { text: "Wave " + waveNo + " cleared", sub: "+" + (200*waveNo) + " points", t: 1.6, color: "#5dffab" };
  }
  waveGap -= dt;
  if (waveGap > 0) return;

  waveNo++;
  const comp = waveComp(waveNo - 1);
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
    if (w.human){ escGameOver(); return; }
    kills++;
    if (w.lastBy && w.lastBy !== w) w.lastBy.kills++;
    runScore += 100 * ((w.tier || 0) + 1);
    you.hp = Math.min(you.hpMax, you.hp + 10 + (w.tier || 0)*4);
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
  const pts = spawnRing(Math.max(2, mode === "escalation" ? 2 : seats.length));
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
const HS_KEY = "rpw.escalation.scores";
function loadScores(){
  try { const v = JSON.parse(localStorage.getItem(HS_KEY)); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
function saveScore(entry){
  try {
    const list = loadScores();
    list.push(entry);
    list.sort((a,b) => b.s - a.s);
    localStorage.setItem(HS_KEY, JSON.stringify(list.slice(0, 8)));
  } catch (e) {}
}
function esc(str){
  return String(str).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function renderBoard(fresh){
  const box = el("board");
  const list = loadScores();
  if (!list.length){
    box.innerHTML = '<h4>Escalation records</h4><div class="none">No runs recorded yet.</div>';
  } else {
    // Eight are kept, six are shown: the end screen has to fit the arena without
    // scrolling, and the bottom two entries are the least interesting rows on it.
    box.innerHTML = '<h4>Escalation records</h4><ol>' + list.slice(0, 6).map((r, i) => {
      const isNew = fresh && r.s === fresh.s && r.d === fresh.d;
      return '<li class="' + (isNew ? "fresh" : "") + '"><span>' + (i+1) + '</span>' +
             '<span>' + esc(r.n || "Wizard") + ' · wave ' + r.w + ' · ' + r.k + (r.k === 1 ? " kill" : " kills") + '</span>' +
             '<b>' + r.s.toLocaleString() + '</b></li>';
    }).join("") + '</ol>';
  }
  box.hidden = false;
  scheduleFit();
}
function escGameOver(){
  phase = "over"; phaseT = 1.2;
  const final = Math.round(runScore);
  const entry = { s: final, k: kills, w: Math.max(1, waveNo), d: Date.now(), n: playerName };
  saveScore(entry);
  msg = { text: "Fallen", sub: "Score " + final.toLocaleString(), t: 1.5, color: "#ff4d5e" };
  const banked = bankRun(final, Math.max(1, waveNo), kills);
  setTimeout(() => {
    show("solo");   // first, because it rewrites the copy — then say what happened
    renderStats();
    el("curtainTitle").textContent = playerName + " held out to wave " + Math.max(1, waveNo);
    const report = final.toLocaleString() + " points · " + kills +
      (kills === 1 ? " wizard" : " wizards") + " put down · " + Math.round(survT) + " seconds standing.";
    el("curtainText").textContent = report;
    el("goBtn").textContent = "Run it again";
    renderBoard(entry);
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
    ? { text: "Survive", sub: "They keep coming.", t: 1.4, color: "#ff4d5e" }
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
  roundNo = 1;
  simFrame = 0;   // frame counter restarts once per match, not per round
  runScore = 0; kills = 0; survT = 0; waveNo = 0; waveLive = false; waveGap = 1.1;
  makeSeats();
  newRound();
  el("curtain").hidden = true;
  el("board").hidden = true;
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
      if (networked) el("mpNote").hidden = true;   // not a menu hint on a results screen
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
  selectMode(mode === "escalation" ? 3 : difficulty);
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
function show(which){
  panel = which;
  musicFor("lobby");   // any menu, including the one a finished match drops you on
  scheduleFit();
  for (const k in PANEL) PANEL[k].hidden = (k !== which);
  // the last match's report and round counter are not part of any menu — navigating
  // anywhere clears them, and renderStats() puts the report back after a match ends
  const st = el("stats"); if (st) st.hidden = true;
  const rl = el("roundLabel");
  if (rl) rl.hidden = false;     // it fades instead of hiding, so its space stays reserved
  if (which === "solo"){ const w = el("whoami"); if (w) w.hidden = false; modeCopy(); return; }
  el("board").hidden = true;
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
  if (mode === "escalation"){
    el("goBtn").textContent = "Begin the run";
    el("curtainTitle").textContent = "Escalation";
    el("curtainText").textContent = "One Apprentice, then an Adept, then an Archmage — then pairs, then threes, each set harder than the last. Clear the set before the next arrives. You do not get a second round.";
    renderBoard(null);
  } else {
    el("goBtn").textContent = "Begin the duel";
    el("curtainTitle").textContent = "Choose your rival";
    el("curtainText").textContent = "Your wand tracks its target on its own — Tab switches targets. Read what is coming and answer it with something heavy enough to stop it.";
    el("board").hidden = true;
  }
}
function selectMode(v){
  if (v === 3) mode = "escalation";
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
const paintPreset = segRow(el("segPreset"), ["random","arena","gauntlet","crossfire"], () => hostMapPreset, v => { hostMapPreset = v; },
                           v => v === "random" ? "Random" : v[0].toUpperCase() + v.slice(1));
function paintModeRows(){
  const lives = hostMode === "lives";
  el("rowRounds").hidden = lives;
  el("rowLives").hidden = !lives;
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
    mapPreset: hostMapPreset
  };
}
function afterSeg(){
  hostNote();
  // the lobby only obeys the host, and only before the match starts
  if (panel === "host" && inRoom()) window.RPWNet.config({ total: roomTotal, difficulty: botLevel, opts: hostOpts() });
}
function hostNote(){
  const taken = inRoom() ? window.RPWNet.net.players.length : 1;
  const bots = Math.max(0, roomTotal - taken);
  const note = el("hostNote");
  note.classList.remove("bad");
  note.textContent = "Send the code to your friends. " +
    (bots === 0 ? "Every seat is taken — start when you are ready."
                : bots + (bots === 1 ? " seat is" : " seats are") + " still empty; starting now fills " +
                  (bots === 1 ? "it" : "them") + " with " + DIFF[botLevel].name + " bots.");
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
function renderRoster(box){
  box.innerHTML = "";
  if (!inRoom()) return;
  const n = window.RPWNet.net;
  for (let i = 0; i < roomTotal; i++){
    const p = (n.players || []).find(x => x.seat === i);
    const row = mk("div", p ? (i === n.seat ? "me" : null) : "empty", box);
    const who = mk("span", null, row);
    who.textContent = p ? (p.name + (p.host ? " (host)" : "")) : "empty — a bot takes this seat";
    // rank, so you can see who you are up against before the wands come out
    if (p && p.lv > 1){
      const lv = mk("em", "lv", row);
      lv.textContent = "Lv " + p.lv;
    }
    const tag = mk("i", p && p.ready ? "on" : null, row);
    tag.textContent = p ? (p.ready ? "ready" : "waiting") : "";
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
const MP_NOTE = "Host a duel to get an invite code, or paste a friend\u2019s code to join theirs.";
el("mpBtn").addEventListener("click", () => {
  show("mp");
  const note = el("mpNote");
  note.hidden = false;              // a results screen hides it; the menu wants it back
  note.classList.toggle("bad", !hasNet());
  note.textContent = hasNet() ? MP_NOTE
    : "No match server is configured yet, so hosting and joining will not connect. Solo play works as normal.";
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
  if (mode === "escalation") selectMode(difficulty);
  difficulty = botLevel;
  if (inRoom()){ window.RPWNet.start(); return; }   // the server hands everyone the same seed
  mode = "match";
  roomHumans = 1;
  resetOfflineCfg();
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
    li.style.setProperty("--g2", r.to);

    const lv = document.createElement("span");
    lv.className = "lv"; lv.textContent = "Lv " + r.at;
    const jewel = document.createElement("span");
    jewel.className = "jewel";
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

let authMode = "in";                // "in" to sign in, "up" to create
let authFrom = "home";              // where Back and a finished sign-in return to

function authNote(text, kind){
  const n = el("authNote");
  if (!n) return;
  n.textContent = text;
  n.className = "note" + (kind ? " " + kind : "");
}
function setAuthMode(m){
  authMode = m;
  const up = m === "up";
  el("authTitle").textContent = up ? "Create a wizard" : "Sign in";
  el("authGo").textContent = up ? "Create wizard" : "Sign in";
  el("authSwap").textContent = up ? "Already have a wizard? Sign in" : "New here? Create a wizard";
  el("authPass").setAttribute("autocomplete", up ? "new-password" : "current-password");
  authNote(up ? "Three characters or more, and a password of at least eight."
              : "Your wizard keeps its level and experience wherever you sign in.");
}
function openAuth(){
  authFrom = (panel === "auth") ? authFrom : panel;
  setAuthMode("in");
  el("authPass").value = "";
  show("auth");
}
async function authSubmit(){
  const acct = ACCT();
  if (!acct) return;
  const name = (el("authName").value || "").trim();
  const pass = el("authPass").value || "";
  el("authGo").disabled = true;
  authNote(authMode === "up" ? "Creating your wizard\u2026" : "Signing you in\u2026");
  const res = authMode === "up" ? await acct.register(name, pass) : await acct.signIn(name, pass);
  el("authGo").disabled = false;
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
el("authSwap").addEventListener("click", () => setAuthMode(authMode === "up" ? "in" : "up"));
el("authForm").addEventListener("submit", e => { e.preventDefault(); authSubmit(); });

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
function pump(now){
  const bg = hiddenTab();
  // background timers are clamped to about a second, so a hidden tab wakes up
  // owing a lot of frames; let it pay them off in one go rather than fall behind
  const real = Math.min((now - last)/1000, bg ? 2 : .25);
  last = now;
  acc += real;
  let steps = 0;
  const cap = bg ? 300 : 5;
  while (acc >= STEP && steps < cap){
    if (NET.active && !NET.ready(simFrame)) break;   // stalled waiting on a peer
    acc -= STEP;
    simStep();
    steps++;
  }
  if (steps >= cap) acc = 0;
  if (!bg){ updateCapes(real); draw(); syncHUD(); }
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
makeMap();
resetWizards();
msg = null;
requestAnimationFrame(frame);

// handed to src/net.js so the network layer can drive a match without
// reaching into the simulation's internals
window.RPW = {
  NET, BIT, STEP,
  seedRng,
  localMask: () => localMask(you),
  // net.js calls this whenever a match starts or ends, so the hidden-tab pump
  // starts and stops with the match and not only on a visibility change
  pumpSync: () => syncPumpToVisibility(),
  // net.js calls this when a match cannot continue. Saying plainly what happened
  // beats leaving somebody standing in an arena that has stopped agreeing with
  // everyone else's.
  endMatch(reason){
    phase = "menu"; msg = null;
    hushBeams();
    el("pausePanel").hidden = true;
    el("curtain").hidden = false;
    show("mp");
    el("mpNote").hidden = true;
    if (reason === "dropped"){
      el("curtainTitle").textContent = "You dropped out";
      el("curtainText").textContent = "Your game stopped sending input for long enough that the others carried on without you — your wizard finished the match as a bot. Join again to get back in.";
    } else {
      el("curtainTitle").textContent = "The match fell out of sync";
      el("curtainText").textContent = "Two players stopped agreeing about the state of the arena, so the match was stopped rather than left to drift apart. Host or join again to play on.";
    }
    el("curtainText").hidden = false;
  },
  seatOf: () => you.seat,
  frameNow: () => simFrame,
  startMatch(opts){
    mode = opts.mode || "match";
    difficulty = opts.difficulty != null ? opts.difficulty : difficulty;
    roomTotal = opts.total || roomTotal;
    roomHumans = opts.humans || 1;
    localSeat = opts.seat != null ? opts.seat : 0;
    seatNames = opts.names || null;
    seatLevels = opts.levels || null;
    matchCfg = sanitizeMatchCfg(opts.opts || null);
    if (opts.name) playerName = opts.name;
    newMatch(opts.seed);
  },
  seats: () => seats.map(x => ({ name: x.name, human: x.human })),
  // test hook: the cape's cloth for a seat, as offsets from the wizard, plus
  // how far each node sits off the straight line behind them — which is the
  // only way to assert that it actually sways rather than trailing rigidly
  capeOf(seat){
    const w = wizards.find(x => x.seat === seat);
    if (!w || !w.cape) return null;
    const dx = Math.cos(w.facing), dy = Math.sin(w.facing);
    return {
      marks: capeMarks(w).n,
      nodes: w.cape.map(p => {
        const ox = p.x - w.x, oy = p.y - w.y;
        return { x: ox, y: oy, lateral: ox * -dy + oy * dx };   // + is one side, - the other
      }),
      segs: w.cape.slice(1).map((p, i) => Math.hypot(p.x - w.cape[i].x, p.y - w.cape[i].y))
    };
  },
  // test hook: land a finishing blow on a seat, so a rig can reach the end of
  // a round (and of a match) without playing one out in real time
  smite(seat){
    const w = wizards.find(x => x.seat === seat);
    if (w && w.hp > 0) strike(w, 9999, w.x, w.y, "spark", false);
  },
  matchCfg: () => ({ ...matchCfg }),
  phase: () => phase,
  // a cheap checksum of everything the simulation owns, for determinism tests
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
