# Rock, Paper, Wizards

A top-down wizard duel. Every spell carries a **weight** — when two spells
collide the heavier one survives, lighter by whatever it just ate. Holding a key
charges a spell, adding weight at rising mana cost. That is the whole game: read
what is coming and answer it with something heavy enough.

The **Ward** is the one spell that is not a weight. It is light cover with a
health bar — how long you held the key decides how much it can take — and it
thins the whole time it stands, so a wall raised early is half spent by the time
anything reaches it. It is rated for Spark and Rive and nothing else: it eats as
much of one as it is still holding, and the shot that empties it shatters it and
spills the remainder onto you. A Hexstone, a beam or a hurled crate is more than
it was built for and goes straight through, taking the wall with it. It covers
the arc you are facing and nothing behind you.

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
| Multiplayer | Free-for-all, 2–6 wizards over the network. Host a duel for a four-letter invite code, or paste someone else's. Bots fill any seat nobody takes. |

## Controls

| | |
| --- | --- |
| `W` `A` `S` `D` | move — the wand aims itself |
| `Tab` | switch target |
| `Shift` | dash (3s cooldown) |
| `Y` `U` `I` | Spark · Rive · Hexstone |
| `H` `J` `K` | Ward · Beam · Grasp |
| `P` `R` `M` | pause · restart · mute |


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

Two browsers have now played a room together end to end — host, invite code,
join, ready, start, and a full match in lockstep with both clients agreeing on
a hash of the world at every shared frame. That run found two real bugs, both
fixed:

- The input prefill covered frames `0..DELAY-1`, but the first `onStep` sends
  for `1 + DELAY`, so frame `DELAY` never got a mask and **every match stalled
  on frame 3 forever**.
- `draw()` and `drawBeam()` drew screen shake and particles from the
  **simulation's** seeded RNG. Rendering runs a variable number of times per
  simulation step, and `prefers-reduced-motion` differs per machine, so the two
  clients pulled a different number of values off the shared stream and silently
  diverged. Cosmetic randomness now comes from a separate unseeded `vrand()`,
  and the clash orb's shiver is applied when drawing rather than baked into its
  simulated position.

`tools/determinism.js` could never have caught the second one: it steps the
simulation once per rendered frame, so the streams stay aligned. Only variable
real-world frame pacing exposes it.

Still open: a public relay URL, latency tuning (`DELAY = 3` has only been tried
over localhost), desync detection on the wire, and rejoin. See
`docs/multiplayer.md`.

## Deploying to blipgaming

The game half is static: copy `index.html`, `src/`, and `assets/` to the host.
Nothing is bundled or minified, and there is no build step to run.

The relay is a small Node process (`server/`) that needs a websocket-capable
host and a public URL. The game reads that URL from one global, so set it before
`src/net.js` loads:

```html
<script>window.RPW_RELAY = "wss://your-host/ws";</script>
```

Leave it unset and the Solo Duel half works exactly as it does now — the
Multiplayer screens simply say there is no match server to reach.

Until that URL exists, every mode except networked play works exactly as it does
now — the game never waits on the network unless a match has actually started.
