/*
 * Room bookkeeping and message handling, with no transport attached.
 *
 * server.js wires this to a WebSocket; test-relay.js wires it to fake sockets,
 * which is why the whole matchmaking flow can be tested with no dependencies
 * and no open ports.
 */

"use strict";


const PORT = process.env.PORT || 8787;
const MAX_SEATS = 6;
const ROOM_IDLE_MS = 10 * 60 * 1000;
// A seat that has sent no input for this long mid-match is treated as gone. It
// is the difference between one person closing their laptop and every other
// player staring at a frozen arena forever.
const STALL_MS = 6000;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes

/** @type {Map<string, Room>} */
const rooms = new Map();
let nextId = 1;

function makeCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  } while (rooms.has(code));
  return code;
}

function sanitizeOpts(o) {
  o = o || {};
  return {
    roundsToWin: Math.min(9, Math.max(1, o.roundsToWin | 0 || 2)),
    mode: o.mode === "lives" ? "lives" : "rounds",
    lives: Math.min(9, Math.max(1, o.lives | 0 || 3)),
    mapSize: ["small", "medium", "large"].includes(o.mapSize) ? o.mapSize : "medium",
    fog: o.fog ? 1 : 0,
    mapPreset: ["random", "arena", "gauntlet", "crossfire"].includes(o.mapPreset) ? o.mapPreset : "random"
  };
}

class Room {
  constructor(opts) {
    this.code = makeCode();
    this.total = Math.min(MAX_SEATS, Math.max(2, opts.total | 0 || 4));
    this.difficulty = Math.min(2, Math.max(0, opts.difficulty | 0));
    this.isPublic = !!opts.isPublic;
    this.opts = sanitizeOpts(opts.opts);
    this.players = []; // Player[]  — seat order is array order
    this.state = "lobby"; // lobby | running
    this.seed = 0;
    this.touched = Date.now();
    this.hashes = new Map();   // frame -> Map(seat -> world checksum)
    this.desynced = false;
    rooms.set(this.code, this);
  }

  get openSeats() {
    return this.total - this.players.length;
  }

  add(player) {
    if (this.players.length >= this.total) return false;
    player.room = this;
    player.seat = this.players.length;
    player.ready = false;
    this.players.push(player);
    this.touched = Date.now();
    return true;
  }

  remove(player) {
    const i = this.players.indexOf(player);
    if (i < 0) return;
    this.players.splice(i, 1);
    // A seat is the match's identity: one wizard, one row in the input table, one
    // place in the roster. Renumbering mid-match hands a survivor someone else's
    // seat, so their keystrokes drive the wrong wizard while their own stands
    // there doing nothing — and the two worlds part company. Only compact seats
    // while we are still in the lobby, where nothing is running yet.
    if (this.state !== "running") this.players.forEach((p, n) => (p.seat = n));
    player.room = null;
    player.seat = -1;
    this.touched = Date.now();
    if (!this.players.length) {
      rooms.delete(this.code);
      return;
    }
    if (this.state === "running") {
      // a mid-match departure: the remaining clients hand that seat to a bot
      this.broadcast({ t: "left", code: this.code, players: this.roster() });
    } else {
      this.sync();
    }
  }

  roster() {
    return this.players.map(p => ({
      seat: p.seat, name: p.name, lv: p.lv || 1, ready: p.ready, host: p.seat === 0
    }));
  }

  sync() {
    // each player is told which seat is theirs, so nothing has to be inferred
    for (const p of this.players) {
      p.send({
        t: "room",
        code: this.code,
        total: this.total,
        difficulty: this.difficulty,
        opts: this.opts,
        state: this.state,
        you: p.seat,
        players: this.roster()
      });
    }
  }

  broadcast(msg, except) {
    const raw = JSON.stringify(msg);
    for (const p of this.players) {
      if (p === except) continue;
      p.send(raw);
    }
  }

  start() {
    if (this.state === "running") return;
    this.state = "running";
    this.hashes.clear();
    this.desynced = false;
    // everyone starts the clock even; the sweeper below measures from here
    const now = Date.now();
    for (const p of this.players) p.lastIn = now;
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.touched = Date.now();
    for (const p of this.players) {
      p.send({
        t: "start",
        seed: this.seed,
        total: this.total,
        difficulty: this.difficulty,
        opts: this.opts,
        you: p.seat,
        players: this.roster()
      });
    }
  }
}

class Player {
  /** @param sock {{send(raw:string):void, close?():void}} */
  constructor(sock) {
    this.sock = sock;
    this.id = nextId++;
    this.name = "Wizard";
    this.room = null;
    this.seat = -1;
    this.ready = false;
  }
  send(raw) {
    this.sock.send(typeof raw === "string" ? raw : JSON.stringify(raw));
  }
  fail(why) {
    this.send({ t: "error", why });
  }
}


