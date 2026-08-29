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

class Room {
  constructor(opts) {
    this.code = makeCode();
    this.total = Math.min(MAX_SEATS, Math.max(2, opts.total | 0 || 4));
    this.difficulty = Math.min(2, Math.max(0, opts.difficulty | 0));
    this.isPublic = !!opts.isPublic;
    this.players = []; // Player[]  — seat order is array order
    this.state = "lobby"; // lobby | running
    this.seed = 0;
    this.touched = Date.now();
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
    this.players.forEach((p, n) => (p.seat = n)); // reseat so seats stay 0..n-1
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
    return this.players.map(p => ({ seat: p.seat, name: p.name, ready: p.ready, host: p.seat === 0 }));
  }

  sync() {
    // each player is told which seat is theirs, so nothing has to be inferred
    for (const p of this.players) {
      p.send({
        t: "room",
        code: this.code,
        total: this.total,
        difficulty: this.difficulty,
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
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.touched = Date.now();
    for (const p of this.players) {
      p.send({
        t: "start",
        seed: this.seed,
        total: this.total,
        difficulty: this.difficulty,
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

function handle(p, msg) {
  switch (msg.t) {
    case "hello":
      p.name = cleanName(msg.name);
      p.send({ t: "hello", name: p.name });
      return;

    case "create": {
      if (p.room) p.room.remove(p);
      p.name = cleanName(msg.name || p.name);
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
      room.add(p);
      room.sync();
      return;
    }

    case "quick": {
      if (p.room) p.room.remove(p);
      p.name = cleanName(msg.name || p.name);
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
      p.room.broadcast({ t: "in", seat: p.seat, f: msg.f | 0, m: msg.m | 0 }, p);
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


module.exports = { Room, Player, handle, rooms, MAX_SEATS, ROOM_IDLE_MS, cleanName };
