# Rock, Paper, Wizards

A top-down wizard duel. Every spell carries a **weight** — when two spells
collide the heavier one survives, lighter by whatever it just ate. Holding a key
charges a spell, adding weight at rising mana cost. That is the whole game: read
what is coming and answer it with something heavy enough.

The **Ward** is the one spell that is not a weight. It is a bank of damage
hung in front of you, sized by how long you held the key, and everything draws
on the same bank — a shot, a hurled crate, a beam grinding away at it. It soaks
as much of each blow as it is still holding and shatters on the blow that empties
it, passing through only what was left over. It covers the arc you are facing and
nothing behind you.

Countering pays. A counter that actually stops something returns mana on the
spot and gives you three seconds of gold corona and doubled regeneration. Being
out-weighed pays nothing.

## Running it

It is a static page with no build step:

```bash
python3 -m http.server 8080     # or any static file server
# then open http://localhost:8080
```

Open `index.html` straight off disk and everything works except the audio,
which browsers block on `file://`.

## Layout

```
index.html          markup, HUD, menus
src/style.css       the whole visual system
src/game.js         simulation, rendering, AI, audio — no dependencies
src/net.js          client half of the multiplayer protocol
assets/audio/       music and sound effects
server/             matchmaking + input relay (Node, one dependency: ws)
tools/              headless test rigs and the single-file bundler
docs/multiplayer.md the wire protocol and what is left to do
```

## Modes

| Mode | What it is |
| --- | --- |
| Apprentice / Adept / Archmage | One bot, easy / medium / hard |
| Escalation | Endless waves — one Apprentice, one Adept, one Archmage, then pairs up the tiers, then threes. A wave only arrives once the last one is cleared. Scored, with a local high-score board. |
| Match room | Free-for-all, 2–6 wizards, one or two seats at this keyboard, bots fill the rest |

## Controls

| | |
| --- | --- |
| `W` `A` `S` `D` | move — the wand aims itself |
| `Tab` | switch target |
| `Shift` | dash (3s cooldown) |
| `Y` `U` `I` | Spark · Rive · Hexstone |
| `H` `J` `K` | Ward · Beam · Grasp |
| `P` `R` `M` | pause · restart · mute |

Player two, in a match room: arrow keys, `1`–`6`, right `Shift`.

## Tests

```bash
node tools/determinism.js       # two identical runs must produce identical frames
node tools/sim-harness.js       # play a headless match, catch exceptions
node tools/ward-test.js         # the ward's absorption rules, case by case
node tools/build-single.js      # bundle everything into one portable .html
cd server && npm install && npm test
```

`tools/determinism.js` is the important one. The simulation runs on a fixed
1/60 step with a single seeded RNG and all human input funnelled through a
per-frame bit mask, so two machines given the same seed and the same inputs
produce byte-identical frames. That is what makes lockstep multiplayer possible
— if this test ever fails, multiplayer is broken.

`tools/sim-harness.js` takes `SEED`, `SECS`, `DIFF` (0–2 tiers, 3 escalation),
`ROOM` (2–6), `HUMANS` (1–2) and `BEAMY=1`. It found a real crash: the thrown-
prop loop was walking the debris array by index while props were being spliced
out of it.

## Multiplayer status

- **Working and tested:** the matchmaking server — rooms by code, quick match,
  seating, ready-up, shared seed, input relay, drop handling (13 tests).
- **Written, not yet played over a real connection:** `src/net.js`, the lockstep
  client. The protocol matches the server and the determinism it relies on is
  proven, but it has not been driven by two browsers with real latency between
  them, and the lobby has no UI yet — you drive it from the console today.

See `docs/multiplayer.md` for the protocol and the remaining work.

## Deploying to blipgaming

The game half is static: copy `index.html`, `src/`, and `assets/` to the host.
Nothing is bundled or minified, and there is no build step to run.

The relay is a small Node process (`server/`) that needs a websocket-capable
host and a public URL. Point the client at it with:

```js
RPWNet.connect("wss://your-host/ws");
```

Until that URL exists, every mode except networked play works exactly as it does
now — the game never waits on the network unless a match has actually started.
