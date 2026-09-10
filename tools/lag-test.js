/*
 * Two clients, far apart.
 *
 * Every other networked test in this repo delivers a message the instant it is
 * sent. That is a LAN with the cable removed — and it is why the suite has
 * been green through a bug that makes the game unplayable between Japan and
 * Canada. The relay here holds each message for a configurable one-way trip
 * before handing it over, so an input can arrive AFTER the frame it was meant
 * for, which is the only condition under which most lockstep bugs exist.
 *
 *   node tools/lag-test.js                 # 125ms each way (~250ms round trip)
 *   LAG=125 JITTER=25 node tools/lag-test.js
 *   LAG=0 node tools/lag-test.js           # the old, always-green conditions
 *
 * It reports the first frame the two worlds disagree AND which component went
 * first, using the same hashParts() names the live desync screen uses.
 */
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const gameCode = fs.readFileSync(path.join(__dirname, "..", "src", "game.js"), "utf8");
const netCode  = fs.readFileSync(path.join(__dirname, "..", "src", "net.js"), "utf8");

const LAG    = +(process.env.LAG    ?? 125);   // one-way, ms
const JITTER = +(process.env.JITTER ?? 0);     // +/- ms, ms
const FRAMES = +(process.env.FRAMES ?? 1800);  // 30 sim-seconds
const SEED   = +(process.env.SEED   ?? 1);
/* Frame budget per client, in ms. The interesting case is not two identical
   machines: it is one that holds 60fps and one that does not, because a client
   that owes several simulation steps per animation frame takes a different path
   through pump() than one that owes exactly one. */
const FPS_A  = +(process.env.FPS_A ?? 60);
const FPS_B  = +(process.env.FPS_B ?? 60);
/* Seats in the room. Anything above 2 is filled with bots, which are the
   busiest users of the seeded stream and the only thing that reacts to a
   smashed crate by re-planning a route. */
const TOTAL  = +(process.env.TOTAL ?? 2);
/* MODE=beam makes both players hold the red beam almost continuously. Two beams
   meeting is the clash — the one part of the simulation with state that lives
   BETWEEN frames outside the wizards (the orb's position along the line) and
   the one Green can reproduce on demand. */
const MODE   = process.env.MODE || "spread";
/* The operating system's "reduce motion" setting differs per PLAYER, and this
   game has already shipped one desync that was hiding behind it (hit-stop, which
   scales dt for the whole world, used to be skipped for anyone who had it on).
   So the harness has to be able to disagree about it, or it can never catch the
   next one. */
const REDUCED_A = process.env.REDUCED_A === "1";
const REDUCED_B = process.env.REDUCED_B === "1";
/* ULP_B=1 models the one thing this harness structurally cannot vary: the
   BROWSER. Both clients run in the same V8, so Math.sin returns the same bits
   for both — but the ECMAScript spec does not require sin, cos, atan2, hypot,
   exp, pow or log to be correctly rounded. They are "implementation-
   approximated", and V8, SpiderMonkey and JavaScriptCore genuinely disagree in
   the last bit. (+, -, *, / and sqrt ARE exact, and identical everywhere.)
   So this gives client B a trig function that is off by one unit in the last
   place on a fraction of its inputs — which is precisely what playing on a
   different browser looks like from inside the simulation.
   The value is a DENOMINATOR: ULP_B=4096 means one result in 4096 is off by a
   bit. Real engines disagree far less often than that on ordinary inputs, which
   is exactly why this takes minutes to show up in a real match rather than
   seconds. */
/* SKEW is accepted as an alias because it is the name that ended up in a
   shipped handoff note, and an env var nobody recognises is silently ignored —
   which is how a run that varied NOTHING got read as proof of the cross-browser
   case. SKEW=1 means "on", at the default rarity. */
const ULP_B = +(process.env.ULP_B ?? 0) ||
              (process.env.SKEW ? (+process.env.SKEW > 1 ? +process.env.SKEW : 4096) : 0);
const f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer);
function nextUlp(x){
  if (!Number.isFinite(x) || x === 0) return x;
  f64[0] = x; u64[0] += (x > 0 ? 1n : -1n); return f64[0];
}
function skewMath(rate){
  const M = Object.create(Math);
  // deterministic in the input, so a rerun perturbs exactly the same calls
  const N = BigInt(Math.max(2, rate));
  const bite = v => { f64[0] = v; return (u64[0] % N) === 0n; };
  for (const fn of ["sin", "cos", "atan2", "hypot", "exp", "pow", "log", "tan", "acos", "asin", "atan"]){
    const base = Math[fn];
    M[fn] = (...a) => { const v = base(...a); return bite(v) ? nextUlp(v) : v; };
  }
  return M;
}

