# Accounts and character profiles

Signing in is optional. Guests play everything; they just earn nothing.

## The shape of it

```
browser                      Pages Function                 Durable Object
src/account.js  --POST-->    functions/api/[[route]].js  --> RPWAccount
  holds the token              works out WHICH account       all the rules
  draws the level bar          from name or token            (accounts.js)
```

One Durable Object **per account**, addressed by `idFromName("u:" + lowercased
name)`. That is what makes a name unique — there is no index to maintain, no
scan to run, and two people registering the same name at the same moment are
serialised by the object itself.

`cloudflare/worker/src/accounts.js` holds every rule and imports nothing from
Cloudflare — it takes a small async key/value store and returns
`{status, body}`. The Durable Object hands it `ctx.storage`;
`server/test-accounts.js` hands it a `Map`. That is why the whole account
system can be tested without deploying anything.

## Tokens

A token is `<lowercased name>.<secret>`. The Pages Function splits it: the name
half tells it which object to call, and only the secret half is passed on. The
object stores `sha256(secret)`, never the secret. So there is no shared signing
key anywhere, and one wizard's token is meaningless against another's account.

Sessions last 60 days, eight live at a time per account (oldest dropped).
Passwords are PBKDF2-SHA256, 60k iterations, 16-byte random salt (kept under
Cloudflare's 100k-iteration cap).

## Experience

`xpForResult()` prices a finished match:

| | |
|---|---|
| base | 18, plus 55 for a win, plus 6 per round won |
| rival weight | Apprentice 0.8 · Adept 1.15 · Archmage 1.5 · **a person 2.0** |
| crowd | ×(1 + 0.22 × (rivals − 1)) |
| escalation | 15 + waves×14 + kills×5 |

Level *n* costs `120 + 80(n−1) + 12(n−1)²` to leave. The client carries its own
copy of that curve so the menu can draw an experience bar without a round trip;
`server/test-accounts.js` asserts the two agree for every level to 300.

### How much it is trusted

The client reports its own result, so a determined person can inflate a
profile — only the relay arbitrating matches would stop that, and it does not.
What is in place keeps it from being *effortless*: one paid result every 12
seconds, 420 experience per result, 7000 per day. Honest play never touches
any of them. Worth revisiting if profiles ever gate something competitive.

## Input: why a press latches

The simulation samples the keyboard **once per fixed step**, and steps only run
when a frame runs. So a press and release that both landed between two frames
were invisible: `keys[k]` went true and back to false with nothing sampling in
between. The spell never cast; the movement step never happened.

At sixty frames a second that window is 16ms and you would rarely catch it. In a
busy six-wizard fight the window is several times that — an ordinary quick tap.
It read as "sometimes my S doesn't move me down".

`tapped[]` fixes it. A press latches; the next step to run sees the key as held
even if the finger is already off it, and the latch is cleared once that step
has taken it — **one press, one step, never dropped and never repeated**.

Who clears it matters:

* solo — `pumpInput()`, after the step has applied its mask
* networked — `RPW.localMask()`, which net.js calls once per frame to send
* `newMatch()` and window blur, so nothing pressed beforehand leaks into a match

`npm run test:input` guards this. It drives the real game in a stubbed DOM and
fires key events precisely between frames. Remove the latch and its first three
assertions fail — that has been checked, not assumed.

One consequence worth knowing: `tools/net-round-test.js` reports a different
frame and hash than it did before this change. That is not a regression. The rig
scripts a sub-frame dash tap, which used to be silently dropped and now lands,
so the match plays out differently. The golden fingerprint is unchanged, because
the bots' own decisions never depended on it.

## The page layout

`fitStage()` in `src/game.js` caps the arena by height as well as width. The
canvas is 960x620 and scales to its box, so the box was free to grow taller
than the window and push the health plates and the spell book off screen. It
measures — rather than assumes — everything else in the shell (the music row,
the plates, the round counter, the spell book, the gaps, the body padding),
subtracts it from the window height, and sets the arena's `max-width` so its
height lands in what is left. It runs on every resize and whenever the plates
are rebuilt, since six of them can wrap onto a second row.

Two things it depends on, both easy to break:

* **The health plates and the round counter fade, they do not hide.** Their
  space is reserved on the menu too, so the arena is the same size before and
  during a duel. Switching either back to `hidden` makes the layout jump when a
  match starts — and on a 1280x800 window that jump pushed the spell book off
  the bottom.
* **Anything new added to `.shell` is measured automatically**, except a
  `<details>`, which is skipped on purpose so the how-to-play manual can sit
  below the fold.

### The host panel

The lobby leads with what a host actually does: the invite code, how many
players, how good the bots are, which arena, who has turned up. Arena came out
from behind the disclosure because it is the one choice people open that screen
to make — it now sits in the open in both the host and solo panels, as a fixed
three-wide grid (six names never divide evenly across a 430px row; left to wrap
they came out five and a lonely one). What stays behind **More options** is the
genuinely occasional: win condition, round or life count, arena size, fog.

One bug fell out of looking at it. `.rrow` sets `display:flex`, which outranks
the browser's own `[hidden]{display:none}`, so the Lives slider sat under the
Rounds slider in Rounds mode — both visible, one of them doing nothing. The fix
is a single `.rrow[hidden]{display:none}`; the same trap is waiting for any
future row that relies on the `hidden` attribute.

## Drawing cost: shadowBlur

A full room of Archmages ran at about six frames a second, and the obvious
story — that six clever bots cost six times the thinking — was wrong. `aiTick`
measures at roughly **one millisecond**. A CPU profile blamed `drawImage`, which
was also wrong: canvas defers its work, so the cost of everything queued lands
on whichever call happens to force the flush.

Counting the actual draw calls found it. Per frame, six Archmages:

| | fills | shadowed | frame |
|---|---|---|---|
| before | 309 | **90** | 158ms |
| after | ~300 | **23** | 82ms |

**A blurred fill is one of the most expensive things a 2D canvas can be asked
for** — it draws the shape, blurs a copy, then composites both. Ninety of those
a frame is the whole story; the fill count barely moved.

What was done, all of it view-only and none of it touching the simulation:

* **`strokeJag` had a bug.** The lightning filaments along a beam inherited
  whatever `shadowBlur` happened to be set when they were drawn — twenty-odd
  blurred polyline strokes a frame, the single most expensive thing on screen.
  It now forces `shadowBlur = 0` and draws a wide faint pass under a crisp one,
  which under the beam's `lighter` compositing looks the same and costs a
  fraction.
* **Small repeated glows are pre-rendered once and blitted**: cloak jewels,
  beam motes, bolts, the charge orb. `glowSprite` / `jewelSprite` / `haloSprite`
  cache by colour and size and stay tiny.
* **`haloSprite`** is the glow with the shape punched back out, for things that
  still draw their own crisp body — a wizard's brim, which alone was two large
  blurred draws per wizard per frame.

Result: **6 Apprentices 33→26ms, 6 Adepts 44→21ms, 6 Archmages 158→82ms**, and
p90 frame time roughly halved. Twenty-three shadowed draws a frame remain, none
of them dominant.

### Proving a rendering change did not change the game

`tools/golden.js` records a digest of the simulation across twenty
seed/tier/room/fog combinations. `determinism.js` can only show a build agrees
with *itself* — two runs of a subtly different build agree perfectly well. The
golden file is what shows the bots still make the same decisions:

    npm run test:golden

Run it after anything meant to be a pure optimisation. Every change above
leaves it byte-identical.

## Sign in and sign up are two buttons, not one button and a mode

The screen used to have one **Sign in** button and, underneath it, a link
reading *New here? Create a wizard*. That link did not go anywhere — it silently
swapped what the button above it did. So the button you were looking at was not
always the button you wanted, and nothing on the screen told you which of the
two states you were in.

Now both actions are buttons, side by side, each doing its own thing when
pressed, with **Back** on its own row below. There is no `authMode` left to be
in — `authSubmit(mode)` takes the mode from whichever button called it. Enter in
either box means Sign in, which is what a return key means on a form you have
typed a known name and password into.

The sign-up button also checks the name and password lengths before the round
trip, so a new player reads the rule instead of being bounced by the server. That
is only an improvement while the two copies of the rule agree, so `src/account.js`
carries `RPWA.limits` mirroring the worker's `LIMITS`, and
`server/test-accounts.js` pins them together — changing one side alone fails a
test rather than shipping a form that accepts what the server will refuse.

## Why the sign-in page is shaped the way it is

A brand-new domain that suddenly grows a password field is exactly the profile
phishing heuristics are tuned for, and Dashlane flagged blipgaming.ca on sight.
Most of what decides that is domain reputation, which no amount of code fixes —
but the page should not be adding to the suspicion, so:

* **No inline JavaScript anywhere.** The relay URL is a `<meta name="rpw-relay">`
  read by `src/game.js`, and the how-to-play picture slots bind their fallback
  in script rather than with `onerror=`. That is what lets `_headers` serve
  `script-src 'self'` with no `'unsafe-inline'`.
* **`form-action 'self'`** in the CSP — the browser itself refuses to post these
  credentials anywhere but this origin.
* **An ordinary login form**: `method="post"`, a real same-origin `action`,
  `name="username"` / `name="password"`, correct `autocomplete` values, and
  `<label for>` tied to each input. A password field with no name and no form
  action is a scraper pattern; this is not one.
* A favicon, a page title and a description, so the site does not look
  half-finished to a scanner.

**If you add an inline `<script>` or an `onclick=` to index.html it will work
locally and break silently on the live site** — the CSP blocks it. Put it in a
`.js` file instead.

Neither of these is a guarantee. If the warning persists, report it as a false
positive to Dashlane; that is the only thing that moves a reputation score.

## Deploying

The worker gained a **second Durable Object class**, so it needs its migration
run before the site can use it:

1. `cd cloudflare/worker && npx wrangler deploy` — this applies migration `v2`
   (`new_sqlite_classes = ["RPWAccount"]`).
2. In the Cloudflare dashboard, on the **Pages** project:
   Settings → Bindings → Durable Objects → add
   **`RPW_ACCOUNT`** → service `rockpaperwizards-relay`, class `RPWAccount`.
   (This is the same manual step `RPW_RELAY` needed; `wrangler.toml` records it
   but the dashboard is what actually binds it for Pages.)
3. `cd cloudflare/pages && npx wrangler pages deploy`

Until step 2 is done, `/api/*` returns an error and the game quietly runs
guest-only — which is also exactly what happens on the single-file `dist/`
build, where there is no server at all.

## The cloak ladder

Levels 1 to 14, one rung each, drawn from Green's reference sheet. A cloak is
not "how many stones you have" any more — three things move, at different rates,
which is what stops the middle of the ladder feeling like a slower version of
the start:

| | 1–3 | 4–6 | 7 | 8–11 | 12–13 | 14 |
|---|---|---|---|---|---|---|
| **emblem** | 1, 2, 3 studs | quatrefoil | hexagon | hex, 2 hex, 3 hex, lattice | lattice | cut diamond |
| **seams** | none | 1, 4, 7 | 6 | 7, 7, 6, 5 | 3 | 2 |
| **family** | grey | grey | grey | sage | sage | pale |

Seams thin out again at the top on purpose — the reference does the same thing,
letting broad panels take over from pleats.

### A family is one colour, and the fade is alpha

Each rung names a **family**, and a family is a single base colour plus the
wizard wearing it:

```js
grey: { base:"#3a3a44", hat:"#5e5e68", brim:"#24242b", lit:"#93939f", panel:null }
```

The cloth is **not** a light-to-dark colour ramp. It is that one colour with a
falling **alpha** down its length — near solid at the shoulders, thinned to 40%
at the hem:

```js
grad.addColorStop(0,    rgba(rank.base, .96));
grad.addColorStop(0.55, rgba(rank.base, .74));
grad.addColorStop(1,    rgba(rank.base, .40));
```

That is the difference between cloth you can see through and a shape cut out of
paper, and it is why there is no second colour here that could drift out of step
with the first. Two earlier passes got this wrong in opposite directions — a
light-shouldered ramp that read as cardboard, then a two-colour ramp that read
as a gradient rather than as fading cloth.

**Everything drawn on top is white**: the seams, the hem band and its edge, the
emblem. The one exception is the top rung, where the centre wedge is green on an
almost-white cloak — the single piece of colour on the finished cloth.

The family also dresses the **wizard**. The hat cone, its brim and its lit edge
come from the same entry, so a wizard in a green cloak is a green wizard and
rank reads from the whole figure rather than from the cloth trailing behind it.

**So colour belongs to the ladder, not to the seat.** The cape and hat used to be
blue for friendly and red for foe; that fought the ladder for the same channel,
so it is gone. Friend and foe are carried by the tint — the ring around the brim,
the outline, the halo, the wand — which is the channel that was always doing
that job anyway, and it still separates six wizards standing in one arena.

Past 14 the ladder continues through blue, then red, then purple. That is three
more entries in `FAMILY` and a `family` field on the new rungs, and nothing
else. Until they exist a wizard above 14 wears the level 14 cloak.

### The cloth is translucent, and the glow is not shadowBlur

The arena reads through the cape at 70% — that is what makes it feel like
enchanted cloth rather than cardboard, and the flat ladder colours had briefly
made it opaque and pasted-on. The glow around the edge is **three strokes of the
seat's own tint** at falling width and rising alpha:

```js
ctx.globalAlpha = .12; ctx.lineWidth = 5.5; ctx.stroke();
ctx.globalAlpha = .26; ctx.lineWidth = 2.8; ctx.stroke();
ctx.globalAlpha = .85; ctx.lineWidth = 1.1; ctx.stroke();
```

Not `shadowBlur`. At this size they look the same and the strokes cost almost
nothing, where shadowBlur is the single most expensive thing this renderer can
do — it is what had six Archmages running at 13fps, and putting it back on every
cape would have undone that fix.

### The hem is the loudest signal

The silhouette changes shape as you climb, and it is readable across an arena
long before an emblem is: a shallow **chevron** on plain cloth, a deep pointed
**kite**, a broad **rhombus** with tips flared past the body once the cloth
turns green, and a deeply **split** pair of lobes at the top. Every point is built from
the tail's own direction and normal, so the shape swings with the cloth rather
than being painted on flat, and `flare` widens the skirt over the bottom third
only — a high rung is a broader hem, not a uniformly fatter cape.

### Nothing else can catch a broken rung

Capes are view-only. They touch no seeded RNG and appear in no hash, which is
what makes them free — and also means the determinism suite, the golden
fingerprints and the relay tests are all structurally incapable of noticing that
a rung names an emblem the renderer has never heard of. It would draw the
fallback stud on every cloak from that rung up, silently, and only on the levels
nobody has reached yet.

So `server/test-accounts.js` pins the ladder's DATA: fourteen rungs, one per
level, every rung naming a cloth, a band and an emblem, **every emblem having a
matching case in `emblemPath()`**, the cloth moving grey → green → pale and
never back, and level 400 still wearing level 14's cloak. Renaming one emblem in
the table fails that suite instead of shipping.

And `tools/cape-test.js` pins the RENDERING, one case per rung. This is not
hypothetical caution: changing the tail silhouette left one call reaching for a
point that no longer existed, and it crashed the draw loop for every wizard
above level 7. Nothing in the repo noticed — a browser did. Two things had to
change so a Node test could:

- **The headless rig never loaded `src/account.js`.** With no `RPWA` there is no
  ladder, so every cape in every rig sat on rung 1 and the higher rungs' cloth,
  seams and tail shapes were never executed at all. `boot()` now loads it; it
  touches no seeded RNG and makes no network call unless asked, and the golden
  fingerprints are byte-identical either way.
- **The test drives the real draw loop** with a wizard on every rung, one case
  each so a failure says "rung 11" rather than "some cape somewhere", plus mixed
  levels in one arena — which is the shape that actually crashed. Reintroducing
  that bug fails eleven of its cases, from level 8 up, exactly where the browser
  found it.

It also checks what the ladder promises rather than just that it runs: the cloth
never gets narrower as it climbs, the hem goes chevron → kite → rhombus → split
and never doubles back, and no cloth folds through itself on any rung.

`server/test-accounts.js` covers the family the same way: every rung fully
dressed (cloth ends, accent, hat, brim, lit), the families running grey → sage →
pale and never doubling back, **the hat always matching its own cloak's family**
— a green wizard in a grey hat is exactly the kind of bug that only surfaces in
a screenshot somebody happens to look at — each family carrying one distinct base colour, and the
design over the cloth being white at every rung bar the top one's green wedge —
the rule that makes a single base colour enough, and the one a new family could
quietly break by bringing its own trim.

## The cape

Every wizard trails a cloak, drawn by `drawCape()` in `src/game.js`.

**A wizard starting out wears plain cloth.** No braid, no stones — everything on
the cape is earned. Each cloak jewel adds one stone in its own colour; the
first jewel brings a gold hem braid, the fourth a second braid, the eighth a
band across the shoulders. The garment itself also grows: longer and a little
wider with rank. So a beginner and an Archmage are told apart across the arena
without reading a name.

Where the rank comes from: the signed-in player reads their own profile,
everyone else reads `seatLevels` from the roster the relay sends, and **a bot
wears a rank like anybody else**.

### Bots wear a rank, not a special case

`BOT_LEVEL = [1, 16, 33]` gives each tier a level and sends it through
`rankFor()` exactly as a player's level goes, so a bot's cloak is a cloak
somebody could actually be wearing — same stones, same colours, same braid, same
size. You should be able to look at a wizard across the arena and know what you
are facing.

| tier | level | stones | reads as |
|---|---|---|---|
| Apprentice | 1 | 0 | the plain cloth a new player starts in |
| Adept | 16 | 6 | halfway up, one braid |
| Archmage | 33 | 10 | two braids and a shoulder band |
| a finished player | 40 | 12 | still out-dresses the Archmage |

Archmage deliberately stops two stones short. It should be a cloak to want, not
a ceiling somebody has already been handed.

**Levels, not gem counts** — that keeps the `GEMS` table the single source of
truth, so retuning the ladder moves the bots with it and nothing here needs
touching. (Bots previously carried a bare count and no colours at all, so their
stones drew as placeholder white.)

### The cut of a stone

Every entry in `GEMS` names a `shape`, and the ladder is ordered by how
elaborate the cut is — a plain bar at level two, an eight-pointed sigil at
forty:

    bar · dot · square · pentagon · triangle · crescent
    hex · ring · spark · star · halo · sigil

`jewelPath()` in `src/game.js` traces them and `paintJewel()` paints them. **The
same function draws a stone on a cape and in the menu's jewel track**, so the
row of cuts somebody is climbing towards is exactly the row they end up
wearing — the ladder is a picture of the reward, not a decorative stand-in.
(The track tiles are little canvases for that reason; they used to be one
CSS-clipped pentagon repeated twelve times.)

Adding a shape to `GEMS` means adding a case to `jewelPath` — that is the only
coupling, and a shape with no case falls back to a diamond.

A caution for anyone testing this: a shape's *glow* is much bigger than the
shape, so comparing tile images at a low alpha threshold compares haloes and
reports different cuts as identical. Threshold on solid pixels.

### How it moves, and why it cannot knot

**The state is one ANGLE per segment.** Not positions, not particles — angles.
That choice is what makes it well behaved:

* A segment is exactly `seg` long by construction, so the cloth can never
  stretch. There is nothing for a solver to fight over, and no iteration count
  to tune.
* The angle each segment may differ from the one ahead of it is **clamped**, at
  `min(0.26 rad, seg / halfWidth)`. Cloth folds through itself exactly when the
  spine turns tighter than the cloth is wide — so that turn is simply not
  allowed. Self-intersection becomes arithmetically impossible rather than
  merely unlikely.

Each angle eases toward the one ahead of it with a little inertia, which is what
makes the cape lag and then sweep round when the wizard turns. A slow travelling
wave rides down the length so it is never quite still — and the wave is applied
to the *target angle*, never to the point positions, because a wave applied to
points can kink the curve while a wave applied to a target cannot. When the
wizard is moving the rest direction leans into the direction of travel, so the
cloak trails the path rather than the facing.

The two hems are **derived** from the spine, never simulated.

An earlier version simulated the spine and both hems as three chains of free
particles stitched together. It moved beautifully right up until it didn't: free
hems can swing past one another, and once they cross, the outline folds through
itself and the cloth turns inside out. No amount of damping fixes that, because
nothing in that model forbids it. If you are tempted back toward free edges,
that is the failure to expect.

`RPW.capeOf(seat)` returns the spine, both hems, the segment lengths and **the
turn taken at each joint** — that last one is what lets a test assert the cap is
holding. The suite thrashes a cape through every direction with dashes and
checks that neither hem ever crosses itself.

### What it costs

Nothing measurable. Frame times with and without capes, same seeds, same
machine:

| | no capes | with capes |
|---|---|---|
| 2 wizards | 16.7ms | 16.7ms |
| 6 wizards, Apprentice | 43.1ms | 39.3ms |
| 6 wizards, Archmage | 153.0ms | 153.0ms |

**That 153ms was never the capes — and it was not the bot AI either**, which is
what this file said first and got wrong. See below.

**It is view-only and must stay that way.** It never touches the seeded RNG,
never reads back into the simulation, and appears nowhere in `RPW.hash()` —
two clients can disagree about the exact ripple of a cape without disagreeing
about the match. It is stepped from real elapsed time in `pump()`, not from the
fixed simulation step, so it stays smooth whatever the frame rate. Anything
here that started reading `rand()` instead of real time would desync a
multiplayer match.

`RPW.capeOf(seat)` returns the cloth as offsets plus each node's distance off
the straight line behind the wizard — that is what lets a test assert it
actually sways (3.4px at rest, 7.8px moving) rather than trailing rigidly.

## Maps: forest and castle

There are now two hand-laid arenas alongside the random one, chosen by
`matchCfg.mapPreset` and laid out in `MAP_PRESETS`. Both are mirror-symmetric
so neither seat gets the better half, and both keep the middle open — a map
that clutters the duelling ring turns every round into a game of hide.

**Forest** — six trees (indestructible, block shots and beams), four bushes
(soft cover: beams stop, shots pass), two logs and two stumps you can break,
one patch of rubble.

**Castle** — two statues and four pillars that never come down, two braziers,
four chests and two rubble piles that do.

The props are additive: they were appended to the prop table and deliberately
left **out of `SPAWN`**, so the random map generates exactly the arenas it
always did. That is why `npm run test:golden` still prints the same 20
fingerprints — the bots play precisely as before.

### The picker had to work in solo, and did not

Green picked Forest and got the same purple arena. The presets were gated on
`NET.active`:

```js
const preset = NET.active ? MAP_PRESETS[matchCfg.mapPreset] : null;   // was
```

so an arena choice only took effect once a stranger had actually joined the
room. Pressing **Start** in a room nobody joined called `resetOfflineCfg()`,
which threw the host's options away wholesale — map, fog, rounds and all — and
solo had no picker of its own to begin with. Three ways to choose a map, none
of which reached `makeMap()`.

The gate is gone. `matchCfg` is now set explicitly at the start of every match —
from the solo panel's own **Arena** row, from `hostOpts()` when a hosted room
starts locally, or from the relay's start message — so there is no stale preset
left to leak, which is what the gate was guarding against. Pressing `R`
restarts in the arena you are already standing in rather than resetting to
Random.

The determinism rig used to flip `NET.active` to reach the presets at all, which
meant the fixed-layout runs passed while the path a player actually takes was
broken. It now starts them the offline way.

### …and then the relay ate it anyway

Fixing the solo path fixed solo. Multiplayer still showed the ordinary arena,
because the relay sanitises the host's options server-side and its whitelist had
never been updated:

```js
mapPreset: ["random", "arena", "gauntlet", "crossfire"].includes(o.mapPreset)
  ? o.mapPreset : "random"            // was — in BOTH relays
```

An arena the relay does not recognise is rewritten to `"random"` with no error
anywhere: the host picks Forest, the relay hands every client Random, and the
room plays Random. Both `cloudflare/worker/src/index.js` and `server/rooms.js`
carried the stale list.

Chasing that turned up a second, larger hole. The node relay's `create` handler
never passed `msg.opts` to the room at all, and `config` never applied them, so
in that twin **no** host option — map, fog, rounds, lives — had ever reached a
match. The Cloudflare worker did it correctly. The twins had drifted apart on
the rules of the game they were relaying, and nothing tested it.

`server/test-relay.js` now pins the three lists together: every arena in the
client's `MAP_PRESETS` must survive a round trip through the relay, an unknown
name must fall back to Random, and the worker's whitelist must equal the node
relay's, which must equal the client's. Adding a map without updating a relay
now fails a test instead of silently playing somewhere else.

### Scenery is baked, not drawn

`bakeFloor()` is themed. Forest gets mottled earth, roots and grass tufts;
castle gets 80px flagstones, a red runner down the middle and torchlight pools.
The duelling ring is tinted to match — green in the forest, gold in the castle.

Every one of those decorations is drawn with **`vrand()`/`vrnd()`, the view RNG,
never `rand()`**. The floor is painted once per match from a stream the
simulation does not share, so two clients can have different-looking moss and
still agree on every frame of the fight.

Anything static then gets painted straight onto that same floor canvas:

```js
function bakedProp(d){ return d.hp === Infinity && !d.lift && !d.owner; }
```

Trees, statues and pillars are baked in at map time and skipped by the per-frame
draw loop. Only things that can move or break are drawn each frame. The brazier
flame flickers off `performance.now()` — view time — for the same reason.

## Playing across an ocean

Japan to Canada is about a quarter of a second, there and back. Three separate
things broke on that link, and only the first was a desync.

### 1. The relay threw healthy players out

`sweepStalled` drops a seat that has sent no input for six seconds AND is at
least `STALL_LAG` frames behind the room's furthest sender. `STALL_LAG` was
**2**.

Both halves of that were wrong over distance. A client in lockstep sends input
only when it takes a step, and it cannot step until its peer's input arrives —
so on a long link a perfectly healthy client sits silent for seconds at a time,
waiting. And two frames behind is ordinary jitter, not a straggler.

So the relay dropped somebody mid-match every few seconds. Now:

- a waiting client sends `{t:"alive"}` about once a second, which says "still
  here, just waiting" — silence and absence are no longer the same thing
- `STALL_LAG` is 30 frames, half a second, comfortably outside jitter

### 2. Different builds looked exactly like a desync

Two clients running different builds are two different programs. They diverge
within seconds and every symptom is indistinguishable from a netcode bug, which
sends you hunting the wrong thing while the fix is to press refresh.

The build each client is running — taken from the cache-bust on its own script
tag, so it changes every deploy — is now part of the handshake. A room that is
not all on one build **never starts**, and says so in its own words.

### 3. It played at ten frames a second

This is the one that decides whether a long-distance game is worth playing.

Lockstep cannot start frame F until every player's input for F has arrived.
Input is sent `DELAY` frames ahead — 3, fifty milliseconds — so nobody waits as
long as the round trip fits inside that. A quarter of a second does not fit
inside fifty milliseconds, so **every frame waited for the post**: 732 frames in
seventy seconds, about ten a second, in slow motion.

The delay now grows when a client is being made to wait and shrinks when it is
not, between 3 and 20 frames. Measured on a simulated 255ms link, same two
clients, same seventy seconds:

| | frames in 70s | effective rate |
|---|---|---|
| fixed 3-frame delay | 732 | ~10/s |
| adaptive | 3506 | ~50/s |

The cost is that your own key presses land further ahead — the trade every
lockstep game makes over distance, and much the better end of it than slow
motion. Near-zero latency still settles low and stays sharp.

It needs **no agreement between clients and no protocol change**: every `in`
message already names the frame it is for, so a client may send as far ahead as
it likes. It only has to fill the gap when it moves its horizon out, or it
leaves frames nobody ever sends and the whole room waits on them forever.

### The round trip, on screen

The lobby and the match HUD now show the measured round trip to the relay —
"347ms" — because it is the single number that decides how a long-distance match
feels, and until it was visible nobody could tell a slow link from a broken one.
Both relays answer a `ping` by echoing it straight back; the client smooths the
samples. In a match the frame loop drives it, and in the lobby a timer does, so
you know the number before you start rather than after.

Two things this makes answerable that were guesswork before: whether a match is
slow because of distance or because of a bug, and whether the relay is sensibly
placed for the people using it.

**And it is not, yet.** Every match in the world currently lands on a single
Durable Object — `idFromName('main-relay')`, one fixed name, therefore one
datacentre. A Japan-to-Canada game may well be crossing the Pacific twice: once
to reach the object, once to come back. Giving each room its own object near its
host is free and is the obvious next move, but it should be made when the ping
readout says it is worth making, not on a hunch.

### What the relay tests now hold

The live site runs the Cloudflare worker while every test drives the node twin,
so anything one learns and the other does not is a fix that silently never
ships. `server/test-relay.js` now checks that **the worker handles every message
verb the node relay does**, that both refuse a split-build room, and that both
agree on `STALL_LAG` — on top of a waiting client not being swept up and a
merely-lagging one not being dropped.

## The desync that was an accessibility setting

Two friends could not finish a match: it fell out of sync about seven seconds
in, every time. Nothing was wrong with the network.

`impact()` set **hit-stop** — a brief slow-down on a heavy hit — behind
`!REDUCED`:

```js
if (power >= 3 && !REDUCED){          // was
  hitStop = Math.max(hitStop, .035 + power*.007);
  ...
}
```

`REDUCED` is `prefers-reduced-motion`, an operating-system accessibility
preference. And hit-stop is not decoration: `simStep` reads it and scales `dt`
for the entire world.

```js
if (hitStop > 0){ hitStop -= dt; dt *= 0.14; }
```

So two players whose machines disagreed about "reduce motion" ran the same
frames with **different timesteps**. On the first hit of power 3 or more their
worlds parted company, and the relay — correctly — stopped the match. One
player with the setting on was enough to make the game unplayable for both, and
the two of them would never have found out why.

The fix is one line: hit-stop happens for everyone. The screen shake and the
colour flash, which are the things reduce-motion is actually for, still answer to
it, because nothing outside that client depends on them.

It shipped in the very first commit, and nothing in the repo could have caught
it: every determinism run booted both halves of the comparison the same way, so
`REDUCED` was equal on both sides by construction. `tools/determinism.js` now
boots one half with the preference on and the other with it off and requires the
same world, which fails at frame 180 with the original line restored.

That case is deliberately **bot-driven with no scripted keypresses**. This rig
wires `Math.random` to the same generator its input script draws from, so a run
with fewer view-only particles gets different keys pressed — a scripted version
of this test fails for a reason that has nothing to do with the game. Idle, the
only thing that can differ is the simulation.

**The general rule this is an instance of:** anything the simulation reads must
come from the seed or the input stream. Not the clock, not the window size, not
`Math.random`, and not a per-machine preference. View-only code may read all of
them freely — that is what `vrand()` is for — but the moment a value crosses
into `simStep`, it has to be the same on every machine or the match is over.

## Keeping multiplayer at full speed

Green reported the game feeling laggy online. It was, and not in the way it
looked. The measurement that mattered was not frames per second but **how much
simulation time the game managed per second of real time**:

| | before | after |
|---|---|---|
| 2 wizards | 100% | 100% |
| 6 wizards, Adept | 99% | 101% |
| 6 wizards, Archmage | **75%** | **98%** |

At 75% the match was running in slow motion. In a lockstep game that is
contagious: every other client has to wait on the slowest one, so one loaded
machine drags the whole room.

The cause was `pump()` doing a full render after every batch of simulation
steps, however far behind it had fallen. The fix lets drawing be skipped when
the simulation is behind, and caps how much backlog can accumulate:

```js
const STEP_CAP = 12; const MAX_BACKLOG = 12; const MAX_SKIP = 1;
```

`MAX_SKIP = 1` is the important bound — at most one frame is ever dropped in a
row, so catching up can never turn into a stutter. Drawn frame rate at 6
Archmage wizards is unchanged (13fps); what changed is that the fight underneath
now runs at real speed.

## Co-op survival

Escalation used to be a solo mode: one wizard, endless waves, no way to bring a
friend. It is now a game type the host picks in the lobby — **Duel** or **Co-op
survival** — and a solo run is simply a party of one, so both go down the same
code path.

The party shares team 0; the waves are the only thing on team 1. That matters
more than it sounds, because every rule that can hurt or aim at a wizard already
went through `team`:

```js
if (q.dead || q.team === s.owner.team) continue;   // shots
if (q.dead || q.team === d.thrower.team) continue; // thrown scenery
if (!firing(b) || b.clash || b.team === a.team) continue;  // beams
if (o.dead || o.team === w.team) continue;         // targeting, and Tab
```

So no friendly fire and no friendly targeting come out of putting the party on
one team, rather than out of new special cases. `tools/coop-test.js` proves it
by firing a real shot down the middle of the party and reading the health bars —
and, because a test that can only pass is worth nothing, it also fires the same
shot at a rival and fails if THAT does nothing either.

Being downed costs you the rest of a wave, not the run: the next set brings
every fallen ally back at 60% health, and the run ends only when the whole party
is down at once. Wave size scales with the party (`waveFor`) by adding rivals
drawn from the tiers already in the set, capped at 14, so four wizards meet a
bigger set rather than a nastier one — and `waveComp` itself is untouched, so a
solo ladder is exactly the ladder it always was.

### The desync this invited, and the test shape that catches it

Escalation was written for one player and it showed. Three lines read `you`:

```js
if (dist({x,y}, you) < 300) continue;              // where a wave spawns
you.hp = Math.min(you.hpMax, you.hp + 10 + ...);   // the kill reward
if (w.human){ escGameOver(); return; }             // and who ends the run
```

`you` is a different wizard on every client. A wave spawned relative to it lands
somewhere else on each machine; a kill heals a different wizard on each machine.
Both desync a lockstep match on contact.

The determinism suite could not have caught any of it. It ran the same match
twice **in the same rig**, so `you` was the same wizard in both halves and the
hashes agreed. What catches it is running the match from **two different seats**
and requiring the hashes to match — `co-op seats` and `co-op mixed` in
`tools/determinism.js`, both idle so the only difference between the two rigs is
which wizard is local. Reintroducing the spawn bug fails `co-op seats` at frame
180 while every same-seat case still passes.

`co-op mixed` (two idle humans, two ally bots, compared from two human seats)
exists because the kill reward only fires when something actually dies. It
caught the heal bug on some seeds and not others — a partial net, and worth
saying so rather than claiming a clean catch.

Two other things fell out of the same look:

- `makeWizard` now hands out a stable `id`. Wave rivals all carried seat 0, so
  nothing could name one of them — no test, no log line.
- `buildRoster` used to end with `you = wizards[localSeat]; you.human = true;`.
  `w.human` gates the AI, so a client whose seat index landed on a bot would
  stop running that bot's brain while every other client kept running it: a
  silent, one-sided desync waiting for the first roster where that could happen.
  The local wizard is now chosen from the seats that are already human.

## What is not built yet

Hats, capes, and making the jewels actually appear on the wizard. The profile
already carries `cosmetics: { unlocked: [], hat: null, cape: null }` so they can
land without migrating a single existing profile.

There is also no password reset — no email is collected. Ask before adding one;
it changes what the account is.
