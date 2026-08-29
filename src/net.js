/*
 * Rock, Paper, Wizards — client networking.
 *
 * The simulation in game.js is deterministic: a fixed 1/60 step, one seeded
 * RNG, and all human input funnelled through a per-frame bit mask. So a match
 * needs nothing on the wire except the seed and everybody's masks.
 *
 * Lockstep, with input delay:
 *   - at simulation frame F we send our mask for frame F + DELAY
 *   - the simulation may only advance past frame F once every seat's mask for
 *     frame F has arrived (or that seat has dropped and become a bot)
 *   - DELAY frames of input lag buys us DELAY/60 seconds of jitter tolerance
 *
 * Status: the lobby half (connect, create, join, quick match, roster, ready,
 * start) is exercised by server/test-relay.js. The in-match relay below follows
 * the same protocol but has NOT been played over a real connection yet — see
 * docs/multiplayer.md for what is left to prove.
 */

(function () {
  "use strict";

  const RPW = window.RPW;
  if (!RPW) return; // game.js did not load; nothing to wire up

  const DELAY = 3; // frames of input delay (~50ms at 60Hz)

  const net = {
    url: null,
    ws: null,
    id: 0,
    seat: -1,
    room: null,
    players: [],
    state: "offline", // offline | lobby | running
    seed: 0,
    inputs: new Map(), // frame -> Int32Array(seat) of masks, -1 when unknown
    dropped: new Set(),
    onchange: null,
    lastSent: -1
  };

  function log(...a) {
    if (window.RPW_DEBUG) console.log("[net]", ...a);
  }

  function emit() {
    if (typeof net.onchange === "function") net.onchange(net);
  }

  function send(obj) {
    if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(obj));
  }

  function connect(url) {
    return new Promise((resolve, reject) => {
      try {
        net.url = url;
        const ws = new WebSocket(url);
        net.ws = ws;
        ws.onopen = () => {
          net.state = "lobby";
          send({ t: "hello", name: currentName() });
          emit();
          resolve(net);
        };
        ws.onmessage = ev => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch (e) { return; }
          receive(msg);
        };
        ws.onclose = () => {
          net.state = "offline";
          RPW.NET.active = false;
          emit();
        };
        ws.onerror = err => {
          log("socket error", err);
          reject(new Error("could not reach the match server"));
        };
      } catch (e) {
        reject(e);
      }
    });
  }

  function currentName() {
    const inp = document.getElementById("nameInput");
    return (inp && inp.value ? inp.value : "Wizard").trim().slice(0, 14) || "Wizard";
  }

  function receive(msg) {
    switch (msg.t) {
      case "welcome":
        net.id = msg.id;
        emit();
        return;

      case "room":
        net.room = msg.code;
        net.players = msg.players || [];
        net.state = msg.state === "running" ? "running" : "lobby";
        if (typeof msg.you === "number") net.seat = msg.you;
        emit();
        return;

      case "start":
        beginMatch(msg);
        return;

      case "in": {
        const row = frameRow(msg.f);
        if (row && msg.seat >= 0 && msg.seat < row.length) row[msg.seat] = msg.m | 0;
        return;
      }

      case "left":
        net.players = msg.players || net.players;
        // whoever is gone stops being waited on; their wizard carries on as a bot
        net.dropped = new Set();
        for (let s = 0; s < seatCount(); s++) {
          if (!net.players.some(p => p.seat === s)) net.dropped.add(s);
        }
        emit();
        return;

      case "error":
        net.error = msg.why;
        emit();
        return;
    }
  }

  function seatCount() {
    return net.players.length;
  }

  function frameRow(f) {
    if (f < 0) return null;
    let row = net.inputs.get(f);
    if (!row) {
      row = new Int32Array(Math.max(1, seatCount())).fill(-1);
      net.inputs.set(f, row);
    }
    return row;
  }

  function beginMatch(msg) {
    net.players = msg.players || net.players;
    if (typeof msg.you === "number") net.seat = msg.you;
    net.seed = msg.seed >>> 0;
    net.state = "running";
    net.inputs.clear();
    net.dropped.clear();
    net.lastSent = -1;

    // the first DELAY frames are idle for everyone, so nobody stalls at the start
    for (let f = 0; f < DELAY; f++) frameRow(f).fill(0);

    RPW.NET.active = true;
    RPW.startMatch({
      mode: "match",
      seed: net.seed,
      total: msg.total || net.players.length,
      humans: net.players.length,
      difficulty: msg.difficulty,
      name: currentName()
    });
    emit();
  }

  /* ------------------------------------------------- simulation hooks ---- */

  RPW.NET.maskFor = function (seat) {
    const f = RPW.frameNow();
    const row = net.inputs.get(f);
    if (!row) return 0;
    const m = row[seat];
    return m < 0 ? 0 : m;
  };

  RPW.NET.ready = function (frame) {
    if (!net.ws || net.state !== "running") return true;
    const row = net.inputs.get(frame);
    if (!row) return false;
    for (let s = 0; s < row.length; s++) {
      if (s === net.seat) continue;
      if (net.dropped.has(s)) continue;
      if (row[s] < 0) return false; // still waiting on that seat
    }
    return true;
  };

  RPW.NET.onStep = function (frame) {
    if (!net.ws || net.state !== "running") return;
    const target = frame + DELAY;
    if (target > net.lastSent) {
      const seat = net.seat < 0 ? 0 : net.seat;
      const mask = RPW.localMask() | 0;   // whatever this keyboard is holding right now
      const row = frameRow(target);
      if (row && seat < row.length) row[seat] = mask;
      send({ t: "in", f: target, m: mask });
      net.lastSent = target;
    }
    // forget frames we will never look at again
    if (frame % 120 === 0) {
      for (const f of net.inputs.keys()) if (f < frame - 8) net.inputs.delete(f);
    }
  };

  /* ------------------------------------------------------ public API ---- */

  window.RPWNet = {
    net,
    DELAY,
    connect,
    create: opts => send({ t: "create", name: currentName(), total: (opts && opts.total) || 4, difficulty: (opts && opts.difficulty) || 0, isPublic: !(opts && opts.private) }),
    join: code => send({ t: "join", name: currentName(), code: String(code || "").toUpperCase() }),
    quick: opts => send({ t: "quick", name: currentName(), total: (opts && opts.total) || 4 }),
    config: opts => send({ t: "config", ...opts }),
    ready: v => send({ t: "ready", v: v !== false }),
    start: () => send({ t: "start" }),
    leave: () => {
      send({ t: "bye" });
      net.state = "lobby";
      net.room = null;
      RPW.NET.active = false;
      emit();
    },
    onChange: fn => { net.onchange = fn; }
  };
})();
