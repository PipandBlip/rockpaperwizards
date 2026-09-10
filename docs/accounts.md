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

The delay is now **computed from the measured trip** rather than groped towards.

What has to fit inside it is not a round trip. It is the one-way hop from this
client to the relay plus the one-way hop from the relay to the furthest other
player — the journey a mask actually makes before somebody needs it. Each
client's own ping is twice its own leg, so the two halves come to
`(my ping + their ping) / 2`. The ping reply carries the furthest other player's
trip, so each client can work the whole thing out:

```js
const transit = (rtt + (peerRtt || rtt)) / 2;
return clamp(DELAY, Math.ceil(transit / (1000/60)) + JITTER_FRAMES, DELAY_MAX);
```

The first version only ever **ratcheted**: three frames up whenever a second held
more than 100ms of waiting, one frame back only after a whole second with almost
none. On a jittery long link that second never arrives, so it climbed to the
20-frame ceiling and stayed — 333ms of input lag on routes needing far less.
Measured, two clients 73ms and 361ms from the relay settle on 16 frames instead
of 20, and a local pair settles on 5.

The waiting signal is kept, but only as a safety net that can push *above* the
measurement when the link is worse than it looks. The delay still moves between
3 and 20 frames. Measured on a simulated 255ms link, same two
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

## A desync that names itself

The relay has always compared a checksum of the whole world once a second and
stopped a match when two clients disagreed. That check is correct and almost
useless. "You desynced" is the same sentence for a projectile bug, a scenery
bug and a wizard bug, and the only way to learn which one it was is to
reproduce it — which, on this game, means coordinating a session with a friend
nine hours away and hoping it happens again inside the seven seconds it usually
takes. The reduce-motion desync above cost exactly that, twice.

So each client now sends a checksum **per component** alongside the whole-world
one. `hashParts()` in `src/game.js` returns four separate accumulators:

| name      | what it covers                                    |
|-----------|---------------------------------------------------|
| `wizards` | every wizard's position, health, mana and facing  |
| `spells`  | the projectiles in flight                         |
| `scenery` | the destructible debris                           |
| `rolls`   | the frame counter and the seeded RNG's state      |

When the whole-world numbers split, the relay works out which of those four
split with them and puts the names in the `desync` broadcast. The client turns
them into a sentence a player can read:

> Two players stopped agreeing about the state of the arena, so the match was
> stopped rather than left to drift apart. What stopped matching: the spells in
> flight at frame 120. Host or join again to play on.

A player reads that and knows it was not their connection. We read it and know
which function to open. The next report is worth something on its own, which is
the whole point — no second coordinated session required.

Three things about it are deliberate:

- **`hash()` is untouched.** Its exact value is what `tools/net-round-test.js`,
  `tools/determinism.js` and `tools/golden.js` compare against, and the parts
  are a diagnostic riding alongside, not a replacement. A component checksum
  covers less than the whole-world one, so a split that no part explains is
  possible; the report says the worlds parted company and names nothing rather
  than guessing.
- **A client that sends no parts makes the report unnamed, not agreed.** An old
  build in the room is a missing measurement. Treating silence as a match would
  name the wrong component, and a wrong name is worse than no name — it sends
  the next hour of work into the wrong file.
- **The name list lives in three files and is pinned in tests.** `HASH_PARTS`
  in `server/rooms.js` and `cloudflare/worker/src/index.js` must be equal, and
  every name in it must be something `hashParts()` actually measures and
  `DESYNC_WORDS` can say out loud. A name present in only two of the three
  produces a report nobody can read.

`tools/desync-parts-test.js` proves the pointing is accurate rather than merely
present: two worlds on one seed agree on every component, a spell fired into
only one of them names the spells **and only the spells**, and a wizard hurt in
only one names the wizards without blaming the rolls. `server/test-relay.js`
covers the relay's half — junk in the parts field, a missing parts field, and
worker/node parity — and the whole loop was then driven in a real browser under
the real CSP with a real relay: two clients, one of them lying about its spells
from frame 120, and the honest client read back exactly the sentence above.

## The cape was stiff because I got a damping ratio backwards

The capes moved. They lagged, every joint peaked later than the one above it,
and `tools/cape-test.js` said so in four different ways. They still read as a
plank on a slow hinge, and the reason was one number with its sign of intent
reversed.

Each joint is a damped spring towards where its neighbour points. Two numbers
decide how that reads: the spring rate, and the **damping ratio** — how much of
a swing survives to become the next swing. Below 1 a joint overshoots its rest
angle and comes back. At 1 and above it can only creep towards rest and stop.

The intent was "looser towards the hem". What got written was a spring rate
falling from 30 to 13 — right — and a per-frame damping multiplier falling from
0.895 to 0.82, which *raises* the damping. Worked back into ratios:

| down the cape | spring | damping ratio |            |
|---------------|--------|---------------|------------|
| collar        | 30.0   | 0.61          | underdamped |
| a quarter     | 25.8   | 0.78          | underdamped |
| halfway       | 21.5   | 0.99          | on the edge |
| three-quarter | 17.3   | 1.27          | **cannot overshoot** |
| the hem       | 13.0   | 1.65          | **cannot overshoot** |

