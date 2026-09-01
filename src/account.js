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
    needFor, levelFor,

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

  window.RPWA = A;
})();
