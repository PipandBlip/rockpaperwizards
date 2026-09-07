/* Rock, Paper, Wizards — the signed-in wizard.
 *
 * A thin client for /api/*: it holds the session token, keeps one profile
 * object in memory, and tells whoever is listening when it changes. The
 * rules all live on the server (cloudflare/worker/src/accounts.js) — the
 * only thing duplicated here is the level curve, because the menu has to
 * draw an experience bar without asking anyone. server/test-accounts.js
 * asserts the two curves agree level for level.
 *
 * Signing in is optional by design. With no session, or with no server to
 * reach at all (the single-file dist build, or a file:// page), everything
 * below quietly reports a guest and the game plays exactly as it always did.
 */
(function () {
  "use strict";

  const TOKEN_KEY = "rpw.session";
  const listeners = [];

  let token = null;
  let profile = null;      // null whenever nobody is signed in
  let offline = false;     // true once we know there is no API to talk to

  try { token = localStorage.getItem(TOKEN_KEY) || null; } catch (e) {}

  /* ------------------------------------------------------------- levels
     Mirrors needFor/levelFor in cloudflare/worker/src/accounts.js. */

  function needFor(level){
    const n = Math.max(1, level | 0);
    return 120 + 80 * (n - 1) + 12 * (n - 1) * (n - 1);
  }
  function levelFor(xp){
    let level = 1, rest = Math.max(0, Math.floor(xp || 0));
    while (level < 999){
      const need = needFor(level);
      if (rest < need) break;
      rest -= need; level++;
    }
    return { level: level, into: rest, need: needFor(level) };
  }

  /* ------------------------------------------------------------- the jewels
     The cloak track. Display only for now — nothing is wearable yet and the
     server grants nothing, so a tier is "earned" purely by having reached its
     level. When the jewels become real, the server grants from this same list
     into profile.cosmetics.unlocked and the only thing that changes here is
     where `earned` comes from. Ids are permanent; renaming one is fine,
     renumbering one is not. */

  /* The cloak ladder: one rung per level, level 1 to 14.

     A cloak is not "how many stones you have" any more. Three things move as
     you climb, and they move at different rates, which is what stops the middle
     of the ladder feeling like a slower version of the start:

       emblem  what is set into the hem — a single stud, then two, then three,
               then a quatrefoil, a hexagon, paired and crowned hexes, a lattice,
               and finally a cut diamond
       seams   the pleats running from collar to hem: none at all on plain
               cloth, fanning out through the middle of the ladder, then
               thinning again at the top as broad panels take over
       colour  a FAMILY: one base colour that fades out down the cloth, drained
               grey to begin with and sage green from level 8, near white at the
               top rung
       tail    the silhouette the hem cuts: a shallow chevron on plain cloth, a
               pointed kite through the middle, a broad rhombus once the cloth
               turns, and a pair of lobes split by a deep centre notch at the top — with `flare` widening
               the skirt as it goes, so rank reads from the outline alone even
               when a cape is too far away to make out its emblem

     Colour is the coarse read — grey, green, pale — and it is meant to be
     legible across an arena. The ladder past 14 is designed to keep going
     through blue, then red, then purple: those are three more entries in
     FAMILY and a `family` field on the new rungs, and nothing else. Until they
     exist, a wizard above 14 wears the level 14 cloak.

     A family also dresses the WIZARD. The hat cone, its brim and its lit edge
     all come from the same entry, so a wizard in a green cloak is a green
     wizard — the rank reads from the whole figure and not just the cloth
     trailing behind it. Friend and foe are still told apart by the ring and
     wand glow, which stay the seat's own tint.

     `emblem` values are drawn by emblemPath() in src/game.js — adding one here
     means adding a case there. The same function draws the cape and the menu
     tile, so the ladder is a picture of what you will actually be wearing. */
  /* A family is ONE base colour plus the wizard wearing it.

     The cloth is not a light-to-dark colour ramp — it is a single base colour
     that FADES OUT down its length: near solid at the shoulders, nearly gone at
     the hem. That is what makes it read as hanging cloth you can see through
     rather than a painted shape, and it is why there is no second colour here
     to drift out of step with the first.

     Everything drawn on top of it — the seams, the hem band, the emblem — is
     WHITE, at every rung. `panel` is the one exception: the centre wedge is a
     white overlay for every family except the last, where it is green on white.

     Blue, red and purple slot in here as three more entries and nothing else. */
  const FAMILY = {
    //     the cloth   hat cone    brim        lit edge    centre wedge
    grey: { base:"#3a3a44", hat:"#5e5e68", brim:"#24242b", lit:"#93939f", panel:null },
    sage: { base:"#2f5f27", hat:"#4f8442", brim:"#22401c", lit:"#8fc582", panel:null },
    pale: { base:"#dde7d8", hat:"#c2cfbd", brim:"#5a6756", lit:"#f4f8f1", panel:"#2f5f27" }
  };
  const GEMS = [
    { id:"plain",      at:1,  name:"Plain Cloth",     family:"grey", emblem:"stud1",   seams:0, panel:false, tail:"chevron", flare:0.00 },
    { id:"twin",       at:2,  name:"Twin Studs",      family:"grey", emblem:"stud2",   seams:0, panel:false, tail:"chevron", flare:0.04 },
    { id:"triad",      at:3,  name:"Three Studs",     family:"grey", emblem:"stud3",   seams:0, panel:false, tail:"chevron", flare:0.08 },
    { id:"quatrefoil", at:4,  name:"Quatrefoil",      family:"grey", emblem:"quatre",  seams:1, panel:false, tail:"kite",    flare:0.06 },
    { id:"fanned",     at:5,  name:"Fanned Seams",    family:"grey", emblem:"quatre",  seams:4, panel:false, tail:"kite",    flare:0.10 },
    { id:"pleated",    at:6,  name:"Pleated Cloth",   family:"grey", emblem:"quatre",  seams:7, panel:false, tail:"rhombus", flare:0.10 },
    { id:"hexstone",   at:7,  name:"Hexstone",        family:"grey", emblem:"hex1",    seams:6, panel:false, tail:"rhombus", flare:0.14 },
    { id:"verdant",    at:8,  name:"Verdant Weave",   family:"sage", emblem:"hex1",    seams:7, panel:true,  tail:"rhombus", flare:0.16 },
    { id:"paired",     at:9,  name:"Paired Hexes",    family:"sage", emblem:"hex2",    seams:7, panel:true,  tail:"rhombus", flare:0.18 },
    { id:"crowned",    at:10, name:"Crowned Hexes",   family:"sage", emblem:"hex3",    seams:6, panel:true,  tail:"rhombus", flare:0.20 },
    { id:"lattice",    at:11, name:"Hex Lattice",     family:"sage", emblem:"lattice", seams:5, panel:true,  tail:"rhombus", flare:0.24 },
    { id:"panelled",   at:12, name:"Broad Panels",    family:"sage", emblem:"lattice", seams:3, panel:true,  tail:"rhombus", flare:0.30 },
    { id:"mantle",     at:13, name:"Archmage Mantle", family:"sage", emblem:"lattice", seams:3, panel:true,  tail:"rhombus", flare:0.34 },
    { id:"crown",      at:14, name:"Crowned Mantle",  family:"pale", emblem:"diamond", seams:2, panel:true,  tail:"split",   flare:0.38 }
  ].map(r => {
    const f = FAMILY[r.family];
    // `from` is the one colour the menu tile tints itself with
    return { ...r, ...f, wedge: r.panel ? (f.panel || "#ffffff") : null, from: f.hat };
  });

  // The track as the menu draws it: every rung, whether it is earned, and
  // which one is next.
  function track(level){
    const lv = Math.max(1, level | 0);
    let nextAt = -1;
    const rows = GEMS.map(g => {
      const earned = lv >= g.at;
      if (!earned && nextAt < 0) nextAt = g.at;
      return { ...g, earned, next: false };
    });
    const next = rows.find(r => !r.earned);
    if (next) next.next = true;
    return { rows, nextAt, level: lv };
  }

  /* The cloak somebody at this level is actually wearing: the highest rung they
     have reached. Above the top rung they keep wearing the top rung, which is
     what "hold at 14 until more are designed" means in one line. */
  function cloak(level){
    const lv = Math.max(1, Math.floor(Number(level)) || 1);
    let r = GEMS[0];
    for (const g of GEMS) if (lv >= g.at) r = g;
    return r;
  }


  /* ------------------------------------------------------------- plumbing */

  function emit(){ for (const fn of listeners) { try { fn(profile); } catch (e) {} } }

  function keep(t){
    token = t || null;
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  async function call(action, body){
    // file:// and the single-file build have no API behind them; one failed
    // attempt is enough to stop trying for the rest of the session.
    if (offline) return { ok: false, error: "No account server to reach from here." };
    try {
      const res = await fetch("/api/" + action, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {})
      });
      let data = {};
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) return { ok: false, status: res.status, error: data.error || "Something went wrong." };
      return { ok: true, ...data };
    } catch (e) {
      offline = true;
      return { ok: false, error: "Could not reach the account server." };
    }
  }

  function adopt(res){
    if (!res.ok) return res;
    if (res.token) keep(res.token);
    if (res.profile) profile = res.profile;
    emit();
    return res;
  }

  /* ------------------------------------------------------------- the api */

  const A = {
    needFor, levelFor, GEMS, track,

    get signedIn(){ return !!profile; },
    get profile(){ return profile; },
    // Everything that used to read the name box reads this instead.
    get name(){ return profile ? profile.name : "Guest"; },

    onChange(fn){ if (typeof fn === "function") { listeners.push(fn); fn(profile); } },

    // called once at boot: turn a stored token back into a profile
    async resume(){
      if (!token) { emit(); return null; }
      const res = await call("me", { token });
      if (!res.ok){
        // a rejected token is a dead token; a network failure is not
        if (res.status === 401) keep(null);
        emit();
        return null;
      }
      profile = res.profile;
      emit();
      return profile;
    },

    register(name, pass){ return call("register", { name, pass }).then(adopt); },
    signIn(name, pass){ return call("login", { name, pass }).then(adopt); },

    async signOut(){
      const t = token;
      profile = null; keep(null); emit();
      if (t) call("signout", { token: t });   // best effort; the client is already out
      return { ok: true };
    },

    // Report a finished match. Returns null when signed out — callers treat
    // that as "nothing to show", not as an error.
    async report(result){
      if (!token || !profile) return null;
      const res = await call("result", { token, result });
      if (!res.ok){
        if (res.status === 401){ profile = null; keep(null); emit(); }
        return null;
      }
      profile = res.profile;
      emit();
      return { gained: res.gained || 0, leveled: res.leveled || 0, throttled: !!res.throttled, profile };
    }
  };

  /* Mirrors cloudflare/worker/src/accounts.js LIMITS. The sign-up screen checks
     these before the round trip so the rule is on screen rather than arriving as
     a rejection — and server/test-accounts.js pins the two copies together, so
     changing one side alone fails a test rather than shipping a form that
     accepts what the server will refuse. */
  A.limits = { NAME_MIN: 3, NAME_MAX: 14, PASS_MIN: 8, PASS_MAX: 200 };
  A.cloak = cloak;          // the rung a level is actually wearing
  A.rungs = GEMS.length;    // how long the ladder is

  window.RPWA = A;
})();