Everything past the middle of every cape in the game was mathematically
incapable of follow-through. The floppiest-looking part was the one part that
could not swing past anything, and no amount of driving it harder would have
changed that.

The damping ratio is now stated as a ratio (`CAPE_ZETA_TOP` 0.88 →
`CAPE_ZETA_TIP` 0.26) instead of falling out of a per-frame multiplier, because
a number nobody can read is a number nobody checks.

### And it was never being thrown

The chain followed a rest direction derived from facing and speed. That lets it
trail; it does not let it be thrown. Every whip and flare a real cape has comes
from its pivot *accelerating* underneath it — a stop throws the hem forward
past the body, a hard turn throws it wide — and none of that was modelled.

Now the collar's acceleration is felt as a torque about each joint (the
component across the segment throws it, the component along it does nothing),
weighted towards the hem. Acceleration is taken as the gap between the wizard's
velocity and a smoothed copy of it, which is a usable signal without
differencing a position twice; it is capped, because a respawn is a teleport and
not a sprint.

### What the numbers say now

|                                  | before | after |
|----------------------------------|--------|-------|
| total bend swing through a whip  | 0.26 rad (15°) | 1.22 rad (70°) |
| per-joint bend range, collar→hem | flat ~0.25 | 0.17 → 0.43 |
| hem joints able to overshoot     | none | all |
| cost, six wizards at rung 14     | 0.78 ms/frame | 0.93 ms/frame |

The first row is the one that matters. A cape whose joints all move while their
SUM stays fixed is holding one shape and sliding it around — 0.26 rad of total
variation across six joints is one joint's worth, spread thin. That is what a
plank looks like from the inside.

### Two things the test suite could not see

**Lag is not fluidity.** Every existing cape test asked about lag, which a plank
on a hinge also has. The four added in "cloth, not a hinge" ask about the rest:
that the damping ratio is under 1 everywhere (read from the source the rig
actually booted — an earlier version of this test read `src/game.js` off disk
and so cheerfully passed the old build), that the total bend genuinely varies,
that neighbouring joints stay part of one curve rather than fighting each other,
and that there is life in it while the wizard stands still. Three of the four
fail on the shipped build. The fourth is honestly a guard, not a regression
test, and is labelled as one.

**A fold is not the only way to ruin an outline.** The first attempt at this
used eleven nodes of 3.5px instead of eight of 5–6.8px, for a smoother curve.
The hems are drawn by offsetting the spine sideways by the cloth's half-width,
and the old anti-fold rule capped each joint's bend so the spine's radius never
fell below that half-width. That is exactly the limit at which the edges do not
*cross* — and also exactly the limit at which the inside edge's radius reaches
*zero*, so every point along it lands on the same spot. Shorter segments walked
right up to it. The cape was drawn with a bite taken out of its collar, and
every test passed, because they all asked about crossing.

The rule now keeps a real radius on the inside (`CAPE_FOLD_MARGIN`), the
segments went back to a length that leaves it headroom, and the thing that
catches it is a spacing measurement: an inside edge that is still a curve keeps
a real fraction of a segment between its points, and a collapsed one goes to
zero. Both new tests fail on the version that drew the bite.

`tools/cape-feel.js` is the instrument all of this was read off; `npm run
test:feel` prints it. `tools/cape-strip.js` draws the silhouette frame by frame
with the old build beside the new one, because the numbers above were what
convinced me the last version was fine.

## Playing it on a phone

A phone opening the site now gets thumb sticks; a desktop gets exactly what it
always got. The switch is `pointer: coarse` **and** a non-zero
`maxTouchPoints`, overridable with `?touch=1` or `?touch=0` — detection is a
guess, and a guess you cannot override is a bug report nobody can act on. On a
desktop nothing is created, no pointer listener is registered, `drawPad()`
returns on its first line, and no CSS rule below `html.touch` can reach the
page.

### The controls are the keyboard, wearing different clothes

The obvious mobile port is a grid of buttons. Six 48px targets under one thumb
is how a phone player loses every duel to a laptop.

So the right thumb gets a **stick**, and the six spells sit in sectors around
it, arranged to copy the keyboard exactly — y u i across the top, h j k across
the bottom — so learning one teaches the other:

              Spark      Rive     Hexstone          y   u   i
                   \      |      /
                    \     |     /
              Ward ——     ●     —— Grasp            h   j   k
                          |
                        Beam

Push and let go quickly and you get a quick cast; push and hold and it charges,
firing when you let the stick go.

That is not a special case anybody had to write. **Engaging a sector presses
that spell's key and releasing lifts it**, so a flick is a short hold and a hold
is a long one, and `applyMask()`'s existing press-edge/release-edge handling
does the rest. Which is the whole point of the design:

