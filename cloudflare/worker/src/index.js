// Rock, Paper, Wizards — Cloudflare Worker / Durable Object relay.
//
// A faithful port of server/rooms.js + server/server.js (the Node WebSocket
// relay) onto Cloudflare's Durable Objects + WebSocket Hibernation API, so
// multiplayer runs entirely on Cloudflare like the tsunami and duck-delivery
// games do — no separate Node host, free tier.
//
// CRITICAL (hibernation): a Durable Object can hibernate whenever it is
// idle, and on wake its constructor runs again — plain instance fields are
// LOST. So all durable state lives in ctx.storage (rooms + players), and the
// ws -> playerId mapping is recovered from per-WebSocket attachments
// (ws.serializeAttachment survives hibernation). Every handler reloads state
// first, so a message that arrives after a long idle gap still works. This
// was the bug: the first version kept rooms/players in plain Maps and every
// match silently broke the moment the object hibernated between actions.
//
// The relay runs no simulation. Every client runs the same deterministic
// simulation (fixed 1/60 step, one seeded RNG) and the relay's only jobs are:
//   1. put players into rooms (by code, or by quick match)
//   2. hand out the match seed and the seat order
//   3. relay one input mask per player per simulation frame
//
// Protocol: JSON objects with a "t" field — see docs/multiplayer.md.

import { DurableObject } from "cloudflare:workers";

const MAX_SEATS = 6;
const ROOM_IDLE_MS = 10 * 60 * 1000;
// A seat that has sent no input for this long mid-match is treated as gone. It is
// the difference between one person closing their laptop and everybody else
// staring at a frozen arena forever, because lockstep waits on every live seat.
const STALL_MS = 6000;
// When lockstep stalls, EVERY client stops sending — the ones waiting are as quiet
// as the one holding things up, so silence alone cannot name the culprit. What
// separates them is how far ahead each has sent: a client merely waiting has
// already queued its next DELAY frames and sits level with the room, while the one
// that stopped stepping is measurably behind. Only that one is dropped.
const STALL_LAG = 2;   // frames behind the room's furthest sender
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes

