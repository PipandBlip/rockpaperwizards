# Multiplayer

## The shape of it

The simulation is deterministic, so the network never carries game state — only
input. Every client runs the same match from the same seed and the same masks,
and arrives at the same frame.

Three properties make that true, and all three are enforced in `src/game.js`:

1. **Fixed timestep.** `simStep()` advances the world by exactly `STEP` (1/60).
   The render loop accumulates real time and calls it 0–5 times per frame.
2. **One seeded RNG.** `rand()` is the only source of randomness in the
   simulation; `Math.random()` does not appear in `src/game.js`. Each round
   reseeds from `matchSeed` and the round number, so arenas match too.
3. **Input as state, not events.** Keyboard handlers only track which keys are
   down. Once per step, `pumpInput()` samples a bit mask per human wizard and
   `applyMask()` turns the difference from last frame into casts, dashes and
   target changes. A networked match feeds the same masks from the wire.

`node tools/determinism.js` checks this by running the same match twice and
comparing a checksum of every wizard, shot and prop every 30 frames.

## Lockstep

- At simulation frame `F` each client sends its mask for frame `F + DELAY`
  (`DELAY = 3`, about 50ms).
- A client may not advance past frame `F` until it holds a mask for `F` from
  every seat that has not dropped.
- A seat that drops stops being waited on and its wizard carries on under AI —
  which needs no extra sync, because the AI is part of the deterministic
  simulation.

Cost: three frames of input lag, and one slow player stalls everybody. That is
the classic lockstep trade, and it is the right first pass for a game with at
most six players and no ranked stakes. Rollback can come later; it needs
snapshot/restore of the whole world, which is a much bigger job.

## Wire protocol

JSON objects over a WebSocket, each with a `t` field.

### Client → server

| Message | Meaning |
| --- | --- |
| `{t:"hello", name}` | announce yourself; the name is cleaned and clipped to 14 chars |
| `{t:"create", total, difficulty, isPublic}` | open a room, you take seat 0 |
| `{t:"join", code}` | join by 4-character code |
| `{t:"quick", total}` | join any open public room, or open one |
| `{t:"config", total, difficulty}` | host only, lobby only |
| `{t:"ready", v}` | when every player in a room of 2+ is ready, the match starts |
| `{t:"start"}` | host only — start now and let bots fill the empty seats |
| `{t:"in", f, m}` | input mask `m` for simulation frame `f` |
| `{t:"bye"}` | leave the room |
| `{t:"ping", at}` | round-trip probe |

### Server → client

| Message | Meaning |
| --- | --- |
| `{t:"welcome", id, maxSeats}` | connection accepted |
| `{t:"room", code, total, difficulty, state, you, players[]}` | full lobby state; `you` is your seat |
| `{t:"start", seed, total, difficulty, you, players[]}` | begin — seed the RNG and build the roster |
| `{t:"in", seat, f, m}` | someone else's input for frame `f` |
| `{t:"left", code, players[]}` | somebody dropped mid-match; hand their seat to a bot |
| `{t:"error", why}` | the last request was refused |

### Input mask bits

```
1     up            16    Spark      (Y / 1)
2     down          32    Rive       (U / 2)
4     left          64    Hexstone   (I / 3)
8     right        128    Ward       (H / 4)
             256    Beam       (J / 5)
             512    Grasp      (K / 6)
1024  dash
2048  cycle target
```

Spell bits are held state, not events: the client turns a 0→1 transition into
`beginCharge` and a 1→0 into `releaseCharge`, which is exactly how charging
already worked locally.

## What is done

- `server/rooms.js` — rooms, codes, quick match, seating, ready-up, seed
  handout, relay, drop handling. 13 tests in `server/test-relay.js`, no
  dependencies, no ports.
- `server/server.js` — the WebSocket transport around it.
- `src/game.js` — determinism, the `NET` hook, and the `window.RPW` surface the
  net layer drives (`startMatch`, `localMask`, `frameNow`, `hash`).
- `src/net.js` — connect, lobby, seat handshake, seed, and the lockstep send /
  receive / stall logic.

## What is left

1. **A public relay URL.** The game is static and the relay is not; it needs a
   websocket-capable host. Set `window.RPW_RELAY` before `src/net.js` loads.
2. **Latency.** Two browsers have played a full room in lockstep, but over
   localhost. `DELAY = 3` (~50ms) has not met a real connection yet; expect to
   raise it, and to show a "waiting for <name>" state when `NET.ready()` returns
   false for more than a few frames.
3. **Desync detection.** Both clients already compute `RPW.hash()`. Exchange it
   every second or so; if two clients disagree, say so plainly and end the match
   rather than letting the worlds drift apart in silence.
4. **Rejoin.** A dropped player currently becomes a bot for good.
5. **Server hardening before it faces the open internet:** per-connection rate
   limits on `in` messages, a cap on rooms per IP, and an origin check on the
   WebSocket upgrade.

## Two bugs the first real playtest found

Both were invisible to `tools/determinism.js`, and both made networked play
impossible.

**The stall.** `beginMatch` prefilled input rows for frames `0..DELAY-1`, but
the first `onStep` runs at simulation frame 1 and sends for `1 + DELAY`. Frame
`DELAY` itself was never filled by anybody, so `NET.ready(DELAY)` returned false
forever and every client froze on frame 3. The prefill now covers `0..DELAY`
inclusive.

**The drift.** `draw()` jittered the screen shake and `drawBeam()` drew its
particles from `rand()` — the *simulation's* seeded stream. The render loop runs
a variable number of times per simulation step, and `prefers-reduced-motion` is a
per-user setting that gates several particle bursts, so two clients consumed a
different number of values from a stream that has to stay aligned. Same seed,
same inputs, different worlds within a second.

The fix is a wall between the two: `rand()` is the simulation's and may only be
touched inside it; `vrand()` is unseeded and belongs to anything only the eye or
the ear meets — particles, shake, wand flourishes, which sample of a sound to
play. The clash orb was the subtle case, because its shiver was being written
into the orb's real position, which is gameplay; the shiver now happens when it
is drawn.

`determinism.js` cannot catch this class of bug — it advances the simulation
once per rendered frame, so the streams never fall out of step. Catching it
needs two clients with independent frame pacing, compared by hash at equal frame
numbers.

## Local development

```bash
cd server && npm install && npm start     # relay on :8787
python3 -m http.server 8080               # game on :8080, from the repo root
```

Then, in the browser console on two tabs:

```js
await RPWNet.connect("ws://localhost:8787");
RPWNet.create({ total: 2 });      // tab one; note the code it prints via onChange
RPWNet.join("ABCD");              // tab two
RPWNet.ready(true);               // both
```
