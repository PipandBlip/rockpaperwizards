/*
 * The touch controls, driven as a phone drives them.
 *
 * Everything below the surface of these controls is shared with the keyboard:
 * touch sets the same keys[] entries, localMask() reads them the same way, and
 * the bit mask on the wire is identical. That is the design, and it is also why
 * the headless suites cannot see any of this — they have no pointer, no
 * matchMedia and no layout. tools/touch-test.js checks the arithmetic; this
 * runs a real browser with a real touchscreen profile and checks the rest.
 *
 * Needs playwright and the multi-file site served somewhere:
 *
 *   npx playwright install chromium
 *   python3 -m http.server 8080          (from the repo root, in another shell)
 *   SITE=http://localhost:8080/ node tools/phone-check.js
 *
 * Not wired into `npm test`, which must stay dependency-free.
 */
"use strict";
const { chromium, devices } = require("playwright");
const SITE = process.env.SITE || "http://localhost:8080/";

let pass = 0; const fails = [];
const ok = (name, cond, extra) => {
  if (cond){ pass++; console.log("  ok  " + name); }
  else { console.log("FAIL  " + name + (extra ? "\n      " + extra : "")); fails.push(name); }
};

const phone = devices["Pixel 7"];
const LAND = Object.assign({}, phone, {
  viewport: { width: phone.viewport.height, height: phone.viewport.width },
  isLandscape: true, hasTouch: true, isMobile: true
});