- Touch sets the same `keys[]` and `tapped[]` entries a keyboard sets.
- `localMask()` reads them the way it always has.
- The twelve-bit mask that goes on the wire is **indistinguishable** from a
  desktop player's.

So the simulation, the netcode and the relay never learn that phones exist,
determinism is untouched, and a phone can duel a laptop. The input mask being
purely digital — eight-way movement, six spell bits, dash, target cycle, and no
aim angle anywhere, because aiming is automatic — is what made that possible.
An analog aim would have needed a wider mask and a protocol change.

Two details worth keeping:

- **The spell locks once the stick engages.** Letting the sector follow the
  thumb sounds helpful and is not: sliding across a boundary mid-charge would
  fire the spell you were charging and begin one you never asked for, which
  reads as the game casting at random. One push, one spell.
- **The charge ring tells the truth.** Beam and Grasp have `maxChg: 0` — Beam
  is a channel you hold open, Grasp is something you are carrying. Neither gets
  a charge sweep it does not have; they get a breathing ring instead. Drawing a
  progress bar for a quantity that does not exist is inventing a number.

### Dash is the outer ring

Dash is: push the stick out until it touches its outer ring. It goes the way you
pushed, and only if the cooldown has come back.

Two earlier versions were worse, and both failed for the same underlying reason.
A double tap made you lift your thumb at the exact moment you were trying to
move. A stutter — shove, ease off, shove again — kept the thumb down but was
fiddly to perform, and it fought the game: movement here is **digital**, eight
directions on or off, so there is no reason at all not to rest the stick at full
stretch, and a gesture built out of magnitude has to fight that habit. The rim
is the honest version of the same idea. One motion, visible on the stick, and
reaching it is a decision rather than a flourish.

The trigger is 0.92 of the stick's radius, and it re-arms only after the stick
comes back inside 0.70. Two consequences worth stating:

- **Resting against the ring spends one dash and no more.** Without the re-arm
  rule, a thumb parked at the rim would fire a dash by itself the instant the
  cooldown returned, with nothing having moved.
- **A fresh touch starts disarmed.** Grabbing for the stick and landing wide of
  the rim cannot dash; the thumb has to be inside once first. A dash you did not
  ask for is worse than one you have to ask for twice.

Being refused on cooldown still consumes the push, for the same reason: a
refusal that stayed armed would fire later on its own.

The cooldown is the ring itself. It fills as the dash recovers and lights in the
wizard's own tint when it is available, so "the ring is live" and "the ring is
the button" are the same fact. A refused push pulses it red. It reads
`1 - dashCool / DASH_CD`, the same number the desktop's dash card uses.

The knob's travel is scaled so its EDGE meets the ring at exactly the magnitude
that triggers a dash. The first version clamped the knob at 0.62 of the radius,
which put the rim it was supposed to touch permanently out of reach — a control
whose gesture you cannot see is a control nobody finds.

Target cycle and pause are the two small buttons.

### Landscape only, and it says so

The arena is 960x620. In portrait that is a strip across the top third of a
phone, and a player who can see less of the fight than their opponent is not
playing the same game. Portrait gets a rotate screen instead, and the pad stops
taking input while it is up.

### Two layout bugs worth remembering

**`display` beats `hidden`.** `.rotate` sets `display:flex`, which outranks the
UA stylesheet's `[hidden]{display:none}` — so `el.hidden = true` left the rotate
screen sitting over the game in landscape, blocking every touch, while the
JavaScript state said it was hidden. The assertions all passed; a screenshot is
what caught it. This is the second time this exact trap has cost this project a
working screen — the Rounds and Lives sliders were the first. **Any author rule
that sets `display` must restate the hidden case.**

**A percentage height inside a percentage height is nothing.** `.stage` had
`height:100%` and its only child `canvas#game` had `height:100%`: the parent
asks the child, the child asks the parent, and both settle on zero. The arena
collapsed to its two border pixels. The stage takes its height from `flex:1`
with `min-height:0` now.

### The menu had to become a screen

The first real-phone screenshots showed every menu title sliced off at the top,
and no way to scroll up to it. The emulator had never shown it, for one reason:
a phone in Chrome landscape gives up most of its height to the URL bar. A
Pixel 7 profile in Playwright is 839x412; the same phone in real Chrome is
about 915x300. The menu lived inside the arena's picture frame, and at that
height the frame is roughly 250px tall — less than the menu needs.

What made it unreachable rather than merely cramped was `fitCurtain()`. It
shrank overlong content with `transform: scale(k)`, and a transform does not
change layout: the box stays its original size and the scaled content spills
equally above and below it. Nothing can be scrolled to above zero, so the title
sat outside the box forever. The scale also had a 0.55 floor, so past a certain
amount of content it stopped helping at all.

On a phone the menu is now a **screen** rather than a panel: fixed to the
viewport, anchored to the top, scrolling honestly when it has more to say than
fits, and `fitCurtain()` returns early on touch so it keeps its hands off. Every
panel change resets `scrollTop`, or a tall panel leaves the next one opening on
its own middle.

