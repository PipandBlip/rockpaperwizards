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
    const man = await p.evaluate(() => {
      const shown = sel => {
        const e = document.querySelector(sel);
        return !!e && getComputedStyle(e).display !== "none";
      };
      return { open: document.getElementById("manual").open,
               steps: document.querySelectorAll(".steps>li").length,
               key: shown("p.by-key"), touch: shown("p.by-touch"),
               badges: [...document.querySelectorAll(".spells kbd")]
                         .filter(k => getComputedStyle(k).display !== "none").length };
    });
    ok("its manual is still open in the page", man.open === true, JSON.stringify(man.open));
    ok("with the three steps it always had", man.steps === 3, "found " + man.steps);
    ok("a desktop is told about keys, not sticks",
       man.key === true && man.touch === false, JSON.stringify(man));
    ok("and keeps the key badge on every spell", man.badges === 6,
       man.badges + " of 6 spell badges are visible — a keyboard player needs those");

    /* The held-Spark repeat is a phone affordance. A keyboard holding Y must
       still CHARGE it, or the change has quietly altered the desktop game. */
    await p.evaluate(() => window.RPW.startMatch({
      mode: "match", seed: 5, difficulty: 0, total: 2, humans: 1, seat: 0,
      levels: [11, 11], opts: { mapPreset: "arena" } }));
    await p.waitForFunction(() => window.RPW.phase() === "fight", null, { timeout: 20000 });
    await p.waitForTimeout(300);
    await p.keyboard.down("y");
    await p.waitForTimeout(500);
    const charging = await p.evaluate(() => window.RPW.where()[0]);
    await p.keyboard.up("y");
    ok("a keyboard holding Spark still charges it rather than repeating",
       charging.charge === 0,
       "the local wizard reports charge " + charging.charge +
       " after half a second on Y — a desktop should be mid-charge, not re-firing");
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

  /* ---- held Spark repeats; held Rive does not

     Counted by watching mana: every cast spends some, so a run of downward
     steps is a run of casts. Spark held should fire several times over a second;
     Rive held should charge the whole time and fire exactly once, on release. */
  const casts = async (deg, holdMs) => {
    await p.evaluate(() => window.RPW.startMatch({
      mode: "match", seed: 5, difficulty: 0, total: 2, humans: 1, seat: 0,
      levels: [11, 11], opts: { mapPreset: "arena" } }));
    await p.waitForFunction(() => window.RPW.phase() === "fight", null, { timeout: 20000 });
    await p.waitForTimeout(300);
    const t = at(deg, 0.85);
    await touch("touchStart", L.cast.x, L.cast.y);
    await touch("touchMove", t.x, t.y);
    let last = (await me()).mana, drops = 0;
    const until = Date.now() + holdMs;
    while (Date.now() < until){
      await p.waitForTimeout(25);
      const m = (await me()).mana;
      if (m < last - 4) drops++;      // a cast, not regen
      last = m;
    }
    await touch("touchEnd", 0, 0);
    await p.waitForTimeout(200);
    const after = (await me()).mana;
    if (after < last - 4) drops++;     // the cast on release, if there was one
    return drops;
  };
  const sparkShots = await casts(210, 1100);   // upper-left sector = Spark
  const riveShots  = await casts(270, 1100);   // straight up = Rive
  ok("holding Spark fires it again and again",
     sparkShots >= 3, "only " + sparkShots + " Spark casts in 1.1s of holding");
  ok("and holding Rive still charges one big one instead",
     riveShots <= 1, riveShots + " Rive casts in 1.1s — it is repeating when it should charge");

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

  /* ---- the menu, on a short landscape screen

     This is the one real phones caught and the emulator did not: a phone in
     Chrome landscape has the URL bar eating the top, leaving barely 300px of
     height, and the menu used to be a panel inside the arena's ~250px picture
     frame. Titles ended up above the top of their own box, where no amount of
     scrolling could reach them, because the old fit trick scaled content with
     a transform instead of laying it out smaller. */
  // one comfortable size and the two that actually broke: a phone in Chrome
  // landscape with the URL bar showing is around 300px tall, sometimes less
  for (const [vw, vh] of [[915, 411], [915, 300], [915, 260]]){
    await p.setViewportSize({ width: vw, height: vh });
    await p.waitForTimeout(200);
    // short timeouts: a click that cannot land must fail fast, not sit out the
    // default 30 seconds and push the whole suite past anyone's patience
    const tap = async sel => { try { await p.click(sel, { timeout: 1200 }); } catch (e) {} };
    for (const [btn, name] of [[null, "home"], ["#mpBtn", "multiplayer"],
                               ["#joinBtn", "join"], ["#soloBtn", "solo"]]){
      if (btn) {
        if (name === "solo"){ await tap("#joinBack"); await tap("#mpBack"); }
        await tap(btn);
        await p.waitForTimeout(120);
      }
      const m = await p.evaluate(() => {
        const cur = document.getElementById("curtain");
        const cr = cur.getBoundingClientRect();
        const t = document.getElementById("curtainTitle").getBoundingClientRect();
        return { cutBy: Math.round(cr.top - t.top), scroll: cur.scrollTop,
                 reachable: cur.scrollHeight - cur.clientHeight >= 0 };
      });
      ok(`the ${name} title is not cut off at ${vw}x${vh}`, m.cutBy <= 0,
         `the title starts ${m.cutBy}px above the top of the menu, which no scroll can reach`);
      ok(`and the ${name} menu opens at the top at ${vw}x${vh}`, m.scroll === 0,
         "it opened already scrolled to " + m.scroll);
    }
    await tap("#soloBack");
    await p.waitForTimeout(100);
  }
  await p.setViewportSize(LAND.viewport);
  await p.waitForTimeout(200);

  /* The full-screen menu must not bury the one control that lives under it. */
  const barUnder = await p.evaluate(() => {
    const sum = document.querySelector("#manual summary");
    const r = sum.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { onTop: !!(hit && (hit === sum || sum.contains(hit))),
             hit: hit ? (hit.id || hit.className || hit.tagName) : null };
  });
  ok("How to play is still tappable with the menu up",
     barUnder.onTop === true,
     "a tap on the bar would land on " + barUnder.hit + " instead");

  /* ---- How to play, as a bar under the arena that opens into a sheet */
  const bar = await p.evaluate(() => {
    const m = document.getElementById("manual");
    const sum = m.querySelector("summary").getBoundingClientRect();
    const stage = document.querySelector(".stage").getBoundingClientRect();
    return { open: m.open, y: sum.y, h: sum.height, bottom: sum.bottom,
             stageBottom: stage.bottom, vh: innerHeight,
             steps: document.querySelectorAll(".steps>li").length,
             // textContent, not innerText: the manual starts shut on a phone and
             // innerText renders nothing inside a closed <details>
             text: document.querySelector(".manual-body").textContent.replace(/\s+/g, " ").trim() };
  });
  ok("the How to play bar sits under the arena and on the screen",
     bar.open === false && bar.y >= bar.stageBottom - 1 && bar.bottom <= bar.vh + 1 && bar.h > 12,
     JSON.stringify({ y: bar.y, h: bar.h, bottom: bar.bottom, stageBottom: bar.stageBottom, vh: bar.vh }));
  ok("and it starts shut, so it never eats the arena",
     bar.open === false, JSON.stringify(bar.open));
  ok("and still has its three steps here", bar.steps === 3, "found " + bar.steps);

  /* Steps one and two name controls, so each device must be shown its own and
     only its own. A phone told to press Shift is a phone told a lie. */
  const words = await p.evaluate(() => {
    const shown = sel => {
      const e = document.querySelector(sel);
      return !!e && getComputedStyle(e).display !== "none";
    };
    const vis = [...document.querySelectorAll(".spells kbd")]
                  .filter(k => getComputedStyle(k).display !== "none").length;
    return { key: shown("p.by-key"), touch: shown("p.by-touch"), badges: vis,
             spells: document.querySelector(".spells").textContent.replace(/\s+/g, " ").trim(),
             stated: (document.querySelector(".dash-cd") || {}).textContent,
             cd: window.RPW.padInfo().dash.cd,
             /* `.steps .step-txt b` is the step-title rule, counter and all, so
                a <b> anywhere in this prose becomes a numbered heading in the
                middle of a sentence. It did. These two catch that shape of bug
                for anything added to a step in future. */
             cdDisplay: getComputedStyle(document.querySelector(".dash-cd")).display,
             cdCounter: getComputedStyle(document.querySelector(".dash-cd"), "::before").content };
  });
  ok("a phone is told about sticks, not keys",
     words.touch === true && words.key === false, JSON.stringify(words));
  ok("and step three drops the key badges", words.badges === 0,
     words.badges + " spell key badges are still visible on a phone");
  ok("but keeps every spell and what it does",
     ["Spark", "Rive", "Hexstone", "Ward", "Beam", "Grasp"].every(n => words.spells.includes(n)) &&
     words.spells.includes("shield") && words.spells.includes("missile"),
     words.spells.slice(0, 200));
  /* The manual states the dash cooldown as a number. Numbers written into prose
     go stale silently, so this one is checked against the constant. */
  ok("the cooldown the manual states is the cooldown the game uses",
     Number(words.stated) === words.cd,
     "the manual says " + words.stated + "s and DASH_CD is " + words.cd + "s");
  ok("and it reads as part of the sentence, not as a step heading",
     words.cdDisplay === "inline" && (words.cdCounter === "none" || words.cdCounter === "normal"),
     "the cooldown figure renders as display:" + words.cdDisplay +
     " with ::before content " + words.cdCounter +
     " — the step-title rule has caught it");

  /* Opening it mid-fight must let go of the sticks: the sheet covers the whole
     screen, so scrolling it would otherwise be a thumb dragging the wizard. */
  await touch("touchStart", L.move.x, L.move.y);
  await touch("touchMove", out(0.5).x, out(0.5).y);
  await p.waitForTimeout(80);
  const walking = await me();
  await p.tap("#manual summary");
  await p.waitForTimeout(120);
  const held = await me();
  await touch("touchEnd", 0, 0);
  ok("the wizard was walking before the manual opened",
     walking.mx !== 0 || walking.my !== 0, JSON.stringify(walking));
  ok("and opening the manual lets go of the stick",
     held.mx === 0 && held.my === 0,
     "the wizard is still being told to move " + JSON.stringify({mx: held.mx, my: held.my}));

  const sheet = await p.evaluate(() => {
    const m = document.getElementById("manual");
    const body = m.querySelector(".manual-body");
    const r = body.getBoundingClientRect();
    return { open: m.open, w: Math.round(r.width), h: Math.round(r.height),
             vh: innerHeight, vw: innerWidth,
             scrollable: body.scrollHeight > body.clientHeight + 8,
             playing: window.RPW.padInfo().playing };
  });
  ok("it opens as a sheet over the whole screen",
     sheet.open === true && sheet.h >= sheet.vh - 2 && sheet.w >= sheet.vw - 2,
     JSON.stringify(sheet));
  ok("which scrolls, because the manual is taller than a phone",
     sheet.scrollable === true, JSON.stringify(sheet));
  ok("and the sticks stop taking input while it is up",
     sheet.playing === false, JSON.stringify(sheet));

  await p.tap("#manual summary");
  await p.waitForTimeout(200);
  const shut = await p.evaluate(() => ({
    open: document.getElementById("manual").open,
    playing: window.RPW.padInfo().playing }));
  ok("tapping it again shuts it and hands the game back",
     shut.open === false && shut.playing === true, JSON.stringify(shut));

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