/* ---------------------------------------------------- the simulated clock */
let now = 0;                       // ms, the only clock anything in here sees
const wire = [];                   // { at, fn } — messages in transit
let wireRng = SEED * 2654435761 >>> 0;
function wrnd(){ wireRng ^= wireRng << 13; wireRng ^= wireRng >>> 17; wireRng ^= wireRng << 5;
                 return ((wireRng >>> 0) % 1000) / 1000; }
function leg(){ return Math.max(0, LAG + (JITTER ? (wrnd() * 2 - 1) * JITTER : 0)); }
/* A WebSocket runs over TCP, so a connection delivers in the order it was
   written: jitter can bunch messages up or spread them out, but it can NEVER
   let one overtake another on the same link. Modelling that wrongly cost me a
   morning — an unordered link "found" a bug where a late lobby sync clobbered a
   started match, which cannot happen over TCP. Each direction therefore keeps
   its own arrival clock and no message may land before the one in front. */
const lastAt = new Map();
function later(fn, lane){
  const at = Math.max(now + leg(), (lastAt.get(lane) ?? 0) + 0.001);
  lastAt.set(lane, at);
  wire.push({ at, seq: wire.length, fn });
}
function flush(){
  wire.sort((a, b) => a.at - b.at || a.seq - b.seq);
  while (wire.length && wire[0].at <= now) wire.shift().fn();
}

/* simulated timers, so net.js's 2s ping keepalive actually ticks */
const timers = [];
let timerId = 1;
function simSetInterval(fn, ms){ const t = { id: timerId++, fn, ms, next: now + ms, live: true }; timers.push(t); return t.id; }
function simClearInterval(id){ const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); }
function runTimers(){ for (const t of timers) while (t.live && now >= t.next){ t.next += t.ms; t.fn(); } }

/* Date, but on the simulated clock — rtt is measured with Date.now(), so a
   real clock here would measure a link that is instant no matter what LAG says */
const SimDate = new Proxy(Date, { get(t, p){ return p === "now" ? () => now : Reflect.get(t, p); },
                                  construct(t, a){ return new t(...a); } });

/* ------------------------------- the relay ------------------------------- */
function makeRelay(){
  const rooms = new Map();
  let nextId = 1;
  return {
    register(name, sendFn){
      const s = { name, id: nextId++, send: sendFn, room: null, seat: -1, ready: false };
      s.send({ t: "welcome", id: s.id, maxSeats: 6 });
      return s;
    },
    sendTo(s, raw){ const data = typeof raw === "string" ? raw : JSON.stringify(raw); later(() => s.send(data), "down:" + s.id); },
    roster(room){ return room.players.map(p => ({ seat: p.seat, name: p.name, ready: p.ready, host: p.seat === 0 })); },
    sync(room){
      const msg = { t: "room", code: room.code, total: room.total, difficulty: room.difficulty, state: room.state };
      for (const p of room.players) this.sendTo(p, { ...msg, you: p.seat, players: this.roster(room) });
    },
    handle(s, msg){
      switch (msg.t){
        case "hello": s.name = msg.name; return;
        case "create": {
          const room = { code: "ABCD", total: msg.total || 2, difficulty: 0, players: [], state: "lobby", opts: msg.opts || null };
          rooms.set("ABCD", room);
          s.room = "ABCD"; s.seat = 0; s.ready = false; room.players.push(s);
          this.sync(room); return;
        }
        case "join": {
          const room = rooms.get(String(msg.code || "").toUpperCase());
          if (!room) return this.sendTo(s, { t: "error", why: "no room with that code" });
          s.room = room.code; s.seat = room.players.length; s.ready = false; room.players.push(s);
          this.sync(room); return;
        }
        case "ready": {
          if (!s.room) return;
          s.ready = !!msg.v;
          const r = rooms.get(s.room);
          this.sync(r);
          if (r.players.length >= 2 && r.players.every(p => p.ready)) this.start(r);
          return;
        }
        case "start": { const r = s.room ? rooms.get(s.room) : null; if (r && s.seat === 0) this.start(r); return; }
        case "in": {
          const r = s.room ? rooms.get(s.room) : null;
          if (!r || r.state !== "running") return;
          for (const p of r.players) if (p !== s) this.sendTo(p, { t: "in", seat: s.seat, f: msg.f, m: msg.m });
          return;
        }
        case "ping": {
          // the real relay answers immediately and reports the furthest peer
          this.sendTo(s, { t: "pong", s: msg.s, peer: 0 });
          return;
        }
        case "hash": {
          const r = s.room ? rooms.get(s.room) : null;
          if (!r) return;
          (r.hashes ||= new Map());
          const at = r.hashes.get(msg.f) || [];
          at.push({ seat: s.seat, h: msg.h, parts: msg.parts });
          r.hashes.set(msg.f, at);
          return;
        }
        case "alive": case "bye": return;
      }
    },
    start(room){
      room.state = "running";
      room.seed = 424242;
      for (const p of room.players)
        this.sendTo(p, { t: "start", seed: room.seed, total: room.total,
                         difficulty: room.difficulty, opts: room.opts,
                         you: p.seat, players: this.roster(room) });
    }
  };
}

