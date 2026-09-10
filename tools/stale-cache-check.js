/*
 * The bug that made long-distance matches unplayable, reproduced honestly.
 *
 * index.html is served fresh every visit; src/game.js is served with four hours
 * of browser cache. So when a deploy changes game.js and REUSES the ?v= number,
 * one player runs the file their browser saved earlier and the other runs the
 * new one — and both report the same version, because the version is the thing
 * that is wrong. Every check passes, the match starts, and two different
 * programs part company a few seconds in. It looks exactly like a network fault
 * and it is not one.
 *
 * This serves the same page twice, on two origins, under the SAME version tag,
 * with one byte of simulation code different — a browser holding a stale copy —
 * and asserts the match is refused before it starts rather than desyncing.
 *
 * Needs playwright and the node relay:
 *
 *   node server/server.js                  (in another shell)
 *   node tools/stale-cache-check.js
 *
 * Not in `npm test`, which stays dependency-free.
 */
"use strict";
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const ROOT  = path.join(__dirname, "..");
const RELAY = process.env.RELAY || "ws://localhost:8787/ws";
const VERSION = (fs.readFileSync(path.join(ROOT, "index.html"), "utf8").match(/game\.js\?v=(\d+)/) || [])[1] || "0";

let pass = 0; const fails = [];
const ok = (name, cond, extra) => {
  if (cond){ pass++; console.log("  ok  " + name); }
  else { console.log("FAIL  " + name + (extra ? "\n      " + extra : "")); fails.push(name); }
};

/* the production CSP, so the fingerprint is tested under the rules it ships
   under — a connect-src that forbade it would fail silently and forever */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; "
  + "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'; "
  + "connect-src 'self' " + RELAY.replace(/\/ws$/, "") + "; base-uri 'self'; form-action 'self'; "
  + "frame-ancestors 'none'; object-src 'none'";
const TYPES = { ".html":"text/html", ".js":"application/javascript", ".css":"text/css",
                ".svg":"image/svg+xml", ".png":"image/png", ".mp3":"audio/mpeg" };

/* one origin. `patch` rewrites a file on the way out, which is precisely what a
   stale cache does: same URL, same version, different bytes. */
function serve(port, patch){
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(url.parse(req.url).pathname);
      if (p === "/") p = "/index.html";
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, buf) => {
        if (err){ res.writeHead(404); return res.end("no"); }
        let body = buf;
        const rel = p.replace(/^\//, "");
        if (patch && patch[rel]) body = Buffer.from(patch[rel](buf.toString("utf8")), "utf8");
        res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
                             "Content-Security-Policy": CSP,
                             "Cache-Control": "public, max-age=14400, must-revalidate" });
        res.end(body);
      });
    });
    srv.listen(port, () => resolve(srv));
  });
}

const staleGame = t => {
  const from = "const DASH_CD = 3;";
  if (!t.includes(from)) throw new Error("anchor for the stale copy is gone: " + from);
  return t.replace(from, "const DASH_CD = 4;");   // one constant: a real commit is bigger
};
/* The old build check, restored: the version tag and nothing else. Serving this
   proves the scenario below is a real failure and not a scenario the game was
   always going to refuse — a test that passes with and without the fix is not
   evidence of anything, which this repo has learned twice. */
const noFingerprint = t => {
  const from = 'return codeId ? versionTag() + "." + codeId : versionTag();';
  if (!t.includes(from)) throw new Error("anchor for the pre-fix build id is gone");
  return t.replace(from, "return versionTag();");
};
const STALE = { "src/game.js": staleGame };
const STALE_OLD = { "src/game.js": staleGame, "src/net.js": noFingerprint };
const FRESH_OLD = { "src/net.js": noFingerprint };

/* drive two clients from a room code to a start attempt */
async function tryToPlay(A, B){
  await A.click("#mpBtn"); await A.click("#hostBtn");
  await A.waitForFunction(() => /^[A-Z0-9]{4}$/.test(
    document.getElementById("inviteCode").textContent.trim()), null, { timeout: 15000 });
  const code = (await A.textContent("#inviteCode")).trim();
  await B.click("#mpBtn"); await B.click("#joinBtn");
  await B.fill("#codeInput", code); await B.click("#joinGo");
  await A.waitForFunction(() => window.RPWNet.net.players.length === 2, null, { timeout: 15000 });
  await B.click("#joinGo");
  await A.waitForTimeout(400);
  await A.click("#startRoom");
  await A.waitForTimeout(1500);
}

