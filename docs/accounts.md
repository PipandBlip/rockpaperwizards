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

## What is not built yet

Hats, capes and anything else wearable. The profile already carries
`cosmetics: { unlocked: [], hat: null, cape: null }` so they can land without
migrating a single existing profile.

There is also no password reset — no email is collected. Ask before adding one;
it changes what the account is.