/* --------------------------- DOM / canvas stub --------------------------- */
const gradStub = { addColorStop(){} };
function ctxStub(){
  return new Proxy({}, { get(t, p){
      if (p in t) return t[p];
      if (p === "createRadialGradient" || p === "createLinearGradient") return () => gradStub;
      if (p === "canvas") return { width: 960, height: 620 };
      return () => {};
    }, set(t, p, v){ t[p] = v; return true; } });
}
function fakeEl(id){
  const children = [];
  const el = {
    id, style: { setProperty(){} }, textContent: "", innerHTML: "",
    classList: { toggle(){}, add(){}, remove(){}, contains(){ return false; } },
    dataset: {}, hidden: false, children,
    appendChild(c){ children.push(c); return c; },
    _ls: {},
    addEventListener(t, fn){ (el._ls[t] ||= []).push(fn); },
    dispatch(t, ev){ for (const fn of (el._ls[t] || [])) fn(ev || {}); },
    focus(){}, play(){ return { catch(){} }; }, pause(){}, setAttribute(){},
    volume: 1, currentTime: 0, closest(){ return null; },
    getContext(){ return ctxStub(); }, width: 960, height: 620
  };
  Object.defineProperty(el, "length", { get: () => children.length });
  el[Symbol.iterator] = function*(){ yield* children; };
  return el;
}

/* ------------------------------ one client ------------------------------- */
function makeClient(name, relay, reduced, ulp){
  const els = {}; const listeners = {};
  let frameCb = null;
  function fire(type, key){ for (const fn of listeners[type] || []) fn({ key, preventDefault(){}, target: { tagName: "BODY" } }); }

  class FakeWS {
    constructor(){
      this.readyState = 0;
      const self = this;
      later(() => {
        this.me = relay.register(name, raw => { if (self.onmessage) self.onmessage({ data: raw }); });
        this.readyState = 1;
        if (self.onopen) self.onopen();
      }, "up:" + name);
    }
    send(raw){ const msg = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw));
               later(() => relay.handle(this.me, msg), "up:" + name); }
    close(){ this.readyState = 3; if (this.onclose) this.onclose(); }
  }

  const sandbox = {
    process, console,
    performance: { now: () => now },
    requestAnimationFrame(cb){ frameCb = cb; return 1; },
    setTimeout(){ return 0; }, clearTimeout(){},
    setInterval: simSetInterval, clearInterval: simClearInterval,
    Math: ulp ? skewMath(ulp) : Math, Date: SimDate, Object, Array, JSON, Symbol, Proxy, Number, String, Boolean, Error,
    document: { getElementById(id){ return els[id] || (els[id] = fakeEl(id)); },
                createElement(tag){ return fakeEl(tag); } },
    WebSocket: FakeWS,
    navigator: { clipboard: null },
    localStorage: { getItem(){ return null; }, setItem(){} }
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.window.matchMedia = (q) => ({ matches: !!reduced && /prefers-reduced-motion/.test(String(q)) });
  sandbox.window.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
  sandbox.addEventListener = sandbox.window.addEventListener;
  sandbox.window.RPW_RELAY = "wss://fake-relay/ws";

  els.pips = fakeEl("pips");
  for (let i = 0; i < 2; i++) els.pips.appendChild(fakeEl("pip"));
  els.diffRow = fakeEl("diffRow");
  for (let i = 0; i < 4; i++) els.diffRow.appendChild(fakeEl("d" + i));

  vm.createContext(sandbox);
  vm.runInContext(gameCode, sandbox, { filename: "game.js" });
  vm.runInContext(netCode,  sandbox, { filename: "net.js" });
  return { sandbox, els, fire, get frameCb(){ return frameCb; } };
}