Two things fell out of it:

- **It sits above the pad** (z-index 50 against the pad's 40), so thumb sticks
  can never show through a menu whatever the game believes it is doing behind
  it.
- **The How to play bar had to be raised above it** (z-index 55), or a
  full-screen curtain buries the one control that is meant to sit under it and
  the manual becomes untappable on the menu. There is a hit test for exactly
  that: `elementFromPoint` on the middle of the bar has to come back as the bar.

`TOUCH` also moved to the top of `src/game.js`. `fitCurtain()` and `show()` both
consult it and both are defined hundreds of lines above the pad code, and a
`const` read before its declaration has run is a ReferenceError, not
`undefined`.

`tools/phone-check.js` now sweeps 915x411, 915x300 and 915x260 and checks every
panel's title is inside its box and every panel opens at the top. That sweep
fails nine times on the build that shipped before it.

### Held Spark repeats, on a phone only

Spark is the cheap fast one, and on a keyboard you use it by mashing Y. A thumb
on a stick cannot mash: firing twice means pushing out, coming back inside the
deadzone, and pushing out again. So on a phone, holding the Spark sector repeats
it rather than charging it.

The important part is what this is **not**. It is input synthesis: the pad lets
the key go and presses it again, which is the same stream of press and release
edges a desktop player produces by hand. `applyMask()` sees nothing unusual, the
twelve-bit mask on the wire is identical, and neither the simulation nor the
relay learns a thumb was involved. It cannot desync a match, and it needed no
protocol change. Every other option — a rule inside `beginCharge`, a per-device
fire rate — would have put a device difference inside the lockstep simulation,
which is the one place a device difference must never be.

It needed no cooldown either, because mana already is one. Each Spark costs 9
against a 17/s regen, and the regen drops to 6/s while a spell is charging.
Measured on a phone profile, holding Spark gives **twelve shots in the first two
seconds** — about what a full bar buys — and then settles to roughly one a
second. The burst is real and the sustain is not.

Two details that would each have broken it:

- The re-press waits for `castLock` to clear rather than running on a fixed
  period. `beginCharge()` returns early while that lock is up, so a press timed
  inside Spark's 70ms lock is swallowed and every other shot goes missing.
- `padRapid()` is called ABOVE `pump()`'s draw-skip return. Below it, a busy
  frame drops the repeat, and dropped input is input the player will swear they
  gave.

`tools/phone-check.js` holds Spark for a second and counts casts by watching
mana step down, holds Rive the same way and requires exactly one, and — the
guard that matters — holds Y on a **desktop** context and asserts the wizard is
mid-charge rather than re-firing.

### How to play, on a phone

The manual is still there, because a player who cannot find out what Hexstone
does is playing a worse game. But the page is exactly one screen tall on a
phone and the arena fills it, so the manual cannot live in the flow: the
`<summary>` is a slim bar under the arena, and opening it lifts the body out of
the flow entirely into a fixed, scrollable sheet over everything. No JavaScript
does the toggling — `<details>` already does, which keeps it working under a
CSP with no inline script.

**Only the steps that name a control are told twice.** Steps one and two are
the only places the manual says how to do anything, so they carry both wordings
— `.by-key` for a keyboard, `.by-touch` for thumbs — and CSS shows whichever
the device is. A phone told to press Shift is a phone told a lie.

Step three is the same list on both. Only its key badges are keyboard-only:
"Y" means nothing to a thumb, but the spell it names means everything, and
"Hexstone plows through weaker spells and the Ward" is as true on glass as on a
keyboard. Keeping the split to the two steps that need it keeps the number of
places the same sentence can drift down to two.

The phone copy is deliberately terse — "Move with the left stick. Dash by
touching the outer ring with the left stick — 3 second cooldown." — and that
"3" is checked against `DASH_CD`. A number written into prose goes stale in
silence.

**Opening it lets go of the sticks.** The sheet covers the whole screen, so
without that, scrolling the manual would be a thumb dragging the movement stick
and the wizard would walk into a wall while you read about walking.
`padPlaying()` is false while it is open, and a `toggle` listener calls
`padClear()` so nothing stays held down. There is a test that walks the wizard,
opens the manual mid-stride and asserts the wizard stopped being told to move.

### What is checked, and where

`tools/touch-test.js` (in `npm test`, no browser) checks the arithmetic that can
be quietly wrong: every angle maps to exactly one spell, all six own an even
sixth of the circle, each sector is centred on its own label rather than
straddling it, the eight directions press the right keys, and no push ever
presses two opposing keys. It also drives the dash gesture directly through
`RPW.padPush(fraction, ready)`, which returns what happened — `armed`, `inside`,
`held`, `cooldown` or `dash` — so the arming rules and the cooldown gate are
checked without a pointer or a canvas, including the boundary against the rim
value the drawing scales itself by. And it asserts the headless rig is **not**
detected as a touch device.

`tools/phone-check.js` (`npm run test:phone`, needs playwright and a served
copy) drives a real browser with a real touchscreen profile: a desktop context
gets no pad and no touch class, the arena uses most of the screen, pushing the
stick moves the right way, holding charges and releasing casts — proven by mana,
since `cast()` spends `cost * (1 + level)`, so a hold must cost measurably more
than a flick of the same spell — pushing out to the ring dashes and empties it,
walking the stick partway out does not, sweeping it right round inside the ring
does not, and holding it against the ring through a full cooldown does not dash
a second time. Portrait shows the rotate screen and stops accepting input. The
How to play bar sits under the arena and on screen, starts shut, opens into a
scrollable full-screen sheet, freezes the sticks while it is up, releases a
stick that was mid-walk, hands the game back when shut, shows the stick wording
and not the key wording (and the reverse on a desktop), drops the six key badges
while keeping every spell and its description, and states a cooldown that
matches `DASH_CD`.

Two mechanical notes for anyone editing that file or those steps. Reading the
manual's text needs `textContent` rather than `innerText`: it starts shut on a
phone and `innerText` renders nothing inside a closed `<details>`, so an earlier
version of that check compared an empty string and passed for the wrong reason.
And `.steps .step-txt b` is the step-title rule, counter and all — so a `<b>`
anywhere in a step's prose becomes a numbered heading in the middle of a
sentence. The cooldown figure is a `<span>` for that reason, and there is a test
asserting it still renders inline with no counter. That is the third time a bare
element selector inside `.steps` has caught something new; check what the block
already claims before adding an element to it.

Two things that cost time in that file and are worth knowing before editing it:
the arena preset puts a prop immediately beside the left spawn, so a dash
measured in a fixed direction can fire and move nobody — which looks exactly
like a dash that never fired, and it sent me looking for a restart bug that did
not exist (menu starts and fresh rounds are fine; only the direction was wrong).
It probes for open ground now. And the rings the sticks wear are drawn outside
the sticks, so the layout margin has to clear the RINGS, not the sticks.

## The lobby stopped explaining itself

The lobby had one job — who is coming? — and it answered in a paragraph:

> Send the code to your friends. 3 seats are still empty; starting now fills
> them with Adept bots. · 106ms to the relay (fine)

Every clause of that is true and every clause of it is also on screen somewhere
else, or could be. Worse, the seat count is a number inside prose that changes
while you are reading the sentence containing it, and the round trip changes
about once a second. A sentence that rewrites itself is not a sentence; it is a
readout wearing a sentence's clothes.

So the paragraph is gone and its three jobs are split three ways.

**The seats are blocks.** `renderRoster()` draws one block per seat with a
class saying what it is: `open` for an empty seat, `here` for somebody who has
arrived, `ready` for somebody who has pressed Ready, plus `me` on your own. The
class is the colour — dashed and dim for open, `--hex` amber for here, `--ward`
green for ready — and the block carries the player's name and a person icon, or
a bot icon on an empty seat, because an empty seat is not nothing: it is the
bot you will be playing with if nobody takes it. The tag under the name says
the one thing left to do (`waiting`, `ready`), and says `hosting` on the host's
own block, because the host presses Start and is never asked to ready up. Three
seats' worth of prose became a row you can count without reading.

The icons are built with `createElementNS` against `SVGNS` and the path data in
`ICON`, not with `innerHTML`. The page runs under a strict CSP and `innerHTML`
on an SVG namespace is a reliable way to produce an element that exists,
matches selectors and draws nothing at all.

**The note is now only for errors.** The element survives — it is still where
`netFail()` puts "that room is full" — but `hostNote()` clears it and `.note`
carries `.note:empty { display: none }`, so a lobby with nothing wrong has no
paragraph and no gap where one used to be. The static sentence came out of
`index.html` as well as out of the JavaScript: `hostNote()` only runs on a net
change, so leaving the fallback text in the markup meant the old sentence was
still the first thing on screen, for as long as it took the relay to answer.

**The round trip moved to the corner of the arena.** `#pingTag` sits absolutely
positioned at the top right of `.stage`, over the canvas, in the lobby and in
the match alike. `pingWord()` turns the number into a judgement (`sharp`,
`fine`, `long, but playable`, `very long`) so it reads without a benchmark, and
`paintPing()` returns early unless the number actually moved, because
`syncHUD()` calls it every frame.

That early return is also why the lobby needed `startPingBeat()`. In a match,
`syncHUD()` repaints constantly. In a lobby the only repaints are roster
changes, and the first round-trip sample arrives a second or two after the room
opens — so on a quiet lobby the corner sat blank until somebody happened to
join. A one-second interval fixes it and costs nothing, because the paint
returns early on every tick where the number has not changed.

### A round trip of zero is not a missing round trip

Writing the readout turned up a real bug behind it. `RPW.NET.rtt()` returns 0
to mean "not measured yet", and the smoothing was written as:

```js
rtt = rtt ? rtt * 0.7 + sample * 0.3 : sample;
```

`Date.now()` counts whole milliseconds. On a relay in the same building the
sample is literally `0` — so `rtt` is set to 0, and the `rtt ?` guard then reads
that as "still no measurement" on every sample afterwards, forever. The readout
hid itself precisely when the connection was at its best.

The fix is to stop making one variable carry two facts. `rttSeen` is a boolean
that says whether a sample has ever landed; `rtt` carries only the number; and
`RPW.NET.rtt()` reports `Math.max(1, Math.round(rtt))` once a sample has
landed, because a measured round trip must never come back as the same value
that means silence. The test asserts `/[1-9]\d*ms/` rather than `/\d+ms/` for
the same reason — the old pattern would have passed on `0ms`.

### tools/lobby-check.js

None of the above is reachable from the headless suites: it needs a real relay,
two real clients and a layout. `npm run test:lobby` (playwright, plus
`node server/server.js` and a served copy) opens two browser pages, hosts a
four-seat room on one, joins and readies on the other, and asserts the panel
order, that the note says nothing and occupies no space but would still show an
error, each seat's state as it changes, that open/here/ready compute to three
different border colours — by eye, not only by class name — and that the round
trip sits in the arena's top right, in the lobby and once the duel has started.

One trap worth knowing before writing any timer-driven assertion across two
Playwright pages: **Chromium throttles a background tab's timers to about once
a minute.** The host's keepalive is a 2-second `setInterval`, so while the
joiner's page is the one in front, the host page never pings, never measures a
round trip, and shows an empty corner. That is the harness, not the game — a
host looking at their own lobby is looking at it — and the check calls
`bringToFront()` before it measures. I spent a while fixing a rounding bug that
was real but was not this one.

## The desync that was a browser cache

Green and a friend in Canada could not finish a match. The report named the
component — "the scenery at frame 540" — which is exactly what the component
hashes were built for, and it sent me straight into the simulation. It was not
in the simulation.

What made it findable was one sentence from Green: *it used to work, and I think
it was before the capes.* A regression with a date attached is a different
problem from a mystery. It ruled out physics I had not touched and ruled in
anything that changes when a deploy happens.

### First: prove it is not the netcode

Every networked test in this repo delivered messages the instant they were sent.
That is a LAN with the cable removed — and it is why the suite stayed green
through a bug that made the game unplayable across the Pacific. So
`tools/lag-test.js` puts the two clients on a real link: a configurable one-way
delay, jitter, and a frame rate per client, because the interesting case is not
two identical machines but one that holds 60fps and one that does not.

Two things about that harness are worth keeping.

A WebSocket runs over TCP, so a connection **delivers in the order it was
written**. My first version gave every message an independent delay and sorted
by arrival, which let a late lobby sync overtake a match start — and it duly
"found" a bug that cannot happen. Each direction now keeps its own arrival clock
and nothing may land before the message in front of it. An unordered link does
not model the internet; it models a different, easier internet that reports
failures the real one never will.

And a run that never disturbs the scenery proves nothing about the scenery. The
scripted players cast Grasp and Hexstone specifically so crates get thrown and
smashed, and the test prints how many distinct scenery states it saw — a green
result off four states is not evidence.

Thirty-two combinations of latency, jitter, frame rate, bot count and seed: all
in lockstep, at speed. The simulation and the netcode were fine. Which left the
one thing the harness cannot vary, because it loads one file into both
sandboxes: **whether the two clients are running the same program at all.**

### The actual cause

Two headers, from the live site:

    index.html      cache-control: public, max-age=0, must-revalidate
    src/game.js     cache-control: public, max-age=14400, must-revalidate

The page is always fresh. The code is cached for four hours. The only thing
holding two players on the same program is the `?v=` cache-bust in the script
tag — a number a human has to remember to change.

Forget it once, and:

- the player who opened the game an hour ago runs the file their browser saved;
- the player opening it for the first time today runs the new one;
- both read `game.js?v=59` off their own script tag and **truthfully report
  build 59**;
- `buildSplit()` sees one build, the room starts, and two different programs
  play in lockstep until the changed code is reached.

That is every fact Green gave me. It has nothing to do with distance; distance
only correlates, because two people in one room share a deploy and two people on
opposite sides of the world open the game hours apart and never share a cache.
It explains why it "used to work" — before deploys became frequent — and why
every determinism test passes, because each build is perfectly deterministic on
its own. And it is not hypothetical: I nearly shipped it in the same session I
found it, by leaving `?v=58` on a tree whose `game.js` had changed, while the
live site was already on 59.

### The fix: ask the code, not the version

`currentBuild()` now fetches the client's own scripts with `cache: "force-cache"`
— which returns the bytes the browser actually has, rather than whatever the
server holds now — and fingerprints them. The id becomes `"60.12s9fa7"`: a
version tag a person can read, and a hash that makes the claim true. A version
number cannot detect this class of failure, because the version number is the
thing that is wrong.

Three details that matter:

- **It always settles.** No `fetch`, a blocked request, or a hostile cache all
  end as `null`, and the client falls back to the bare tag.
- **A client with no fingerprint is not locked out.** `buildsDiffer()` compares
  version tags always, and fingerprints only between clients that have one.
  Silence is not evidence of a mismatch, and trading a rare desync for a common
  lockout is a bad trade.
- **The hello is sent twice.** Once immediately with the tag, so nothing waits
  on a fetch to reach the lobby, and again when the fingerprint resolves. A room
  is checked when it STARTS, which is many seconds later.

`cleanBuild()` on both relays had to stop stripping everything but digits — it
would have thrown the fingerprint away and left the check exactly as weak as
before. Both twins changed together, and there is a test asserting the id
survives the relay intact.

Deploy the worker before Pages, as usual. It is safe in that order: an old
worker sanitising a new client's `"60.abc"` down to `"60"` just restores the old
behaviour, which is where we already were.

### And then remove the reason it could happen — this part does NOT work

The fingerprint detects a mismatch. It does not prevent one, and being told to
hard-refresh is still an interruption. So `/src/*` was given a revalidating
cache rule in `cloudflare/pages/public/_headers`:

    /src/*
      Cache-Control: public, max-age=0, must-revalidate

**It has no effect.** Cloudflare Pages ignores `Cache-Control` from `_headers`
for its static assets, whatever the documentation's example implies. Everything
else in that file works — the CSP is served on both domains — so the file is
deployed and read; it is this directive specifically that is dropped.

Getting to that took two wrong answers, and the second is the instructive one.

My first note said "the rule isn't landing" and guessed at an undeployed file.
Hermes then checked both domains, found `/src/game.js` served `max-age=0` on
`pages.dev` and `max-age=14400` on `blipgaming.ca`, and concluded the rule lands
on Pages' own domain and is overridden by a zone-level cache setting on the
custom one. That is a reasonable read of those two numbers, and it is wrong.

The measurement that settles it samples a path the rule does **not** cover:

                    /src/game.js   /assets/audio/*   /favicon.svg   /
    blipgaming.ca         14400             14400          14400    0
    pages.dev                 0                 0              0    0

The value tracks the **surface**, not the rule. Everything non-HTML is four
hours on the custom domain and zero on `pages.dev`, whether `/src/*` covers it
or not. `pages.dev` was never honouring the rule — it serves `max-age=0` for
everything, which happens to be the value the rule asks for. Sampling only
inside the rule's scope made a coincidence look like a confirmation, and sent us
looking for a zone cache rule that does not exist.

That is this session's recurring failure in its purest form: a green result that
proves nothing reads exactly like one that proves everything. The fix is always
the same — include the case that can tell the hypotheses apart. Here that is one
extra fetch of a file the rule was never supposed to touch.

**Nothing needs doing about it.** This half was only ever the belt to the
fingerprint's braces: a stale copy is still caught and announced before the
match starts, and the version tag moving each deploy handles the ordinary case.
If the four-hour window is ever worth closing, the levers are a Cache Rule on
the zone or a Pages Function — `_headers` is explicitly not applied to Function
responses — and a Function in front of the game's own scripts is more risk than
this problem currently justifies.

### What is checked

`tools/build-test.js` (in `npm test`) boots clients in separate contexts, each
serving its own source back to its own `fetch` — which is what a browser cache
is — and asserts that one changed simulation constant produces a different
build, that identical clients agree, and that a client which cannot fingerprint
itself still plays.

`tools/stale-cache-check.js` (playwright plus the relay) is the whole thing end
to end: the same page on two origins under the same version tag, one byte of
simulation code apart, through the real relay, under the production CSP. It
asserts the match is refused, that both players are told they are running
different copies rather than being shown a desync, and that the CSP permits the
fingerprint fetch — a `connect-src` that forbade it would fail silently and
forever.

It also runs the same scenario against a patched client with the old
version-only check, and asserts that one **starts the match**. A test that
passes with and without the fix is not evidence, and this repo has been caught
by that twice: an `innerText` comparison that passed on an empty string, and a
no-fold cape assertion that only checked joint angles.

## The desync that was Math.sin

With the build fingerprint in, three players — Virginia, Canada, Japan — could
play a full match against three bots. Until two of them pointed the red beam at
each other. Then, reliably, the worlds came apart, and the report almost always
said **the scenery**, several thousand frames in.

A trigger you can reproduce on demand is worth more than any amount of reading,
and this one named the culprit.

### +, -, *, / and sqrt are exact. sin and cos are not.

The ECMAScript spec requires the four arithmetic operators and `Math.sqrt` to be
**correctly rounded** — given the same doubles they return the same double on
every engine, forever. It does not require that of `sin`, `cos`, `tan`, `atan2`,
`hypot`, `exp`, `pow` or `log`. Those are *implementation-approximated*: an
engine may return any value within a small error bound, and V8, SpiderMonkey and
JavaScriptCore genuinely disagree in the last bit.

In a lockstep game every client must compute the same world from the same
inputs. `game.js` called those functions 137 times.

### Why the beam, and why the scenery

Most of the game shrugs off a last-bit difference. Positions get clamped to the
arena, hits are threshold comparisons, a spell either connects or does not — the
difference has to grow by a factor of a trillion before any branch changes, and
usually it is washed out first.

The beam clash does the opposite. The orb's position along the line between two
wizards is `t`, and `t` is:

- **carried from frame to frame** — it lives in the `clashes` array, not
  recomputed from scratch;
- **slid, never snapped**, toward a target derived from both wizards' mana;
- **unquantised** — nothing rounds it back to a grid.

That is a feedback loop with memory. It does not wash a small difference out, it
holds it and grows it. A few seconds later the two clients disagree about `t` in
the third decimal place, so `a.beamLen = sep*t` differs, so the beams reach
different distances — and an unopposed beam **burns whatever stands in it**. The
two clients burn different props. The scenery hashes part company, and that is
what the player is told.

The measurement, in `tools/lag-test.js`, with one client's trig deliberately one
ulp out on a fraction of results:

    beams flying:   DIVERGED at sim frame 847 — scenery   (seeds 1, 2, 3)
    no beams:       PASS, every seed, same perturbation

Same link, same perturbation, same seeds. The clash is the amplifier.

It is also worth knowing that `hash()` mixes `(v * 1000) | 0` — it truncates.
So a divergence is invisible to the checksum until it exceeds a thousandth of a
pixel, which is why the match plays fine for minutes and then reports a desync
that has in fact been growing for a while.

### The fix: the simulation does its own trigonometry

`SIN`, `COS`, `ATAN`, `ATAN2`, `HYPOT`, `LN`, `EXP` and `POW` at the top of
`game.js`, built only from `+`, `-`, `*`, `/` and `Math.sqrt`. They are
fdlibm-derived: Cody-Waite range reduction with pi/2 split into an exact high
part and a low correction, then minimax polynomials.

Accuracy was never the problem — **agreement** was — but they land within about
one ulp of native anyway:

    SIN    worst relative error 2.2e-16      ATAN2  2.2e-16
    COS    2.2e-16                           HYPOT  bit-identical to V8
    EXP    2.2e-16                           POW    2.6e-15

One thing that bit me on the way: a single polynomial for `atan` over the whole
range is **3e-3** out near |x| = 1. That is not a last-bit difference, it is a
different answer. The interval split with a per-interval hi/lo constant brings
every input back to one ulp. Check the error against native before believing a
polynomial.

`**` went too: `Number::exponentiate` is also implementation-approximated, so
`(a.x-b.x)**2` became a multiplication — which is exact, and faster.

`Math.min`, `max`, `abs`, `floor`, `ceil`, `round`, `sign`, `imul` and `sqrt`
are all exactly specified and stayed. `Math.asin` and `Math.acos` stayed too:
they are used only to draw the fog shadow and the ward arc, and nothing outside
this client depends on where a pixel went.

### What it costs

    native Math            1.268 ms per frame   (6 wizards, sim + draw)
    deterministic math     1.461 ms per frame

About 0.19ms a frame at the heaviest configuration, inside a 16.7ms budget.
`HYPOT` and `ATAN2` are actually FASTER than native; `SIN` is the expensive one,
at roughly four times the cost of V8's.

The drawing does not need to be deterministic and could go back to native
`Math` — the capes are by far the biggest consumer — which would recover most of
that. It has not been done, because the split has to be exactly right and the
current arrangement cannot be got wrong. If it is ever worth doing,
`engine-test.js` below is what makes it safe.

### The bots play very slightly differently now

Eight of the twenty rows in `golden.expected.txt` changed. That is expected and
unavoidable: any deterministic implementation differs from V8's by some ulps, so
the bots make imperceptibly different decisions. The file was re-recorded. It is
the one change in this work that is not invisible, and it is invisible to a
player.

### What is checked

`tools/engine-test.js` (in `npm test`) is the real guard. It runs each match
twice — once with **every** implementation-approximated `Math` function
deliberately one ulp out — and requires the simulation checksum to be identical.
Native `Math` anywhere in a simulation path fails it immediately. That is an
exhaustive check of "the simulation contains no engine-defined maths", which
eyeballing 137 call sites is not. It also asserts the skew can actually move a
result, so the cases cannot pass for the wrong reason.

`tools/clash-test.js` (also in `npm test`, dependency-free) is the end-to-end
version: a beam duel over a quarter-second link with one client on a different
browser's trig, including an absurd one-in-two perturbation, plus an assertion
that the beams really did lock — a clash test that never produced a clash proves
nothing.

`tools/lag-test.js` is the harness underneath both, and now models the four
things that vary between two real players: one-way delay, jitter, frame rate,
and the engine's floating-point behaviour.

## What is not built yet

Hats, capes, and making the jewels actually appear on the wizard. The profile
already carries `cosmetics: { unlocked: [], hat: null, cape: null }` so they can
land without migrating a single existing profile.

There is also no password reset — no email is collected. Ask before adding one;
it changes what the account is.
