// Rock, Paper, Wizards — Cloudflare Worker / Durable Object relay.
//
// A faithful port of server/rooms.js + server/server.js (the Node WebSocket
// relay) onto Cloudflare's Durable Objects + WebSocket Hibernation API, so
// multiplayer runs entirely on Cloudflare like the tsunami and duck-delivery
// games do — no separate Node host, free tier.
//
// The relay runs no simulation. Every client runs the same deterministic
// simulation (fixed 1/60 step, one seeded RNG) and the relay's only jobs are:
//   1. put players into rooms (by code, or by quick match)
//   2. hand out the match seed and the seat order
//   3. relay one input mask per player per simulation frame
//
// One Durable Object instance holds every room and every WebSocket. The
// Pages Function at /ws (see functions/ws.js) forwards the upgrade here.
//
// Protocol: JSON objects with a "t" field — see docs/multiplayer.md.

import { DurableObject } from "cloudflare:workers";

const MAX_SEATS = 6;
const ROOM_IDLE_MS = 10 * 60 * 1000;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes

function cleanName(n) {
  return String(n == null ? "" : n).replace(/[^\w \-'.]/g, "").trim().slice(0, 14) || "Wizard";
}

export class RPWRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new Map();   // code -> room
    this.players = new Map(); // ws -> player
    this.nextId = 1;
  }

  // -------------------------------------------------------------------
  // WebSocket lifecycle (Hibernation API)
  // -------------------------------------------------------------------

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const player = { id: this.nextId++, name: "Wizard", room: null, seat: -1, ready: false, ws: server };
    this.players.set(server, player);
    this.send(player, { t: "welcome", id: player.id, maxSeats: MAX_SEATS });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const player = this.players.get(ws);
    if (!player) return;
    let msg;
    try { msg = JSON.parse(message); } catch (e) { return this.fail(player, "bad json"); }
    if (!msg || typeof msg.t !== "string") return;
    this.handle(player, msg);
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const player = this.players.get(ws);
    if (!player) return;
    this.players.delete(ws);
    if (player.room) this.removeFromRoom(player);
  }

  async webSocketError(ws, error) {
    await this.webSocketClose(ws, 1011, "error", false);
  }

  // -------------------------------------------------------------------
  // Transport helpers
  // -------------------------------------------------------------------

  send(player, raw) {
    if (player.ws && player.ws.readyState === 1) {
      player.ws.send(typeof raw === "string" ? raw : JSON.stringify(raw));
    }
  }
  fail(player, why) { this.send(player, { t: "error", why }); }

  // -------------------------------------------------------------------
  // Room bookkeeping (ported from rooms.js)
  // -------------------------------------------------------------------

  makeCode() {
    let code;
    do {
      code = "";
      for (let i = 0; i < 4; i++) code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    } while (this.rooms.has(code));
    return code;
  }

  createRoom(opts) {
    const room = {
      code: this.makeCode(),
      total: Math.min(MAX_SEATS, Math.max(2, opts.total | 0 || 4)),
      difficulty: Math.min(2, Math.max(0, opts.difficulty | 0)),
      isPublic: !!opts.isPublic,
      players: [], // Player[] — seat order is array order
      state: "lobby", // lobby | running
      seed: 0,
      touched: Date.now()
    };
    this.rooms.set(room.code, room);
    return room;
  }

  addToRoom(room, player) {
    if (room.players.length >= room.total) return false;
    player.room = room;
    player.seat = room.players.length;
    player.ready = false;
    room.players.push(player);
    room.touched = Date.now();
    return true;
  }

  removeFromRoom(player) {
    const room = player.room;
    if (!room) return;
    const i = room.players.indexOf(player);
    if (i < 0) return;
    room.players.splice(i, 1);
    room.players.forEach((p, n) => (p.seat = n)); // reseat so seats stay 0..n-1
    player.room = null;
    player.seat = -1;
    room.touched = Date.now();
    if (!room.players.length) {
      this.rooms.delete(room.code);
      return;
    }
    if (room.state === "running") {
      // a mid-match departure: the remaining clients hand that seat to a bot
      this.broadcast(room, { t: "left", code: room.code, players: this.roster(room) });
    } else {
      this.sync(room);
    }
  }

  roster(room) {
    return room.players.map(p => ({ seat: p.seat, name: p.name, ready: p.ready, host: p.seat === 0 }));
  }

  sync(room) {
    for (const p of room.players) {
      this.send(p, {
        t: "room",
        code: room.code,
        total: room.total,
        difficulty: room.difficulty,
        state: room.state,
        you: p.seat,
        players: this.roster(room)
      });
    }
  }

  broadcast(room, msg, except) {
    const raw = JSON.stringify(msg);
    for (const p of room.players) {
      if (p === except) continue;
      this.send(p, raw);
    }
  }

  startRoom(room) {
    if (room.state === "running") return;
    room.state = "running";
    room.seed = (Math.random() * 0xffffffff) >>> 0;
    room.touched = Date.now();
    for (const p of room.players) {
      this.send(p, {
        t: "start",
        seed: room.seed,
        total: room.total,
        difficulty: room.difficulty,
        you: p.seat,
        players: this.roster(room)
      });
    }
  }

  // -------------------------------------------------------------------
  // Message handling (ported from rooms.js handle())
  // -------------------------------------------------------------------

  handle(p, msg) {
    switch (msg.t) {
      case "hello":
        p.name = cleanName(msg.name);
        this.send(p, { t: "hello", name: p.name });
        return;

      case "create": {
        if (p.room) this.removeFromRoom(p);
        p.name = cleanName(msg.name || p.name);
        const room = this.createRoom({
          total: msg.total,
          difficulty: msg.difficulty,
          isPublic: msg.isPublic !== false
        });
        this.addToRoom(room, p);
        this.sync(room);
        return;
      }

      case "join": {
        const room = this.rooms.get(String(msg.code || "").toUpperCase());
        if (!room) return this.fail(p, "no room with that code");
        if (room.state === "running") return this.fail(p, "that match has already started");
        if (!(room.total - room.players.length)) return this.fail(p, "that room is full");
        if (p.room) this.removeFromRoom(p);
        p.name = cleanName(msg.name || p.name);
        this.addToRoom(room, p);
        this.sync(room);
        return;
      }

      case "quick": {
        if (p.room) this.removeFromRoom(p);
        p.name = cleanName(msg.name || p.name);
        let room = null;
        for (const r of this.rooms.values()) {
          if (r.isPublic && r.state === "lobby" && r.players.length < r.total) { room = r; break; }
        }
        if (!room) room = this.createRoom({ total: msg.total || 4, difficulty: msg.difficulty, isPublic: true });
        this.addToRoom(room, p);
        this.sync(room);
        return;
      }

      case "ready": {
        if (!p.room) return;
        p.ready = !!msg.v;
        p.room.touched = Date.now();
        this.sync(p.room);
        const r = p.room;
        if (r.state === "lobby" && r.players.length >= 2 && r.players.every(q => q.ready)) this.startRoom(r);
        return;
      }

      case "start": {
        // the host may start early and let bots fill the empty seats
        if (!p.room || p.seat !== 0) return;
        this.startRoom(p.room);
        return;
      }

      case "config": {
        if (!p.room || p.seat !== 0 || p.room.state !== "lobby") return;
        if (msg.total != null) p.room.total = Math.min(MAX_SEATS, Math.max(2, msg.total | 0));
        if (msg.difficulty != null) p.room.difficulty = Math.min(2, Math.max(0, msg.difficulty | 0));
        while (p.room.players.length > p.room.total) this.removeFromRoom(p.room.players[p.room.players.length - 1]);
        this.sync(p.room);
        return;
      }

      case "in": {
        // one input mask for one simulation frame; relayed verbatim
        if (!p.room || p.room.state !== "running") return;
        if (typeof msg.f !== "number" || typeof msg.m !== "number") return;
        this.broadcast(p.room, { t: "in", seat: p.seat, f: msg.f | 0, m: msg.m | 0 }, p);
        return;
      }

      case "bye":
        if (p.room) this.removeFromRoom(p);
        return;

      case "ping":
        this.send(p, { t: "pong", at: msg.at });
        return;
    }
  }
}

// The Worker's own fetch — the relay is only ever reached through the
// Durable Object binding from the Pages /ws function, so this just answers
// a health check. The RPWRelay class above is what actually runs the game.
export default {
  async fetch(request) {
    return new Response("Rock, Paper, Wizards relay worker is running.", { status: 200 });
  }
};