(async () => {
  const b = await chromium.launch();

  /* ---------------------------------------------------- a desktop is untouched */
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(SITE, { waitUntil: "domcontentloaded" });
    await p.waitForFunction(() => !!window.RPW, null, { timeout: 15000 });
    const d = await p.evaluate(() => ({
      touch: window.RPW.touch(),
      cls: document.documentElement.className,
      padHidden: document.getElementById("pad").hidden,
      rotateShown: getComputedStyle(document.getElementById("rotate")).display !== "none",
      bookShown: getComputedStyle(document.getElementById("book")).display !== "none"
    }));
    ok("a desktop is not detected as a touch device", d.touch === false, JSON.stringify(d));
    ok("and gets no touch class, so none of the phone layout can reach it",
       !/touch/.test(d.cls), JSON.stringify(d));
    ok("and the pad and rotate screen stay out of its way",
       d.padHidden === true && d.rotateShown === false, JSON.stringify(d));
    ok("and its spell reference is still there", d.bookShown === true, JSON.stringify(d));
    await ctx.close();
  }

  /* ------------------------------------------------------------ now the phone */
  const ctx = await b.newContext(LAND);
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", e => errs.push(String(e)));
  p.on("console", m => { const t = m.text();
    if (m.type() === "error" && !/Failed to load resource/.test(t)) errs.push("console: " + t); });
  await p.goto(SITE, { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => !!window.RPW, null, { timeout: 15000 });

  ok("a touchscreen in landscape is detected", await p.evaluate(() => window.RPW.touch()));

  await p.evaluate(() => window.RPW.startMatch({
    mode: "match", seed: 5, difficulty: 0, total: 2, humans: 1, seat: 0,
    levels: [11, 11], opts: { mapPreset: "arena" } }));
  await p.waitForFunction(() => window.RPW.phase() === "fight", null, { timeout: 20000 });

  const L = (await p.evaluate(() => window.RPW.padInfo())).layout;
  const cdp = await ctx.newCDPSession(p);
  const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent",
    { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  const me = () => p.evaluate(() => window.RPW.where()[0]);
  const at = (deg, f) => ({ x: L.cast.x + Math.cos(deg * Math.PI / 180) * L.R * f,
                            y: L.cast.y + Math.sin(deg * Math.PI / 180) * L.R * f });

  /* the arena has to be worth looking at, not a letterboxed strip */
  const box = await p.evaluate(() => {
    const r = document.getElementById("game").getBoundingClientRect();
    return { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
  });
  ok("the arena uses most of the screen height",
     box.h / box.vh > 0.85, `arena is ${Math.round(box.h)}px of ${box.vh}px`);

  /* ---- the six spells sit where the keyboard's two rows sit */
  const sect = (await p.evaluate(() => window.RPW.padInfo())).sectors;
  const byDeg = Object.fromEntries(sect.map(s => [s.deg, s.key]));
  ok("the spell sectors mirror the keyboard: y u i across the top",
     byDeg[210] === "y" && byDeg[270] === "u" && byDeg[330] === "i", JSON.stringify(byDeg));
  ok("and h j k across the bottom",
     byDeg[150] === "h" && byDeg[90] === "j" && byDeg[30] === "k", JSON.stringify(byDeg));

  /* ---- the movement stick drives the same four direction bits */
  for (const [deg, mx, my, what] of [[180, -1, 0, "left"], [0, 1, 0, "right"],
                                      [270, 0, -1, "up"], [45, 1, 1, "down-right"]]){
    const t = { x: L.move.x + Math.cos(deg * Math.PI / 180) * L.R * 0.8,
                y: L.move.y + Math.sin(deg * Math.PI / 180) * L.R * 0.8 };
    await touch("touchStart", L.move.x, L.move.y);
    await touch("touchMove", t.x, t.y);
    await p.waitForTimeout(90);
    const w = await me();
    ok(`pushing the stick ${what} moves ${what}`, w.mx === mx && w.my === my,
       `got mx=${w.mx} my=${w.my}, wanted ${mx},${my}`);
    await touch("touchEnd", 0, 0);
    await p.waitForTimeout(60);
  }
  const idle = await me();
  ok("and letting go stops the wizard", idle.mx === 0 && idle.my === 0,
     `got mx=${idle.mx} my=${idle.my}`);

  /* ---- hold to charge, release to cast. The mana it costs is the proof:
          cast() spends cost*(1+level), so a long hold must cost more than a
          flick of the same spell. That is charge-and-release working through
          the stick, not merely a key being pressed. */
  const rive = at(270, 0.85);                       // straight up
  const spend = async (holdMs) => {
    await touch("touchStart", L.cast.x, L.cast.y);
    await touch("touchMove", rive.x, rive.y);
    await p.waitForTimeout(holdMs);
    const before = (await me()).mana;
    const charging = await me();
    await touch("touchEnd", 0, 0);
    let after = before;
    for (let i = 0; i < 20; i++){ await p.waitForTimeout(25); after = (await me()).mana;
                                  if (after < before - 0.5) break; }
    await p.waitForTimeout(650);                    // let the cast lock clear
    return { spent: before - after, charge: charging.charge };
  };
  const flick = await spend(70);
  const hold  = await spend(700);
  ok("holding a sector charges that spell", hold.charge === 1 && flick.charge === 1,
     `charging index was ${flick.charge} / ${hold.charge}, wanted 1 (Rive)`);
  ok("releasing the stick actually casts", flick.spent > 1 && hold.spent > 1,
     `a flick spent ${flick.spent} mana and a hold spent ${hold.spent} — nothing was cast`);
  ok("and a hold casts a bigger spell than a flick",
     hold.spent > flick.spent + 2,
     `flick spent ${flick.spent}, hold spent ${hold.spent} — the charge is not reaching the cast`);

  /* ---- push the stick out to its ring to dash

     On a fresh match, because by now the wizard has been walked into a corner
     and shot at a wall: a dash that fires while wedged against a prop moves
     nobody, which is indistinguishable from a dash that never fired. Ask the
     question somewhere the answer can be seen. */
  await p.evaluate(() => window.RPW.startMatch({
    mode: "match", seed: 5, difficulty: 0, total: 2, humans: 1, seat: 0,
    levels: [11, 11], opts: { mapPreset: "arena" } }));
  await p.waitForFunction(() => window.RPW.phase() === "fight", null, { timeout: 20000 });
  await p.waitForTimeout(400);
  const dashBefore = (await p.evaluate(() => window.RPW.padInfo())).dash.ready;
  ok("the dash ring is full when the dash is ready", dashBefore > 0.99, "ready=" + dashBefore);

  /* Find a direction with room in it before measuring a dash.

     A dash into a wall moves nobody, which looks exactly like a dash that never
     fired — and the arena preset happens to put a prop immediately beside the
     left spawn point, so both "push right" and "push towards the middle" walk
     straight into it. So probe: walk briefly each way and take the first
     direction the wizard actually travels in. */
  let aim = null;
  for (const deg of [180, 270, 90, 225, 315, 0]){
    const a = deg * Math.PI / 180;
    const t = { x: L.move.x + Math.cos(a) * L.R * 0.5, y: L.move.y + Math.sin(a) * L.R * 0.5 };
    const s0 = await me();
    await touch("touchStart", L.move.x, L.move.y);
    await touch("touchMove", t.x, t.y);
    await p.waitForTimeout(140);
    const s1 = await me();
    await touch("touchEnd", 0, 0);
    if (Math.hypot(s1.x - s0.x, s1.y - s0.y) > 12){ aim = a; break; }
  }
  ok("the wizard has somewhere to walk", aim !== null,
     "every direction was blocked, so a dash cannot be measured here");
  if (aim === null) aim = Math.PI;
  const out = f => ({ x: L.move.x + Math.cos(aim) * L.R * f,
                      y: L.move.y + Math.sin(aim) * L.R * f });
  const p0 = await me();
  await touch("touchStart", L.move.x, L.move.y);
  await touch("touchMove", out(0.4).x, out(0.4).y);   // walking
  await p.waitForTimeout(50);
  const walkRing = (await p.evaluate(() => window.RPW.padInfo())).dash.ready;
  await touch("touchMove", out(1.0).x, out(1.0).y);   // out to the ring
  await p.waitForTimeout(150);
  const p1 = await me();
  const dashMid = (await p.evaluate(() => window.RPW.padInfo())).dash.ready;
  await touch("touchEnd", 0, 0);
  ok("walking the stick partway out does not dash", walkRing > 0.99,
     "the ring dropped to " + walkRing + " during ordinary movement");
  const travelled = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  ok("pushing it out to the ring dashes",
     travelled > 45, `moved ${travelled.toFixed(1)}px in 150ms — a dash should outrun a walk`);
  ok("and the ring empties when it goes on cooldown",
     dashMid < 0.4, "ring reads " + dashMid + " right after dashing");

  /* Resting against the ring must not dash on repeat, and must not fire again
     by itself the moment the cooldown returns — the thumb has to come back in. */
  await touch("touchStart", L.move.x, L.move.y);
  await touch("touchMove", out(0.5).x, out(0.5).y);   // inside: this re-arms
  await p.waitForTimeout(40);
  await touch("touchMove", out(1.0).x, out(1.0).y);   // and out to the ring again
  await p.waitForTimeout(3600);                       // hold there through the cooldown
  const restRing = (await p.evaluate(() => window.RPW.padInfo())).dash.ready;
  await touch("touchEnd", 0, 0);
  ok("holding against the ring does not dash again on its own",
     restRing > 0.99,
     "the ring read " + restRing + " after holding at the rim through a full cooldown — " +
     "a dash fired with the thumb never moving");

  /* And a plain direction change at walking distance is never a dash. */
  await p.waitForTimeout(400);
  await touch("touchStart", L.move.x, L.move.y);
  for (let deg = 0; deg <= 360; deg += 30){
    const t = { x: L.move.x + Math.cos(deg * Math.PI / 180) * L.R * 0.7,
                y: L.move.y + Math.sin(deg * Math.PI / 180) * L.R * 0.7 };
    await touch("touchMove", t.x, t.y);
    await p.waitForTimeout(25);
  }
  const swept = (await p.evaluate(() => window.RPW.padInfo())).dash.ready;
  await touch("touchEnd", 0, 0);
  ok("sweeping the stick around inside the ring does not dash",
     swept > 0.99, "the ring dropped to " + swept + " — a plain direction change spent the dash");

  /* ---- portrait says so instead of playing */
  await p.setViewportSize({ width: LAND.viewport.height, height: LAND.viewport.width });
  await p.waitForTimeout(250);
  const port = await p.evaluate(() => ({
    shown: getComputedStyle(document.getElementById("rotate")).display !== "none",
    playing: window.RPW.padInfo().playing }));
  ok("portrait shows the rotate screen and stops taking input",
     port.shown === true && port.playing === false, JSON.stringify(port));
  await p.setViewportSize(LAND.viewport);
  await p.waitForTimeout(250);
  const back = await p.evaluate(() => ({
    shown: getComputedStyle(document.getElementById("rotate")).display !== "none",
    playing: window.RPW.padInfo().playing }));
  ok("and turning back to landscape puts it away again",
     back.shown === false && back.playing === true, JSON.stringify(back));

  ok("nothing threw along the way", errs.length === 0, errs.join("\n      "));

  await b.close();
  console.log("\n" + (fails.length ? fails.length + " FAILING" : pass + " passing"));
  process.exitCode = fails.length ? 1 : 0;
})();