/* ------------------------------- the run --------------------------------- */
function mulberry32(a){
  return function(){ a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
/* advance the simulated world without stepping the game — for the handshake */
async function settle(ms){
  const end = now + ms;
  while (now < end){ now += 16; runTimers(); flush(); await Promise.resolve(); }
}

(async () => {
  const relay = makeRelay();
  const A = makeClient("host", relay, REDUCED_A, 0);
  const B = makeClient("guest", relay, REDUCED_B, ULP_B);

  console.log(`link: ${LAG}ms each way${JITTER ? ` +/-${JITTER}ms jitter` : ""} (round trip ~${LAG * 2}ms)`);
  console.log(`frame rate: A ${FPS_A}fps, B ${FPS_B}fps | seats ${TOTAL} | seed ${SEED} | mode ${MODE}` +
              (REDUCED_A || REDUCED_B ? ` | reduce-motion A ${REDUCED_A} B ${REDUCED_B}` : "") +
              (ULP_B ? ` | B on a different browser's trig (1 result in ${ULP_B} is 1 ulp out)` : ""));

  A.sandbox.window.RPWNet.connect("wss://fake-relay/ws");
  B.sandbox.window.RPWNet.connect("wss://fake-relay/ws");
  await settle(400);
  A.sandbox.window.RPWNet.create({ total: TOTAL, difficulty: 1, opts: null });
  await settle(400);
  B.sandbox.window.RPWNet.join("ABCD");
  await settle(400);
  B.sandbox.window.RPWNet.ready(true);
  A.sandbox.window.RPWNet.ready(true);
  await settle(600);

  const netA = A.sandbox.window.RPWNet.net, netB = B.sandbox.window.RPWNet.net;
  if (netA.state !== "running" || netB.state !== "running"){
    console.log("FAIL: the match never started. A:", netA.state, "B:", netB.state);
    process.exit(1);
  }
  console.log("match started — seats", netA.seat, netB.seat, "seed", netA.seed);

  const rngA = mulberry32(SEED), rngB = mulberry32(SEED + 1);
  const relA = new Map(), relB = new Map(), movA = [], movB = [];
  function drive(c, rng, release, move, keys){
    if (move.length === 0 || now >= move[0][1]){
      for (const k of move) c.fire("keyup", k[0]);
      move.length = 0;
      const n = rng() < .3 ? 1 : 2, pool = ["w","a","s","d"];
      for (let k = 0; k < n; k++){
        const key = pool[(rng() * 4) | 0];
        c.fire("keydown", key);
        move.push([key, now + 300 + (rng() * 700 | 0)]);
      }
    }
    const wantCast = MODE === "beam" ? 0.9 : 0.08;
    if (release.size === 0 && rng() < wantCast){
      const k = keys[(rng() * keys.length) | 0];
      c.fire("keydown", k);
      // a beam is held for seconds, not flicked
      release.set(k, now + (MODE === "beam" ? 900 + (rng() * 2600 | 0) : 60 + (rng() * 900 | 0)));
    }
    for (const [k, at] of [...release]) if (now >= at){ c.fire("keyup", k); release.delete(k); }
    c.frameCb(now);
  }

  const parts = c => c.sandbox.window.RPW.hashParts();
  /* proof the run actually disturbed the scenery — a green test that never
     moved a crate is not evidence about crates */
  const sceneryA = new Set();
  let clashFrames = 0;
  const simFrame = c => c.sandbox.window.RPW.frameNow();

  let firstBad = -1, firstParts = null, stalledFor = 0, maxStall = 0;
  let lastA = -1;

  const TICK = 4;                       // ms of wall clock per loop turn
  const stepA = 1000 / FPS_A, stepB = 1000 / FPS_B;
  let nextA = 0, nextB = 0;
  const turns = Math.ceil(FRAMES * 16 / TICK);
  for (let f = 0; f < turns; f++){
    now += TICK;
    runTimers();
    flush();
    // "u" is the beam, "j" the heavy hex, "h" is grasp — grasp throws scenery
    /* Both play spells that touch the SCENERY: k is Grasp, which picks a prop
       up and hurls it, and i is the Hexstone, which is heavy enough to smash
       one. A script that only shoots sparks never moves a crate, and a scenery
       bug cannot fail a test that never disturbs the scenery. */
    const keysA = MODE === "beam" ? ["j"] : ["y","u","i","k","k"];
    const keysB = MODE === "beam" ? ["j"] : ["y","i","k","j","k"];
    if (now >= nextA){ nextA = now + stepA; drive(A, rngA, relA, movA, keysA); }
    if (now >= nextB){ nextB = now + stepB; drive(B, rngB, relB, movB, keysB); }

    const fa = simFrame(A), fb = simFrame(B);
    sceneryA.add(parts(A).scenery);
    if (A.sandbox.window.RPW.clashing && A.sandbox.window.RPW.clashing()) clashFrames++;
    if (fa === lastA) { stalledFor++; maxStall = Math.max(maxStall, stalledFor); }
    else { stalledFor = 0; lastA = fa; }

    // only compare at EQUAL sim frames; different frames are a stall, not a desync
    if (fa === fb && firstBad < 0){
      const pa = parts(A), pb = parts(B);
      const bad = Object.keys(pa).filter(k => pa[k] !== pb[k]);
      if (bad.length){
        firstBad = fa; firstParts = bad;
        console.log("\n  DIVERGED at sim frame", fa, "—", bad.join(", "));
        console.log("  A", JSON.stringify(pa), "\n  B", JSON.stringify(pb));
      }
    }
    if (f % 2400 === 0)
      console.log(`  ${(now/1000).toFixed(1)}s: sim A ${fa} B ${fb} | delay A ${A.sandbox.window.RPW.NET.delay()} B ${B.sandbox.window.RPW.NET.delay()} | rtt A ${A.sandbox.window.RPW.NET.rtt()}`);
  }

  const fa = simFrame(A), fb = simFrame(B);
  console.log("\nafter", FRAMES, "frames:");
  console.log("  sim frames reached: A", fa, "B", fb);
  console.log("  longest stall:", maxStall, "frames");
  console.log("  frames with beams locked:", clashFrames, clashFrames === 0 && MODE === "beam" ? "  <-- no clash happened; this run proves nothing" : "");
  console.log("  distinct scenery states seen:", sceneryA.size, sceneryA.size < 5 ? "  <-- the scenery barely moved; this run proves little about it" : "");
  console.log("  input delay settled at: A", A.sandbox.window.RPW.NET.delay(), "B", B.sandbox.window.RPW.NET.delay());
  if (firstBad >= 0){
    console.log("\nFAIL: the worlds parted company at sim frame " + firstBad + " (" + firstParts.join(", ") + ")");
    process.exitCode = 1;
  } else if (fa < FRAMES * 0.5){
    console.log("\nFAIL: lockstep held, but the match crawled — only " + fa + " sim frames in " + FRAMES);
    process.exitCode = 1;
  } else {
    /* A pass is only worth what the run actually varied. Spelling that out on
       the verdict line is the difference between "the cross-browser case holds"
       and "nothing was tested and nothing broke" — which read identically until
       somebody acted on the wrong one. */
    const varied = [];
    if (JITTER) varied.push("jitter");
    if (FPS_A !== FPS_B) varied.push("mismatched frame rates");
    if (REDUCED_A !== REDUCED_B) varied.push("reduce-motion");
    if (ULP_B) varied.push("a different browser's trig");
    console.log("\nPASS: in lockstep and running at speed over a " + (LAG * 2) + "ms link");
    console.log(varied.length
      ? "      the clients differed in: " + varied.join(", ")
      : "      NOTE: both clients were identical (same code, same engine, same settings)." +
        "\n      This run says nothing about playing across two different browsers." +
        "\n      For that, set ULP_B (e.g. ULP_B=4096), or run tools/clash-test.js.");
    if (MODE === "beam" && clashFrames === 0)
      console.log("      NOTE: no two beams ever locked, so it says nothing about the clash either.");
  }
})();
