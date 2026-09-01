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

Every wizard trails a cloak, drawn by `drawCape()` in `src/game.js`. It carries
a row of diamonds down its spine: one plain mark to begin with, then one more
in that jewel's own colour for every cloak jewel earned, so rank is legible at
a glance across the arena. The cloth is longer at higher rank too — 39px at
rank one, 59px with all thirteen. Past six marks they go two abreast; thirteen
in single file merges into a stripe.

Where the rank comes from: the signed-in player reads their own profile, a bot
wears its tier (Apprentice one, Adept two, Archmage three), and everyone else
reads `seatLevels`, filled from the roster the relay sends.

### How a rank crosses the wire

**Only a level travels — never the colours.** Cloak jewels are earned strictly
in level order, so one integer lets every client rebuild the identical row of
stones from the shared `GEMS` table. It rides in three places that already
exist: `hello` when you connect, `create`/`join`/`quick` when you enter a room,
and one `lv` field per player in `roster()`, which is what `room` and `start`
already carry.

**Nothing touches the per-frame input stream.** That stream is 60 messages a
second per player and is the only traffic that could cost anyone a frame; it is
untouched. A roster message grows by one small integer per player — at most six
— and is sent on join, leave, ready and start. A player with a full cloak costs
exactly as much bandwidth as a brand new one. A test asserts this directly:
zero `in` messages carry a level.

`rankFor(level)` is memoised, because six capes at sixty frames a second would
otherwise rebuild the same twelve-row table 360 times a second.

**A client can claim any level.** It is cosmetic — nothing in the match reads
it — so the prize for lying is a prettier cloak. The relay still clamps it to an
integer in 1..999 (`cleanLevel`), because "banana" arriving in someone else's
rendering code is a crash, not a cheat. An older client that sends no level is
simply level one.

`updateCapes()` is a spring-to-rest verlet chain — each node is pulled towards
where it would hang if the wizard stood still (straight out behind, with a
travelling sine running down the length), its own inertia drags it, and a
distance constraint stops the cloth stretching. So turning or dashing whips it
out sideways and standing still leaves it breathing.

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

## What is not built yet

Hats, capes, and making the jewels actually appear on the wizard. The profile
already carries `cosmetics: { unlocked: [], hat: null, cape: null }` so they can
land without migrating a single existing profile.

There is also no password reset — no email is collected. Ask before adding one;
it changes what the account is.