function cleanName(n) {
  return String(n == null ? "" : n).replace(/[^\w \-'.]/g, "").trim().slice(0, 14) || "Wizard";
}

// Host match settings. Sanitised here so every client in the room runs the
// same rules — the sim is lockstep, so these must never diverge.
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

export class RPWRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new Map();  // code -> room  (loaded from ctx.storage)
    this.byId = new Map();   // playerId -> {id,name,seat,ready,roomCode} (loaded)
    // desync bookkeeping is best-effort and deliberately NOT persisted: it is a
    // running conversation about the current match, worthless after an eviction
    this.hashes = new Map();   // room code -> Map(frame -> Map(seat -> checksum))
    this.desynced = new Set(); // room codes already told they diverged
    this.wsOf = new Map();   // ws -> playerId  (rebuilt from attachments)
    this.nextId = 1;
    this._loaded = null;
  }

  // ---------------------------------------------------------- state -----
  // Lazily load durable state from storage on wake, and rebuild the
  // ws -> playerId map from the WebSocket attachments the runtime kept.
  _ensureLoaded() {
    if (this._loaded) return this._loaded;
    this._loaded = (async () => {
      const [rooms, players, nextId] = await Promise.all([
        this.ctx.storage.get("rooms"),
        this.ctx.storage.get("players"),
        this.ctx.storage.get("nextId")
      ]);
      this.rooms = rooms ? new Map(Object.entries(rooms)) : new Map();
      this.byId = players ? new Map(Object.entries(players)) : new Map();
      this.nextId = nextId || 1;
      for (const entry of this.ctx.getWebSockets()) {
        const ws = Array.isArray(entry) ? entry[0] : entry;
        try {
          const att = ws.deserializeAttachment();
          if (att && att.playerId) this.wsOf.set(ws, att.playerId);
        } catch (e) { /* socket gone */ }
      }
    })();
    return this._loaded;
  }

  async _persist() {
    await Promise.all([
      this.ctx.storage.put("rooms", Object.fromEntries(this.rooms)),
      this.ctx.storage.put("players", Object.fromEntries(this.byId)),
      this.ctx.storage.put("nextId", this.nextId)
    ]);
  }

  // ---------------------------------------------------------------- ws --
  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    await this._ensureLoaded();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = String(this.nextId++);   // string keys — Object.fromEntries round-trips strings
    const player = { id, name: "Wizard", seat: -1, ready: false, roomCode: null };
    this.byId.set(id, player);
    server.serializeAttachment({ playerId: id });
    this.wsOf.set(server, id);
    this.ctx.acceptWebSocket(server);
    this.sendToId(id, { t: "welcome", id, maxSeats: MAX_SEATS });
    await this._persist();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    await this._ensureLoaded();
    const playerId = this.wsOf.get(ws);
    const player = playerId != null ? this.byId.get(playerId) : null;
    if (!player) return;
    let msg;
    try { msg = JSON.parse(message); } catch (e) { return this.failTo(player, "bad json"); }
    if (!msg || typeof msg.t !== "string") return;
    await this.handle(player, msg);
  }

  async webSocketClose(ws, code, reason, wasClean) {
    await this._ensureLoaded();
    const playerId = this.wsOf.get(ws);
    if (playerId == null) return;
    this.wsOf.delete(ws);
    const player = this.byId.get(playerId);
    if (!player) return;
    this.removeFromRoom(player);
    this.byId.delete(playerId);
    await this._persist();
  }

  async webSocketError(ws, error) {
    await this.webSocketClose(ws, 1011, "error", false);
  }

  // ------------------------------------------------------- transport -----
  wsForId(id) {
    for (const [ws, pid] of this.wsOf) if (pid === id) return ws;
    return null;
  }
  sendToId(id, raw) {
    const ws = this.wsForId(id);
    if (ws && ws.readyState === 1) ws.send(typeof raw === "string" ? raw : JSON.stringify(raw));
  }
  failTo(player, why) { this.sendToId(player.id, { t: "error", why }); }

  // --------------------------------------------------- room bookkeeping --
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
      opts: sanitizeOpts(opts.opts),
      playerIds: [], // in seat order
      state: "lobby", // lobby | running
      seed: 0,
      touched: Date.now()
    };
    this.rooms.set(room.code, room);
    return room;
  }

  addToRoom(room, player) {
    if (room.playerIds.length >= room.total) return false;
    player.roomCode = room.code;
    player.seat = room.playerIds.length;
    player.ready = false;
    room.playerIds.push(player.id);
    room.touched = Date.now();
    return true;
  }

  removeFromRoom(player) {
    const room = player.roomCode ? this.rooms.get(player.roomCode) : null;
    if (!room) return;
    const i = room.playerIds.indexOf(player.id);
    if (i < 0) return;
    room.playerIds.splice(i, 1);
    // A seat is the match's identity: one wizard, one row in the input table, one
    // place in the roster. Renumbering mid-match hands a survivor someone else's
    // seat, so their keys drive the wrong wizard while their own stands there
    // doing nothing — and the two worlds part company for good. Only compact
    // seats in the lobby, where nothing is running yet.
    if (room.state !== "running") {
      room.playerIds.forEach((pid, n) => { const q = this.byId.get(pid); if (q) q.seat = n; });
    }
    player.roomCode = null;
    player.seat = -1;
    room.touched = Date.now();
    if (!room.playerIds.length) {
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
    // report each player's OWN seat, not their position in the array — after a
    // mid-match departure those two stop agreeing, and the seat is what counts
    return room.playerIds.map(pid => {
      const p = this.byId.get(pid);
      const seat = p ? p.seat : -1;
      return { seat, name: p ? p.name : "?", ready: p ? p.ready : false, host: seat === 0 };
    });
  }

  sync(room) {
    const msg = {
      t: "room",
      code: room.code,
      total: room.total,
      difficulty: room.difficulty,
      opts: room.opts,
      state: room.state,
      players: this.roster(room)
    };
    for (const pid of room.playerIds) this.sendToId(pid, { ...msg, you: this.byId.get(pid) ? this.byId.get(pid).seat : -1 });
  }

  broadcast(room, msg, exceptId) {
    for (const pid of room.playerIds) {
      if (pid === exceptId) continue;
      this.sendToId(pid, msg);
    }
  }

  startRoom(room) {
    if (room.state === "running") return;
    room.state = "running";
    room.seed = (Math.random() * 0xffffffff) >>> 0;
    room.touched = Date.now();
    room.startedAt = Date.now();
    for (const pid of room.playerIds) { const q = this.byId.get(pid); if (q) q.maxF = -1; }
    this.hashes.delete(room.code);
    this.desynced.delete(room.code);
    for (const pid of room.playerIds) {
      const q = this.byId.get(pid);
      if (q) q.lastIn = room.startedAt;
    }
    const msg = {
      t: "start",
      seed: room.seed,
      total: room.total,
      difficulty: room.difficulty,
      opts: room.opts,
      players: this.roster(room)
    };
    for (const pid of room.playerIds) {
      const p = this.byId.get(pid);
      this.sendToId(pid, { ...msg, you: p ? p.seat : -1 });
    }
  }

  // ------------------------------------------------------ message handling
  async handle(p, msg) {
    let dirty = false;
    switch (msg.t) {
      case "hello":
        p.name = cleanName(msg.name);
        dirty = true;
        this.sendToId(p.id, { t: "hello", name: p.name });
        break;

      case "create": {
        if (p.roomCode) this.removeFromRoom(p);
        p.name = cleanName(msg.name || p.name);
        const room = this.createRoom({
          total: msg.total,
          difficulty: msg.difficulty,
          isPublic: msg.isPublic !== false,
          opts: msg.opts
        });
        this.addToRoom(room, p);
        this.sync(room);
        dirty = true;
        break;
      }

      case "join": {
        const room = this.rooms.get(String(msg.code || "").toUpperCase());
        if (!room) return this.failTo(p, "no room with that code");
        if (room.state === "running") return this.failTo(p, "that match has already started");
        if (!(room.total - room.playerIds.length)) return this.failTo(p, "that room is full");
        if (p.roomCode) this.removeFromRoom(p);
        p.name = cleanName(msg.name || p.name);
        this.addToRoom(room, p);
        this.sync(room);
        dirty = true;
        break;
      }

      case "quick": {
        if (p.roomCode) this.removeFromRoom(p);
        p.name = cleanName(msg.name || p.name);
        let room = null;
        for (const r of this.rooms.values()) {
          if (r.isPublic && r.state === "lobby" && r.playerIds.length < r.total) { room = r; break; }
        }
        if (!room) room = this.createRoom({ total: msg.total || 4, difficulty: msg.difficulty, isPublic: true });
        this.addToRoom(room, p);
        this.sync(room);
        dirty = true;
        break;
      }

      case "ready": {
        if (!p.roomCode) break;
        p.ready = !!msg.v;
        dirty = true;
        const r = p.roomCode ? this.rooms.get(p.roomCode) : null;
        if (r) r.touched = Date.now();
        this.sync(r);
        if (r && r.state === "lobby" && r.playerIds.length >= 2 && r.playerIds.every(pid => { const q = this.byId.get(pid); return q && q.ready; })) {
          this.startRoom(r);
        }
        break;
      }

      case "start": {
        // the host may start early and let bots fill the empty seats
        if (!p.roomCode || p.seat !== 0) break;
        const r = this.rooms.get(p.roomCode);
        this.startRoom(r);
        dirty = true;
        break;
      }

      case "config": {
        const r = p.roomCode ? this.rooms.get(p.roomCode) : null;
        if (!r || p.seat !== 0 || r.state !== "lobby") break;
        if (msg.total != null) r.total = Math.min(MAX_SEATS, Math.max(2, msg.total | 0));
        if (msg.difficulty != null) r.difficulty = Math.min(2, Math.max(0, msg.difficulty | 0));
        if (msg.opts) r.opts = sanitizeOpts({ ...r.opts, ...msg.opts });
        while (r.playerIds.length > r.total) {
          const last = this.byId.get(r.playerIds[r.playerIds.length - 1]);
          if (last) this.removeFromRoom(last);
        }
        this.sync(r);
        dirty = true;
        break;
      }

      case "in": {
        // one input mask for one simulation frame; relayed verbatim. Hot path:
        // never touches storage.
        if (!p.roomCode) break;
        const r = this.rooms.get(p.roomCode);
        if (!r || r.state !== "running") break;
        if (typeof msg.f !== "number" || typeof msg.m !== "number") break;
        const now = Date.now();
        p.lastIn = now;
        p.maxF = Math.max(p.maxF == null ? -1 : p.maxF, msg.f | 0);
        let ahead = -1;
        for (const pid of r.playerIds) {
          const q = this.byId.get(pid);
          if (q) ahead = Math.max(ahead, q.maxF == null ? -1 : q.maxF);
        }
        // Anyone still playing sweeps for seats that have gone quiet. Checked here
        // rather than on a timer because if nobody is sending input there is
        // nothing to unfreeze anyway — and this path already runs every frame.
        for (const pid of r.playerIds.slice()) {
          if (pid === p.id) continue;
          const q = this.byId.get(pid);
          if (!q) continue;
          if (now - (q.lastIn || r.startedAt || now) <= STALL_MS) continue;
          if (ahead - (q.maxF == null ? -1 : q.maxF) < STALL_LAG) continue;  // just waiting, like everyone else
          this.sendToId(q.id, { t: "dropped", why: "you fell too far behind the match" });
          this.removeFromRoom(q);
          dirty = true;
        }
        this.broadcast(r, { t: "in", seat: p.seat, f: msg.f | 0, m: msg.m | 0 }, p.id);
        break;
      }

      case "hash": {
        // Every client checksums its whole world once a second. Two that disagree
        // at the same frame have diverged and will never converge on their own,
        // so say so once and let them stop rather than drift apart in silence.
        if (!p.roomCode) break;
        const r = this.rooms.get(p.roomCode);
        if (!r || r.state !== "running") break;
        if (typeof msg.f !== "number" || typeof msg.h !== "number") break;
        if (this.desynced.has(r.code)) break;
        let byFrame = this.hashes.get(r.code);
        if (!byFrame) { byFrame = new Map(); this.hashes.set(r.code, byFrame); }
        const f = msg.f | 0;
        let at = byFrame.get(f);
        if (!at) { at = new Map(); byFrame.set(f, at); }
        at.set(p.seat, msg.h >>> 0);
        if (at.size > 1) {
          let first = null, split = false;
          for (const v of at.values()) { if (first === null) first = v; else if (v !== first) split = true; }
          if (split) {
            this.desynced.add(r.code);
            this.broadcast(r, { t: "desync", f });
          }
        }
        for (const k of byFrame.keys()) if (k < f - 900) byFrame.delete(k);
        break;
      }

      case "bye":
        if (p.roomCode) { this.hashes.delete(p.roomCode); this.desynced.delete(p.roomCode); }
        if (p.roomCode) this.removeFromRoom(p);
        dirty = true;
        break;

      case "ping":
        this.sendToId(p.id, { t: "pong", at: msg.at });
        break;
    }
    if (dirty) await this._persist();
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
