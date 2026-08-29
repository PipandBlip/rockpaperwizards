/*
 * Headless two-client NETWORKED test for src/game.js + src/net.js.
 *
 * The solo harnesses (determinism.js, sim-harness.js) step a single client,
 * so they can never catch lockstep bugs that only appear with two machines —
 * the frame-3 freeze, the vrand divergence, and the round-transition stall.
 * This rig runs TWO full clients (each its own game.js + net.js in its own
 * vm context), bridges them through an in-process relay, drives both through
 * a real match, and asserts they stay in lockstep AND survive round 2.
 *
 *   node tools/net-round-test.js
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const gameCode = fs.readFileSync(path.join(__dirname, "..", "src", "game.js"), "utf8");
const netCode = fs.readFileSync(path.join(__dirname, "..", "src", "net.js"), "utf8");

/* ------------------------- tiny in-process relay ------------------------ */
function makeRelay() {
  const sockets = []; // { name, send(fn) } — send delivers JSON to that client
  let nextId = 1;
  const rooms = new Map();
  const wsBySocket = new Map();
  return {
    register(name, sendFn) {
      const s = { name, id: nextId++, send: sendFn, room: null, seat: -1, ready: false };
      sockets.push(s);
      wsBySocket.set(s, s);
      s.send({ t: "welcome", id: s.id, maxSeats: 6 });
      return s;
    },
    sendTo(s, raw) {
      s.send(typeof raw === "string" ? raw : JSON.stringify(raw));
    },
    roster(room) {
      return room.players.map(p => ({ seat: p.seat, name: p.name, ready: p.ready, host: p.seat === 0 }));
    },
    sync(room) {
      const msg = { t: "room", code: room.code, total: room.total, difficulty: room.difficulty, state: room.state };
      for (const p of room.players) this.sendTo(p, { ...msg, you: p.seat, players: this.roster(room) });
    },
    handle(s, msg) {
      switch (msg.t) {
        case "hello": s.name = msg.name; return;
        case "create": {
          const code = "ABCD";
          const room = { code, total: 2, difficulty: 0, players: [], state: "lobby" };
          rooms.set(code, room);
          s.room = code;
          s.seat = room.players.length; s.ready = false; room.players.push(s);
          this.sync(room);
          return;
        }
        case "join": {
          const room = rooms.get(String(msg.code || "").toUpperCase());
          if (!room) return this.sendTo(s, { t: "error", why: "no room with that code" });
          if (room.players.length >= room.total) return this.sendTo(s, { t: "error", why: "that room is full" });
          s.room = room.code;
          s.seat = room.players.length; s.ready = false; room.players.push(s);
          this.sync(room);
          return;
        }
        case "ready": {
          if (!s.room) return;
          s.ready = !!msg.v;
          const r = rooms.get(s.room);
          this.sync(r);
          if (r.players.length >= 2 && r.players.every(p => p.ready)) this.start(r);
          return;
        }
        case "start": {
          const r = s.room ? rooms.get(s.room) : null;
          if (!r || s.seat !== 0) return;
          this.start(r);
          return;
        }
        case "in": {
          const r = s.room ? rooms.get(s.room) : null;
          if (!r || r.state !== "running") return;
          const m = { t: "in", seat: s.seat, f: msg.f, m: msg.m };
          for (const p of r.players) if (p !== s) this.sendTo(p, m);
          return;
        }
        case "bye":
          if (s.room) { const r = rooms.get(s.room); r.players = r.players.filter(p => p !== s); s.room = null; }
          return;
      }
    },
    start(room) {
      room.state = "running";
      room.seed = 424242;
      for (const p of room.players) {
        this.sendTo(p, { t: "start", seed: room.seed, total: room.total, difficulty: room.difficulty, you: p.seat, players: this.roster(room) });
      }
    }
  };
}

/* ------------------------- DOM/canvas stub ------------------------------ */
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

