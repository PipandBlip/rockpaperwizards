/*
 * Rock, Paper, Wizards — matchmaking and input relay (WebSocket transport).
 *
 * The server runs no simulation. Every client runs the same deterministic
 * simulation (fixed 1/60 step, one seeded RNG) and the server's only jobs are:
 *
 *   1. put players into rooms (by code, or by quick match)
 *   2. hand out the match seed and the seat order, so every client builds the
 *      same arena and the same roster
 *   3. relay one input mask per player per simulation frame
 *
 * All of the actual logic lives in rooms.js so it can be tested without a
 * socket. Protocol: JSON objects with a "t" field — see docs/multiplayer.md.
 */

"use strict";

const http = require("http");
const { WebSocketServer } = require("ws");
const { Player, handle, rooms, MAX_SEATS, ROOM_IDLE_MS } = require("./rooms");

const PORT = process.env.PORT || 8787;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on("connection", ws => {
  const player = new Player({
    send: raw => { if (ws.readyState === 1) ws.send(raw); },
    close: () => ws.close()
  });
  player.send({ t: "welcome", id: player.id, maxSeats: MAX_SEATS });

  ws.on("message", raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return player.fail("bad json");
    }
    if (!msg || typeof msg.t !== "string") return;
    handle(player, msg);
  });

  ws.on("close", () => { if (player.room) player.room.remove(player); });
  ws.on("error", () => {});
});

// rooms nobody has touched in a while are swept up
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_IDLE_MS && room.players.length === 0) rooms.delete(code);
  }
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`rock-paper-wizards relay listening on :${PORT}`);
});

module.exports = { server, rooms };
