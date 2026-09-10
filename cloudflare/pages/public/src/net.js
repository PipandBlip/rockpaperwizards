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
  const STALL_FRAMES = 120; // ~2s of no input from a seat before we hand it to a bot

  const net = {
    url: null,
    ws: null,
    id: 0,
    seat: -1,
    room: null,
    players: [],
    total: 0,       // seat count for the current match (fixed at start)
    state: "offline", // offline | lobby | running
    seed: 0,
    inputs: new Map(), // frame -> Int32Array(seat) of masks, -1 when unknown
    dropped: new Set(),
    stallAt: null,     // first frame we started waiting on a stalled seat
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
          /* A lobby ticker, so the round trip is known BEFORE the match starts —
             during a match `retune` pings from the frame loop instead. Guarded,
             because the headless rigs have no timers and net.js must not assume
             a browser: assuming one here crashed the net-round test outright. */
          if (typeof setInterval === "function"){
            if (net.pinger) clearInterval(net.pinger);
            net.pinger = setInterval(() => pingTick(Date.now()), 2000);
          }
          pingTick(Date.now());
          net.state = "lobby";
          send({ t: "hello", name: currentName(), lv: currentLevel(), build: currentBuild() });
          emit();
          resolve(net);
        };
        ws.onmessage = ev => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch (e) { return; }
          receive(msg);
        };
        ws.onclose = () => {
          if (net.pinger && typeof clearInterval === "function"){ clearInterval(net.pinger); }
          net.pinger = null;
          net.state = "offline";
          RPW.NET.active = false;
          if (RPW.pumpSync) RPW.pumpSync();
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
    // Whoever you are signed in as; "Guest" when you are not signed in at all.
    const n = (window.RPWA && window.RPWA.name) || "Guest";
    return String(n).trim().slice(0, 14) || "Guest";
  }

  // Your level, so everyone else can draw your cape with the right jewels on it.
  // One small integer, sent once when you say hello and once more when you make
  // or join a room — never in the per-frame input stream, which is the only
  // traffic that could cost anybody a frame. The colours are not sent: cloak
  // jewels are earned strictly in level order, so a level is enough for every
  // client to rebuild the same row of stones from the shared GEMS table.
  /* The build this page is running. Taken from the cache-bust on our own script
     tag, so it changes on every deploy. Two clients running different builds
     have different simulations and WILL diverge; saying so plainly beats
     letting them play for seven seconds and calling it a desync. */
  function currentBuild() {
    try {
      const tags = document.getElementsByTagName("script");
      for (const t of tags) {
        const m = (t.getAttribute("src") || "").match(/game\.js\?v=(\d+)/);
        if (m) return m[1];
      }
    } catch (e) {}
    return "0";
  }

  function currentLevel() {
    const p = window.RPWA && window.RPWA.profile;
    const lv = p && p.level;
    return (typeof lv === "number" && lv > 0) ? Math.min(999, Math.round(lv)) : 1;
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
        // whoever is gone stops being waited on; their wizard carries on as a bot.
        // Iterate the FIXED match total (net.total), not the current player count —
        // after a leave the roster is smaller, so looping over players.length would
        // never mark the vacated seat as dropped and the game would stall forever
        // waiting on a mask that is never coming.
        net.dropped = new Set();
        for (let s = 0; s < net.total; s++) {
          if (!net.players.some(p => p.seat === s)) net.dropped.add(s);
        }
        emit();
        return;

      /* The room is not all on the same build. This is not a desync — the two
         simulations were never the same program — so it gets its own message,
         because "refresh the page" is the fix and nothing else is. */
      case "badbuild": {
        net.error = msg.why || "different versions";
        endedBy("build");
        return;
      }

      case "pong": {
        const sample = Date.now() - (+msg.s || Date.now());
        rtt = rttSeen ? rtt * 0.7 + sample * 0.3 : sample;
        rttSeen = true;
        // what the furthest OTHER player in the room costs, as the relay sees it
        peerRtt = Math.max(0, +msg.peer || 0);
        emit();
        return;
      }

      case "desync": {
        // Two clients stopped agreeing about the world. Lockstep has no way back
        // from that without shipping whole game states around, so stop honestly
        // instead of leaving people standing in worlds that have parted company.
        // The relay also names which components split, which turns the next
        // report from "it broke" into a place to look.
        net.desync = {
          frame: msg.f | 0,
          parts: Array.isArray(msg.parts) ? msg.parts.map(String) : []
        };
        endedBy("desync", net.desync);
        return;
      }

      case "dropped": {
        // the server gave our seat away because we stopped sending input
        endedBy("dropped");
        return;
      }

      case "error":
        net.error = msg.why;
        emit();
        return;
    }
  }

  // one exit for every way a match can stop being playable
  function endedBy(reason, detail) {
    net.state = net.ws && net.ws.readyState === 1 ? "lobby" : "offline";
    net.room = null;
    net.players = [];
    net.seat = -1;
    net.total = 0;
    net.inputs.clear();
    net.dropped.clear();
    RPW.NET.active = false;
    if (RPW.pumpSync) RPW.pumpSync();
    if (RPW.endMatch) RPW.endMatch(reason, detail || null);
    emit();
  }

  function seatCount() {
    // During a running match the seat count is fixed at net.total (set at
    // start), even after players leave — the vacated seats still exist and
    // are handed to bots. In the lobby it's just the current roster size.
    return net.state === "running" && net.total > 0 ? net.total : net.players.length;
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
    net.total = msg.total || net.players.length; // fixed seat count for the match
    net.inputs.clear();
    net.dropped.clear();
    net.stallAt = null;
    net.lastSent = -1;

    // Seats with no human in them are bots, and a bot never sends a mask —
    // so mark every unoccupied seat as dropped up front, or ready() waits on
    // those seats forever and every match with bots stalls on round 1. (The
    // left handler below does the same job when someone leaves mid-match.)
    for (let s = 0; s < net.total; s++) {
      if (!net.players.some(p => p.seat === s)) net.dropped.add(s);
    }

    // The first onStep runs at simFrame 1 and sends for 1 + DELAY, so frames 0
    // through DELAY inclusive never get a mask from anybody. Prefill them idle
    // or every client stalls forever on frame DELAY waiting for a mask that is
    // never coming — which is exactly what happened the first time this was
    // driven by two real browsers.
    for (let f = 0; f <= DELAY; f++) frameRow(f).fill(0);

    const names = [], levels = [];
    for (const p of net.players) if (p.seat >= 0){
      names[p.seat] = p.name;
      levels[p.seat] = p.lv;          // may be undefined; the cape falls back to 1
    }

    RPW.NET.active = true;
    if (RPW.pumpSync) RPW.pumpSync();
    RPW.startMatch({
      mode: "match",
      seed: net.seed,
      total: msg.total || net.players.length,
      humans: net.players.length,
      seat: net.seat < 0 ? 0 : net.seat,
      names,
      levels,
      difficulty: msg.difficulty,
      opts: msg.opts || null,
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

  /* Waiting is not silence.

     A client only sends input when it takes a simulation step, and in lockstep
     it cannot step until its peer's input arrives. On a long link — Japan to
     Canada is a quarter of a second each way — a client can therefore sit
     perfectly healthy and perfectly quiet for seconds at a time, waiting. The
     relay could not tell that apart from a client that had gone away, and
     dropped it out of the match for "falling behind".

     So a waiting client says so, about once a second. It costs one tiny message
     and it is the difference between a long-distance game that plays and one
     that throws somebody out every few seconds. */
  /* ------------------------------------------------------------- ping

     The round trip to the relay, measured rather than guessed. It decides
     everything about how a long-distance match feels — how far ahead input has
     to be sent, and therefore how much lag you play with — so it is worth
     showing people, and worth knowing before changing anything about where the
     relay lives. Smoothed, because a single sample is mostly jitter. */
  let rtt = 0, peerRtt = 0, pingAt = 0, rttSeen = false;
  /* Callers read 0 as "not measured yet", so a measured round trip must never
     report as 0 — and on a relay in the same building it otherwise would.
     Date.now() only counts whole milliseconds, so a local sample is literally
     0, which used to be indistinguishable from silence: the readout hid itself
     precisely when the connection was at its best. rttSeen carries the
     "measured" part; the number carries only the number. */
  const shown = v => v ? Math.max(1, Math.round(v)) : 0;
  RPW.NET.rtt = () => rttSeen ? Math.max(1, Math.round(rtt)) : 0;
  RPW.NET.peerRtt = () => shown(peerRtt);
  function pingTick(now) {
    if (!net.ws || net.ws.readyState !== 1) return;
    if (now - pingAt < 2000) return;
    pingAt = now;
    send({ t: "ping", s: now, rtt: Math.round(rtt) });
  }

  /* ------------------------------------------------- adaptive input delay

     Lockstep cannot start frame F until every player's input for F has arrived.
     Input is sent `delay` frames ahead, so as long as the round trip is shorter
     than `delay` frames nobody ever waits. DELAY is 3 — fifty milliseconds —
     which is right for two people in the same country and hopeless between
     Japan and Canada, where the round trip is a quarter of a second. Every
     single frame then waits for the post, and a match that is otherwise
     perfectly healthy crawls along at ten frames a second.

     So the delay grows when we are being made to wait, and shrinks again when
     we are not. The cost is that OUR OWN key presses land further ahead — the
     standard trade every lockstep game makes over distance, and much the better
     end of it than slow motion.

     This needs no agreement between clients and no change to the protocol: each
     "in" message already names the frame it is for, so a client may send as far
     ahead as it likes. It only has to fill the gap when it moves the horizon
     out, or it would leave frames nobody ever sent. */
  const DELAY_MAX = 20;                 // ~330ms; beyond this the input lag is worse than the wait
  const JITTER_FRAMES = 3;              // headroom, so ordinary wobble does not stall a frame
  let delay = DELAY, waited = 0, adjAt = 0;

  /* How far ahead input actually has to be sent, from measurement rather than
     from groping upwards.

     What has to fit inside the delay is not a round trip: it is the ONE-WAY trip
     from this client to the relay plus the one-way trip from the relay to the
     furthest other player — that is the journey a mask makes before somebody
     needs it. Each client's own ping is twice its own leg, so the two halves add
     up to (mine + theirs) / 2. */
  function needFrames() {
    if (!rtt) return DELAY;
    const transit = (rtt + (peerRtt || rtt)) / 2;
    const frames = Math.ceil(transit / (1000 / 60)) + JITTER_FRAMES;
    return Math.max(DELAY, Math.min(DELAY_MAX, frames));
  }
  RPW.NET.need = needFrames;
  RPW.NET.waiting = function (ms) { waited += ms; };
  function retune(now) {
    pingTick(now);
    if (now - adjAt < 1000) return;
    adjAt = now;
    /* Settle ON the measured need, and only exceed it when the link is worse
       than the measurement says.

       The old rule only ever ratcheted: three frames up whenever a second held
       more than 100ms of waiting, one frame back only after a whole second with
       almost none. On a jittery long link that second never comes, so it climbed
       to the 20-frame ceiling and stayed — 330ms of input lag on a route that
       needed about 190ms. Measuring the trip and aiming at it directly gives
       back everything above that. */
    const want = needFrames();
    if (waited > 100 && delay < DELAY_MAX) delay = Math.min(DELAY_MAX, delay + 2);
    else if (delay > want) delay -= 1;
    if (delay < want) delay = want;
    waited = 0;
  }
  RPW.NET.delay = () => delay;

  let lastAlive = 0;
  RPW.NET.alive = function () {
    if (!net.ws || net.state !== "running") return;
    const now = Date.now();
    if (now - lastAlive < 1000) return;
    lastAlive = now;
    send({ t: "alive" });
  };

  RPW.NET.ready = function (frame) {
    if (!net.ws || net.state !== "running") return true;
    const row = net.inputs.get(frame);
    if (!row) return false;
    for (let s = 0; s < row.length; s++) {
      if (s === net.seat) continue;
      if (net.dropped.has(s)) continue;
      if (row[s] < 0) {
        // A seat we are still waiting on. If it has been stalled for a while
        // (a peer dropped without a clean "left", or a network blip), hand it
        // to a bot rather than freezing the whole match forever. The bot is
        // part of the deterministic sim, so no extra sync is needed.
        if (net.stallAt == null) net.stallAt = frame;
        if (frame - net.stallAt > STALL_FRAMES) net.dropped.add(s);
        return false;
      }
    }
    net.stallAt = null;
    return true;
  };

  RPW.NET.onStep = function (frame) {
    if (!net.ws || net.state !== "running") return;
    retune(Date.now());
    const target = frame + delay;
    if (target > net.lastSent) {
      const seat = net.seat < 0 ? 0 : net.seat;
      const mask = RPW.localMask() | 0;   // whatever this keyboard is holding right now
      /* Every frame from the last one we sent up to the new horizon, or moving
         the horizon out would leave a hole nobody ever fills and the whole room
         would wait on it forever. Normally that is exactly one frame. */
      const from = Math.max(net.lastSent + 1, frame + 1);
      for (let f = from; f <= target; f++) {
        const row = frameRow(f);
        if (row && seat < row.length) row[seat] = mask;
        send({ t: "in", f, m: mask });
      }
      net.lastSent = target;
    }
    // Once a second, hand the server a checksum of our whole world. It compares
    // clients at equal frames; two that disagree have diverged for good.
    // The checksum says THAT we diverged; the parts say WHERE. One number cannot
    // tell a projectile bug from a scenery bug, and a desync you cannot name
    // costs another coordinated session with a friend to reproduce.
    if (frame % 60 === 0 && typeof RPW.hash === "function") {
      const m = { t: "hash", f: frame, h: RPW.hash() >>> 0 };
      if (typeof RPW.hashParts === "function") m.parts = RPW.hashParts();
      send(m);
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
    create: opts => send({ t: "create", name: currentName(), lv: currentLevel(), total: (opts && opts.total) || 4, difficulty: (opts && opts.difficulty) || 0, isPublic: !(opts && opts.private), opts: opts && opts.opts }),
    join: code => send({ t: "join", name: currentName(), lv: currentLevel(), code: String(code || "").toUpperCase() }),
    quick: opts => send({ t: "quick", name: currentName(), lv: currentLevel(), total: (opts && opts.total) || 4 }),
    config: opts => send({ t: "config", ...opts }),
    ready: v => send({ t: "ready", v: v !== false }),
    start: () => send({ t: "start" }),
    leave: () => {
      send({ t: "bye" });
      net.state = net.ws && net.ws.readyState === 1 ? "lobby" : "offline";
      net.room = null;
      net.players = [];
      net.seat = -1;
      RPW.NET.active = false;
      if (RPW.pumpSync) RPW.pumpSync();
      emit();
    },
    onChange: fn => { net.onchange = fn; }
  };
})();
