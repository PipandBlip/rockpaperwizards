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

## Cloak jewels

`GEMS` in `src/account.js` is the reward ladder — twelve stones between level 2
and level 40, each with an id, the level it lands at, a name and its two
colours. `track(level)` turns it into what the menu draws: every tier, which are
earned, which is next.

**It is display only right now.** A tier counts as earned purely by having
reached its level; the server grants nothing and nothing is wearable. That is
deliberate — the ladder is there so levelling has a visible point, without
committing to an item system yet.

When the jewels become real, the server grants ids from this same list into
`profile.cosmetics.unlocked` and the only change here is that `earned` reads
that array instead of comparing levels. **Ids are permanent**: renaming a stone
is free, renumbering one would move somebody's jewel.

Two things the track has to respect, both already handled and both easy to
undo by accident:

* Each tier's colours reach CSS as custom properties set through the CSSOM, not
  as a `style=""` attribute — the CSP refuses inline styles (see below).
* The strip is `width:fit-content; margin-inline:auto`, **not**
  `justify-content:center`. Centring a flex row that overflows pushes its
  leading items past the scroll origin where they can never be reached, which
  is exactly what happens on a phone.

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

## What is not built yet

Hats, capes, and making the jewels actually appear on the wizard. The profile
already carries `cosmetics: { unlocked: [], hat: null, cape: null }` so they can
land without migrating a single existing profile.

There is also no password reset — no email is collected. Ask before adding one;
it changes what the account is.