(async () => {
  const fresh = await serve(8091, null);
  const stale = await serve(8092, STALE);
  const freshOld = await serve(8093, FRESH_OLD);
  const staleOld = await serve(8094, STALE_OLD);
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1180, height: 900 } });
  await ctx.addInitScript(u => { window.RPW_RELAY = u; }, RELAY);
  const errs = [];
  const open = async (port) => {
    const p = await ctx.newPage();
    p.on("pageerror", e => errs.push(String(e)));
    p.on("console", m => { const t = m.text();
      if (/Refused to|Content Security Policy/.test(t)) errs.push("CSP: " + t); });
    await p.goto("http://localhost:" + port + "/", { waitUntil: "domcontentloaded" });
    await p.waitForFunction(() => !!window.RPW && !!window.RPWNet, null, { timeout: 15000 });
    await p.waitForFunction(() => /\./.test(window.RPW.NET.build()), null, { timeout: 10000 }).catch(() => {});
    return p;
  };
  const A = await open(8091);   // the player who reloaded
  const B = await open(8092);   // the player whose browser kept yesterday's copy

  const idA = await A.evaluate(() => window.RPW.NET.build());
  const idB = await B.evaluate(() => window.RPW.NET.build());
  console.log("  fresh copy: " + idA + "\n  stale copy: " + idB);

  ok("both players honestly report the same VERSION",
     idA.split(".")[0] === VERSION && idB.split(".")[0] === VERSION,
     idA + " / " + idB + " against index.html's v" + VERSION);
  ok("but they do not report the same BUILD", idA !== idB,
     "a stale cached game.js is indistinguishable from a fresh one — this is the bug");
  ok("the fingerprint is what tells them apart",
     idA.split(".")[1] && idB.split(".")[1] && idA.split(".")[1] !== idB.split(".")[1],
     idA + " / " + idB);

  await tryToPlay(A, B);

  const state = async p => p.evaluate(() => ({
    phase: window.RPW.phase(),
    title: document.getElementById("curtainTitle").textContent,
    text: document.getElementById("curtainText").textContent
  }));
  const sa = await state(A), sb = await state(B);

  ok("the match is refused rather than started", sa.phase === "menu" && sb.phase === "menu",
     "A is in phase " + sa.phase + ", B in " + sb.phase + " — they are playing, and will desync");
  ok("and both players are told what is actually wrong",
     /different copies/i.test(sa.title) && /different copies/i.test(sb.title),
     JSON.stringify([sa.title, sb.title]));
  ok("with the fix a person can act on", /hard refresh/i.test(sa.text), sa.text);
  ok("and it is NOT reported as a desync",
     !/out of sync/i.test(sa.title) && !/out of sync/i.test(sb.title),
     "this is the mislabelling that sent us hunting the netcode: " + sa.title);
  ok("nothing threw, and the CSP allowed the fingerprint", errs.length === 0, errs.join("\n      "));

  /* ---- and the same two clients, with the old version-only check ---- */
  const C = await open(8093), D = await open(8094);
  const idC = await C.evaluate(() => window.RPW.NET.build());
  const idD = await D.evaluate(() => window.RPW.NET.build());
  console.log("\n  with the old check — fresh: " + idC + "  stale: " + idD);
  ok("BEFORE the fix, two different programs claimed the same build",
     idC === idD && idC === VERSION,
     "got " + idC + " and " + idD + " — expected both to be a bare \"" + VERSION + "\"");
  await tryToPlay(C, D);
  const sc = await state(C);
  ok("BEFORE the fix, the match started anyway — this is the bug, reproduced",
     sc.phase !== "menu",
     "the old check refused this match too, so the scenario above proves nothing");

  await b.close(); fresh.close(); stale.close(); freshOld.close(); staleOld.close();
  console.log("\n" + (fails.length ? fails.length + " FAILING" : pass + " passing"));
  process.exit(fails.length ? 1 : 0);
})();