function cleanName(n) {
  return String(n == null ? "" : n).replace(/[^\w \-'.]/g, "").trim().slice(0, 14) || "Wizard";
}
// A player's level, purely so the others can draw their cape with the right
// jewels on it. Nothing in the match depends on it, so a client claiming a
// level it has not earned wins nothing but a prettier cloak — but it is still
// clamped to a sane integer here, because "banana" reaching another client's
// rendering code is how you crash somebody else's game.
function cleanLevel(v) {
  const n = Math.floor(Number(v));
  return (n >= 1 && n <= 999) ? n : 1;
}

function handle(p, msg) {
  switch (msg.t) {
    case "hello":
      p.name = cleanName(msg.name);
      p.lv = cleanLevel(msg.lv);
      p.send({ t: "hello", name: p.name });
      return;

    case "create": {
      if (p.room) p.room.remove(p);
      p.name = cleanName(msg.name || p.name);
      if (msg.lv != null) p.lv = cleanLevel(msg.lv);
      const room = new Room({
        total: msg.total,
        difficulty: msg.difficulty,
        isPublic: msg.isPublic !== false
      });
      room.add(p);
      room.sync();
      return;
    }

    case "join": {
      const room = rooms.get(String(msg.code || "").toUpperCase());
      if (!room) return p.fail("no room with that code");
      if (room.state === "running") return p.fail("that match has already started");
      if (!room.openSeats) return p.fail("that room is full");
      if (p.room) p.room.remove(p);
      p.name = cleanName(msg.name || p.name);
      if (msg.lv != null) p.lv = cleanLevel(msg.lv);
      room.add(p);
      room.sync();
      return;
    }

    case "quick": {
      if (p.room) p.room.remove(p);
      p.name = cleanName(msg.name || p.name);
      if (msg.lv != null) p.lv = cleanLevel(msg.lv);
      let room = null;
      for (const r of rooms.values()) {
        if (r.isPublic && r.state === "lobby" && r.openSeats > 0) { room = r; break; }
      }
      if (!room) room = new Room({ total: msg.total || 4, difficulty: msg.difficulty, isPublic: true });
      room.add(p);
      room.sync();
      return;
    }

    case "ready": {
      if (!p.room) return;
      p.ready = !!msg.v;
      p.room.touched = Date.now();
      p.room.sync();
      // everyone present and ready, and at least two humans: go
      const r = p.room;
      if (r.state === "lobby" && r.players.length >= 2 && r.players.every(q => q.ready)) r.start();
      return;
    }

    case "start": {
      // the host may start early and let bots fill the empty seats
      if (!p.room || p.seat !== 0) return;
      p.room.start();
      return;
    }

    case "config": {
      if (!p.room || p.seat !== 0 || p.room.state !== "lobby") return;
      if (msg.total != null) p.room.total = Math.min(MAX_SEATS, Math.max(2, msg.total | 0));
      if (msg.difficulty != null) p.room.difficulty = Math.min(2, Math.max(0, msg.difficulty | 0));
      while (p.room.players.length > p.room.total) p.room.remove(p.room.players[p.room.players.length - 1]);
      p.room.sync();
      return;
    }

    case "in": {
      // one input mask for one simulation frame; relayed verbatim
      if (!p.room || p.room.state !== "running") return;
      if (typeof msg.f !== "number" || typeof msg.m !== "number") return;
      p.lastIn = Date.now();
      p.maxF = Math.max(p.maxF == null ? -1 : p.maxF, msg.f | 0);
      p.room.broadcast({ t: "in", seat: p.seat, f: msg.f | 0, m: msg.m | 0 }, p);
      return;
    }

    case "hash": {
      // Every client checksums its whole world once a second. Two clients that
      // disagree at the same frame have diverged and will never converge on
      // their own, so say so once and let them stop rather than drift.
      if (!p.room || p.room.state !== "running") return;
      if (typeof msg.f !== "number" || typeof msg.h !== "number") return;
      const r = p.room, f = msg.f | 0, h = msg.h >>> 0;
      let at = r.hashes.get(f);
      if (!at) { at = new Map(); r.hashes.set(f, at); }
      at.set(p.seat, h);
      if (!r.desynced && at.size > 1) {
        let first = null, split = false;
        for (const v of at.values()) { if (first === null) first = v; else if (v !== first) split = true; }
        if (split) {
          r.desynced = true;
          r.broadcast({ t: "desync", f });
        }
      }
      for (const k of r.hashes.keys()) if (k < f - 900) r.hashes.delete(k);
      return;
    }

    case "bye":
      if (p.room) p.room.remove(p);
      return;

    case "ping":
      p.send({ t: "pong", at: msg.at });
      return;
  }
}


// A running seat that has gone quiet is dropped, exactly as if the socket had
// closed: the remaining clients hand that wizard to a bot and carry on. Without
// this, one person tabbing away or losing their connection freezes the match for
// everybody, forever, because lockstep waits on a mask that is never coming.
// When lockstep stalls, EVERY client stops sending — the ones waiting are just as
// quiet as the one holding things up. So silence alone cannot name the culprit.
// What separates them is how far ahead each has sent. Work it through: both sit
// at frame F having sent F+DELAY. The straggler stops there. Everyone else keeps
// stepping until they run out of its masks — reaching F+DELAY, having sent
// F+2*DELAY. So the waiting clients end up level with the room's furthest sender
// and the straggler is exactly DELAY frames behind it. Drop only that one.
const STALL_LAG = 2;   // frames behind the room's furthest sender
function sweepStalled(now) {
  now = now || Date.now();
  const dropped = [];
  for (const room of rooms.values()) {
    if (room.state !== "running") continue;
    let ahead = -1;
    for (const q of room.players) ahead = Math.max(ahead, q.maxF == null ? -1 : q.maxF);
    for (const p of room.players.slice()) {
      if (now - (p.lastIn || now) <= STALL_MS) continue;
      if (ahead - (p.maxF == null ? -1 : p.maxF) < STALL_LAG) continue;   // just waiting, like everyone else
      const seat = p.seat;
      try { p.send({ t: "dropped", why: "you fell too far behind the match" }); } catch (e) {}
      room.remove(p);
      dropped.push({ code: room.code, seat });
    }
  }
  return dropped;
}

module.exports = { Room, Player, handle, rooms, MAX_SEATS, ROOM_IDLE_MS, STALL_MS, STALL_LAG, sweepStalled, cleanName };