/* ------------------------- build one client ----------------------------- */
function makeClient(name, relay) {
  const els = {};
  const listeners = {};
  let frameCb = null;
  let clock = 0;

  function fire(type, key){ for (const fn of listeners[type] || []) fn({ key, preventDefault(){}, target:{ tagName:"BODY" } }); }

  // Fake WebSocket bridged to the relay. net.js calls `new WebSocket(url)`
  // then reads ws.onopen/onmessage/onclose and ws.send(...).
  class FakeWS {
    constructor(url){
      this.readyState = 0; // CONNECTING
      this._url = url;
      const self = this;
      // register with the relay; the socket object routes to our onmessage
      setTimeout(() => {
        this.me = relay.register(name, raw => {
          // raw is the JSON string (or object) the relay wants us to receive
          if (self.onmessage) self.onmessage({ data: typeof raw === "string" ? raw : JSON.stringify(raw) });
        });
        // welcome is sent by register() synchronously; deliver it as the open
        this.readyState = 1;
        if (self.onopen) self.onopen();
      }, 0);
    }
    send(raw){
      // route to the relay
      relay.handle(this.me, JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)));
    }
    close(){ this.readyState = 3; if (this.onclose) this.onclose(); }
  }

  const sandbox = {
    process, console,
    performance: { now: () => clock },
    requestAnimationFrame(cb){ frameCb = cb; return 1; },
    setTimeout(fn){ return 0; },
    clearTimeout(){},
    Math, Date, Object, Array, JSON, Symbol, Proxy, Number, String, Boolean, Error,
    document: {
      getElementById(id){ return els[id] || (els[id] = fakeEl(id)); },
      createElement(tag){ return fakeEl(tag); }
    },
    WebSocket: FakeWS,
    navigator: { clipboard: null },
    localStorage: { getItem(){ return null; }, setItem(){} }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.matchMedia = () => ({ matches: false });
  sandbox.window.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
  sandbox.addEventListener = sandbox.window.addEventListener;
  sandbox.window.RPW_RELAY = "wss://fake-relay/ws"; // so hasNet() is true

  els.pips = fakeEl("pips");
  for (let i = 0; i < 2; i++) els.pips.appendChild(fakeEl("pip"));
  els.diffRow = fakeEl("diffRow");
  for (let i = 0; i < 4; i++) els.diffRow.appendChild(fakeEl("d" + i));

  vm.createContext(sandbox);
  vm.runInContext(gameCode, sandbox, { filename: "game.js" });
  vm.runInContext(netCode, sandbox, { filename: "net.js" });

  // make FakeWS instances actually reachable: net.js does `new WebSocket(url)`.
  return { sandbox, els, listeners, fire, get frameCb(){ return frameCb; }, setFrame(cb){ frameCb = cb; }, clock: () => clock, setClock(c){ clock = c; } };
}

/* ----------------------------- the test --------------------------------- */
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

