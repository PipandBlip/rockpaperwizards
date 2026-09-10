/*
 * The lobby, with people actually turning up.
 *
 * The lobby answers one question — who is coming? — and it answers it in three
 * places that can each drift out of step with the truth: the note that explains
 * the game type, the seats, and the round trip to the relay. None of that is
 * reachable from the headless suites, because all three need a real relay, two
 * real clients and a layout.
 *
 * Needs playwright, the site served, and the node relay running:
 *
 *   node server/server.js                 (in another shell)
 *   python3 -m http.server 8080           (from the repo root, in another)
 *   SITE=http://localhost:8080/ RELAY=ws://localhost:8787/ws node tools/lobby-check.js
 *
 * Not in `npm test`, which stays dependency-free.
 */
"use strict";
const { chromium } = require("playwright");
const SITE = process.env.SITE || "http://localhost:8080/";
const RELAY = process.env.RELAY || "ws://localhost:8787/ws";

let pass = 0; const fails = [];
const ok = (name, cond, extra) => {
  if (cond){ pass++; console.log("  ok  " + name); }
  else { console.log("FAIL  " + name + (extra ? "\n      " + extra : "")); fails.push(name); }
};

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1180, height: 900 } });
  await ctx.addInitScript(u => { window.RPW_RELAY = u; }, RELAY);
  const errs = [];
  const open = async () => {
    const p = await ctx.newPage();
    p.on("pageerror", e => errs.push(String(e)));
    p.on("console", m => { const t = m.text();
      if (m.type() === "error" && !/Failed to load resource/.test(t)) errs.push("console: " + t); });
    await p.goto(SITE, { waitUntil: "domcontentloaded" });
    await p.waitForFunction(() => !!window.RPW && !!window.RPWNet, null, { timeout: 15000 });
    return p;
  };
  const A = await open(), B = await open();

  await A.click("#mpBtn"); await A.click("#hostBtn");
  await A.waitForFunction(() => /^[A-Z0-9]{4}$/.test(
    document.getElementById("inviteCode").textContent.trim()), null, { timeout: 15000 });
  const code = (await A.textContent("#inviteCode")).trim();
  await A.evaluate(() => {
    const seg = document.getElementById("segTotal");
    const btn = [...seg.querySelectorAll("button")].find(x => /4/.test(x.textContent));
    if (btn) btn.click();
  });
  await A.waitForTimeout(350);

  const seats = () => A.evaluate(() => [...document.querySelectorAll("#hostRoster .seat")]
    .map(s => ({ cls: s.className,
                 name: s.querySelector(".seat-name").textContent,
                 tag: s.querySelector("i").textContent,
                 icon: s.querySelector("svg.seat-ico") ? "yes" : "no" })));

  /* ---- the note is for errors now; the seats say the rest */
  const order = await A.evaluate(() => {
    const kids = [...document.getElementById("hostPanel").children].map(k => k.id || k.className);
    const n = document.getElementById("hostNote");
    return { kids, note: kids.indexOf("hostNote"), roster: kids.indexOf("hostRoster"),
             opts: kids.lastIndexOf("opts arenapick"),
             text: n.textContent.trim(), shown: getComputedStyle(n).display !== "none" };
  });
  ok("the note keeps its place under the game type options, above the seats",
     order.note > order.opts && order.note < order.roster,
     "panel order is " + order.kids.join(" > "));
  ok("but says nothing when there is nothing wrong", order.text === "",
     "it still reads: " + JSON.stringify(order.text));
  ok("and takes up no room while empty", order.shown === false,
     "an empty note is still occupying space in the panel");

  /* it is still the place an error goes, which is why the element survives */
  const err = await A.evaluate(() => {
    const n = document.getElementById("hostNote");
    n.classList.add("bad"); n.textContent = "test failure text";
    const shown = getComputedStyle(n).display !== "none";
    n.classList.remove("bad"); n.textContent = "";
    return shown;
  });
  ok("an error would still be seen", err === true,
     "the note stays hidden even with text in it, so errors would go unread");

  /* ---- every seat is a block, and its state is a colour */
  const alone = await seats();
  ok("there is one block per seat", alone.length === 4, alone.length + " blocks for 4 seats");
  ok("the host's own block shows them as present",
     /\bhere\b/.test(alone[0].cls) && /host/.test(alone[0].name),
     JSON.stringify(alone[0]));
  ok("and does not nag the host to get ready", alone[0].tag === "hosting",
     "it says '" + alone[0].tag + "' — the host presses Start, never Ready");
  ok("empty seats are marked open, with the bot they will become",
     alone.slice(1).every(s => /\bopen\b/.test(s.cls) && s.icon === "yes" && /bot/.test(s.tag)),
     JSON.stringify(alone.slice(1)));

  /* ---- somebody arrives */
  await B.click("#mpBtn"); await B.click("#joinBtn");
  await B.fill("#codeInput", code); await B.click("#joinGo");
  await A.waitForFunction(() => window.RPWNet.net.players.length === 2, null, { timeout: 15000 });
  await A.waitForTimeout(350);
  const joined = await seats();
  ok("a seat fills when somebody joins",
     /\bhere\b/.test(joined[1].cls) && joined[1].icon === "yes" && joined[1].name.length > 0,
     JSON.stringify(joined[1]));
  ok("and it asks them for the one thing left to do", joined[1].tag === "waiting",
     "it says '" + joined[1].tag + "'");
  ok("the seats behind them are still open",
     joined.slice(2).every(s => /\bopen\b/.test(s.cls)), JSON.stringify(joined.slice(2)));

  /* ---- and readies up */
  await B.click("#joinGo");
  await A.waitForFunction(() => window.RPWNet.net.players.some(x => x.ready), null, { timeout: 15000 });
  await A.waitForTimeout(350);
  const ready = await seats();
  ok("their block turns ready when they press Ready",
     /\bready\b/.test(ready[1].cls) && ready[1].tag === "ready", JSON.stringify(ready[1]));
  ok("without disturbing anybody else's",
     /\bhere\b/.test(ready[0].cls) && ready.slice(2).every(s => /\bopen\b/.test(s.cls)),
     JSON.stringify(ready));

  /* the three states have to be told apart by eye, not only by class name */
  const paint = await A.evaluate(() => [...document.querySelectorAll("#hostRoster .seat")]
    .map(s => getComputedStyle(s).borderColor));
  ok("open, here and ready are three different colours",
     paint[0] !== paint[1] && paint[1] !== paint[2] && paint[0] !== paint[2],
     JSON.stringify(paint));

  /* ---- the round trip moved to the corner of the arena */
  /* The host's own tab has to be the one in front: Chromium throttles timers in
     a background tab to about once a minute, so the 2s keepalive that measures
     the round trip never fires while B is the active page, and the readout has
     nothing to show. That is the harness, not the game — a host looking at
     their own lobby is looking at it. */
  await A.bringToFront();
  await A.waitForFunction(() => window.RPW.NET.rtt() > 0, null, { timeout: 15000 });
  await A.waitForTimeout(1200);
  const ping = await A.evaluate(() => {
    const t = document.getElementById("pingTag");
    const st = document.getElementById("stage").getBoundingClientRect();
    const r = t.getBoundingClientRect();
    return { hidden: t.hidden, text: t.textContent, cls: t.className,
             fromRight: Math.round(st.right - r.right), fromTop: Math.round(r.top - st.top),
             inNote: /ms to the relay/.test(document.getElementById("hostNote").textContent),
             inRound: /ms/.test(document.getElementById("roundLabel").textContent) };
  });
  /* A relay in the same building answers in well under a millisecond. Rounding
     that to "0ms" is indistinguishable from "not measured yet", which is how
     the readout used to hide itself on the fastest connection there is — so a
     connected lobby must never show a zero. */
  ok("the round trip is shown in the arena's top right",
     !ping.hidden && /[1-9]\d*ms/.test(ping.text) && ping.fromRight >= 0 && ping.fromRight < 40 &&
     ping.fromTop >= 0 && ping.fromTop < 40,
     JSON.stringify(ping));
  ok("and is no longer buried in the note",
     ping.inNote === false,
     "the note still ends with the round trip: a sentence that rewrites itself while you read it");
  ok("nor tacked onto the round counter", ping.inRound === false);

  /* ---- and it survives into the match, which is where it matters most */
  await A.click("#startRoom");
  await A.waitForFunction(() => window.RPW.phase() !== "menu", null, { timeout: 15000 });
  await A.waitForTimeout(2200);
  const live = await A.evaluate(() => {
    const t = document.getElementById("pingTag");
    const st = document.getElementById("stage").getBoundingClientRect();
    const r = t.getBoundingClientRect();
    return { hidden: t.hidden, text: t.textContent,
             fromRight: Math.round(st.right - r.right), fromTop: Math.round(r.top - st.top) };
  });
  ok("it is still there once the duel starts",
     !live.hidden && /[1-9]\d*ms/.test(live.text) && live.fromRight < 40 && live.fromTop < 40,
     JSON.stringify(live));

  ok("nothing threw along the way", errs.length === 0, errs.join("\n      "));
  await b.close();
  console.log("\n" + (fails.length ? fails.length + " FAILING" : pass + " passing"));
  process.exitCode = fails.length ? 1 : 0;
})();