(async () => {
  const relay = makeRelay();
  const A = makeClient("host", relay);
  const B = makeClient("guest", relay);

  // Connect both and drive the lobby.
  await A.sandbox.window.RPWNet.connect("wss://fake-relay/ws");
  await B.sandbox.window.RPWNet.connect("wss://fake-relay/ws");
  A.sandbox.window.RPWNet.create({ total: 2, difficulty: 0 });
  B.sandbox.window.RPWNet.join("ABCD");
  // wait for both to be in a room
  await new Promise(r => setTimeout(r, 50));
  B.sandbox.window.RPWNet.ready(true);
  A.sandbox.window.RPWNet.ready(true);
  await new Promise(r => setTimeout(r, 50));

  const netA = A.sandbox.window.RPWNet.net;
  const netB = B.sandbox.window.RPWNet.net;
  if (netA.state !== "running" || netB.state !== "running"){
    console.log("FAIL: match never started. A:", netA.state, "B:", netB.state);
    process.exit(1);
  }
  console.log("match started — seatA:", netA.seat, "seatB:", netB.seat, "seed:", netA.seed);

  // Scripted inputs for each client (independent policies). A is beam-heavy
  // (the beam is the ultimate and lands kills fast), B plays a spread.
  const rngA = mulberry32(1), rngB = mulberry32(2);
  const SPELLS_A = [["u",.15,[6,30]],["j",.75,[60,150]]];
  const SPELLS_B = [["y",.4,[2,10]],["u",.25,[6,30]],["i",.15,[20,70]],["h",.1,[2,8]],["j",.1,[70,170]]];
  function pickA(){ const r = rngA(), k = r < .15 ? "u" : "j"; const d = k === "j" ? [60,150] : [6,30]; return [k,d]; }
  function pickB(){ let r = rngB(), acc = 0; for (const [k,p,d] of SPELLS_B){ acc += p; if (r <= acc) return [k,d]; } return ["y",[2,10]]; }

  // Drive both clients frame-locked: same clock for both, one sim step each.
  let clock = 0;
  const MAX_FRAMES = 60 * 120; // up to 120 sim-seconds (round transitions + tally take time)
  const releaseA = new Map(), releaseB = new Map();
  const moveA = [], moveB = [];

  function step(c, rng, release, move, pick){
    const i = c.frameCb;
    // movement
    if (move.length === 0 || clock >= move[0][1]){
      for (const k of move) c.fire("keyup", k[0]);
      move.length = 0;
      const n = rng() < .3 ? 1 : 2;
      const pool = ["w","a","s","d"];
      for (let k = 0; k < n; k++){
        const key = pool[(rng()*4)|0];
        c.fire("keydown", key);
        move.push([key, clock + 30 + (rng()*70|0)]);
      }
    }
    if (release.size === 0 && rng() < 0.08){
      const [k, dur] = pick();
      c.fire("keydown", k);
      release.set(k, clock + dur[0] + (rng()*(dur[1]-dur[0])|0));
    }
    for (const [k, at] of [...release]) if (clock >= at){ c.fire("keyup", k); release.delete(k); }
    i(clock);
  }

  let mismatchAt = -1;
  let lastHashA = null, lastHashB = null;
  let sawRound2 = false;
  let round2StartHash = 0;
  let round2LiveFrames = -1;
  let flipFrame = -1; // test frame where the "Round 2" label first appears
  let round2WindowActive = false;

  for (let f = 0; f < MAX_FRAMES; f++){
    clock += 16;
    A.setClock(clock);
    B.setClock(clock);
    step(A, rngA, releaseA, moveA, pickA);
    step(B, rngB, releaseB, moveB, pickB);

    const ha = A.sandbox.window.RPW.hash();
    const hb = B.sandbox.window.RPW.hash();
    if (ha !== hb && mismatchAt < 0){
      mismatchAt = f;
      lastHashA = ha; lastHashB = hb;
      // instrument the first divergence: what sim frame, phase, positions?
      console.log("  DIVERGENCE @ frame", f, "hashA", ha, "hashB", hb);
      console.log("  A frameNow", A.sandbox.window.RPW.frameNow(), "B frameNow", B.sandbox.window.RPW.frameNow());
      const wa = A.sandbox.window.RPW.seats ? A.sandbox.window.RPW.seats() : "n/a";
      const wb = B.sandbox.window.RPW.seats ? B.sandbox.window.RPW.seats() : "n/a";
      console.log("  seats A", JSON.stringify(wa), "B", JSON.stringify(wb));
      // net input map size
      console.log("  A inputs", netA.inputs.size, "B inputs", netB.inputs.size, "| A lastSent", netA.lastSent, "B lastSent", netB.lastSent);
    }
    // detect round 2 banner (label flips at endRound; newRound runs ~120
    // test-frames later after the 2s tally countdown)
    const labelA = (A.els.roundLabel ? A.els.roundLabel.textContent : "");
    if (labelA.indexOf("Round 2") >= 0 && !sawRound2){
      sawRound2 = true;
      flipFrame = f;
      console.log("ROUND 2 label @ frame", f, "| hash", ha);
      console.log("  A net: lastSent", netA.lastSent, "inputs", netA.inputs.size, "state", netA.state);
      console.log("  B net: lastSent", netB.lastSent, "inputs", netB.inputs.size, "state", netB.state);
    }
    // The sim must stay LIVE well into round 2's actual play. The label
    // flips during the tally; the round-2 reset (newRound) fires ~120 frames
    // later. A lockstep freeze keeps the hash constant, so we count frames
    // where the hash CHANGES — but only start counting once we are safely
    // inside round 2 (tally is 2.0s = 120 frames, then "Wands up").
    if (sawRound2 && flipFrame >= 0 && f > flipFrame + 150){
      if (!round2WindowActive){
        round2WindowActive = true;
        round2StartHash = ha;
      } else if (ha !== round2StartHash){
        round2LiveFrames++;
      }
      if (f % 300 === 0) console.log("  (round-2 live frames:", round2LiveFrames, ")");
    }

    if (f % 300 === 0){
      console.log("frame", f, "| hashA", ha, "hashB", hb, "| labelA:", JSON.stringify(labelA), "| B:", JSON.stringify(B.els.roundLabel ? B.els.roundLabel.textContent : ""));
    }

    if (sawRound2 && round2LiveFrames >= 60){
      // we're well into round 2 — confirm hashes agree and both still step
      if (ha === hb){
        console.log("PASS: round 2 reached at frame", f, "— both clients in lockstep (hash", ha + ")");
        console.log("label:", labelA, "| guest label:", B.els.roundLabel ? B.els.roundLabel.textContent : "");
        process.exit(0);
      } else {
        console.log("FAIL: round 2 reached but hashes diverged — A:", ha, "B:", hb);
        process.exit(1);
      }
    }
  }
  if (!sawRound2){
    console.log("FAIL: never reached round 2 in", MAX_FRAMES, "frames (both clients likely stalled)");
    console.log("A state:", netA.state, "A room:", netA.room, "| B state:", netB.state, "B room:", netB.room);
    process.exit(1);
  }
  console.log("FAIL: round 2 reached but hashes mismatched at frame", mismatchAt, "A:", lastHashA, "B:", lastHashB);
  process.exit(1);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
