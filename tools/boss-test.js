/*
 * The Alchemist: the four-wand boss that follows the two Archmages on wave 8.
 *
 * What is checked is what a player would notice, and what would desync a match:
 *   - it arrives when the ladder says, alone, and the ladder carries on after it
 *   - only two of its four wands are ever out, and the two are always one pair
 *   - its hat spins and locks two different spells; the wands out are those two,
 *     and while it spins every arm is behind its back
 *   - it sometimes fuses the two into one new spell, with a star flash first,
 *     and does not always
 *   - every spell leaves from a wand tip, not from the middle of the hat
 *   - one beam channel, never two beams
 *   - it runs on mana: a real bar that drains as it casts, refills, and makes a
 *     wand wait when it is empty
 *   - the party arrives at full health and full mana
 *   - it plays like an Archmage: it steps out of shots, dashes, drops the ward in
 *     front of light shots, does not fire into a crate, keeps its range and stays
 *     out of corners
 *   - it can be hurt, and it can die
 *   - it is deterministic: same seed twice, and on an engine whose sin/cos/atan2
 *     are a last-bit off, and from another seat in a co-op run — the same
 *     checks the rest of the game answers to
 *
 *   node tools/boss-test.js
 */
"use strict";
const assert = require("assert");
const { boot } = require("./determinism");

let pass = 0;
function test(name, fn){
  if (process.env.ONLY && !new RegExp(process.env.ONLY, "i").test(name)) return;      // ONLY=wheel node tools/boss-test.js
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e){ console.error("FAIL  " + name + "\n      " + (e.stack || e.message).split("\n").slice(0, 4).join("\n      ")); process.exitCode = 1; }
}

/** the menu's Boss test run, with the player handed to a bot so it plays itself */
function bossRig(seed, { skew = false, level = 2 } = {}){
  const rig = boot({ seed, skew });
  rig.RPW.bossTest(seed);
  rig.RPW.autoplay(level);
  return rig;
}

console.log("\nthe Alchemist: arrival");

test("wave 8 is two Archmages, the boss is wave 9, and the ladder carries on after it", () => {
  const rig = boot({ seed: 11, diff: 1, room: 1, humans: 1, opts: { coop: 1, mapPreset: "random" } });
  rig.RPW.skipToWave(7);                       // 7 cleared: the next set is wave 8
  const rivals = () => rig.RPW.sides().filter(w => !w.ally);
  for (let i = 0; i < 600 && rivals().length === 0; i++) rig.step();
  assert.strictEqual(rig.RPW.waveNow(), 8);
  assert.strictEqual(rivals().length, 2, "wave 8 is a pair");
  for (const w of rivals()) rig.RPW.smite(w.id);
  assert.strictEqual(rig.RPW.bossState(), null, "no boss while the ordinary ladder is still running");
  for (let i = 0; i < 600 && !rig.RPW.bossState(); i++) rig.step();
  const b = rig.RPW.bossState();
  assert.ok(b, "the boss arrived after wave 8 was cleared");
  assert.strictEqual(rig.RPW.waveNow(), 9);
  assert.strictEqual(rivals().length, 1, "the boss stands alone");
  assert.strictEqual(b.phase, "intro", "it makes an entrance before it fights");
  // kill it (once its entrance is over: it cannot be hurt while it arrives), and
  // the ladder picks up where it would have been: three Apprentices
  for (let i = 0; i < 300 && rig.RPW.bossState().phase === "intro"; i++) rig.step();
  rig.RPW.smite(rivals()[0].id);
  for (let i = 0; i < 900 && rig.RPW.waveNow() < 10; i++) rig.step();
  assert.strictEqual(rig.RPW.waveNow(), 10);
  assert.strictEqual(rivals().length, 3, "wave 10 is the first set of threes");
});

test("the menu's boss test starts with wave 8 already behind you", () => {
  const rig = bossRig(2);
  assert.strictEqual(rig.RPW.waveNow(), 8);
  for (let i = 0; i < 400; i++) rig.step();
  assert.ok(rig.RPW.bossState(), "the boss is on the floor within a few seconds");
  assert.strictEqual(rig.RPW.waveNow(), 9);
});

test("reaching the boss for real unlocks a standing rematch — a rehearsal alone does not confuse the flag", () => {
  const rig = boot({ seed: 11, diff: 1, room: 1, humans: 1, opts: { coop: 1, mapPreset: "random" } });
  assert.strictEqual(rig.RPW.bossReached(), false, "nothing has happened yet");
  rig.RPW.skipToWave(7);
  const rivals = () => rig.RPW.sides().filter(w => !w.ally);
  for (let i = 0; i < 600 && rivals().length === 0; i++) rig.step();
  for (const w of rivals()) rig.RPW.smite(w.id);
  assert.strictEqual(rig.RPW.bossReached(), false, "clearing wave 8 is not reaching the boss");
  for (let i = 0; i < 600 && !rig.RPW.bossState(); i++) rig.step();
  assert.ok(rig.RPW.bossState(), "the boss arrived");
  assert.strictEqual(rig.RPW.bossReached(), true, "and that is what unlocks the rematch");
});

test("a hosted room can send the party straight to a rematch of the boss, but never boss without co-op", () => {
  const rush = boot({ seed: 5, diff: 1, room: 3, humans: 3, opts: { coop: 1, boss: 1, mapPreset: "random" } });
  assert.strictEqual(rush.RPW.waveNow(), 8, "the room opens straight on the boss's wave, no ladder climbed");
  const rivals = () => rush.RPW.sides().filter(w => !w.ally);
  for (let i = 0; i < 400 && rivals().length === 0; i++) rush.step();
  assert.ok(rush.RPW.bossState(), "and it really is the boss standing there, not an ordinary wave");
  assert.strictEqual(rivals().length, 1, "alone, the way the boss always arrives");

  // boss:1 with coop:0 is nonsense (a rematch has no solo slot in a hosted
  // room) — sanitizeMatchCfg must throw it away rather than honour it
  const lonely = boot({ seed: 5, diff: 1, opts: { coop: 0, boss: 1, mapPreset: "random" } });
  assert.strictEqual(lonely.RPW.matchCfg().boss, 0, "boss:1 without coop:1 is sanitised away, not honoured");
  assert.notStrictEqual(lonely.RPW.waveNow(), 8, "and the room never even becomes an escalation run");
});

test("the whole party arrives at full health and full mana: hurt, dry, or downed", () => {
  const rig = boot({ seed: 11, diff: 1, room: 3, humans: 1, opts: { coop: 1, mapPreset: "random" } });
  rig.RPW.skipToWave(7);
  const rivals = () => rig.RPW.sides().filter(w => w.team === 1);
  for (let i = 0; i < 600 && rivals().length === 0; i++) rig.step();
  for (const w of rivals()) rig.RPW.smite(w.id);
  const party = rig.RPW.sides().filter(w => w.team === 0);
  assert.strictEqual(party.length, 3);
  rig.RPW.setVitals(party[0].id, 20, 5);          // hurt and dry
  rig.RPW.setVitals(party[1].id, 30, 0);
  rig.RPW.smite(party[2].id);                     // and one downed
  for (let i = 0; i < 700 && !rig.RPW.bossState(); i++) rig.step();
  assert.ok(rig.RPW.bossState(), "the boss came");
  for (const w of rig.RPW.sides().filter(q => q.team === 0)){
    assert.ok(!w.dead, "wizard " + w.id + " is still down");
    assert.strictEqual(w.hp, w.hpMax, "wizard " + w.id + " arrived at " + w.hp + "/" + w.hpMax);
    assert.ok(w.mana >= 99.9, "wizard " + w.id + " arrived with " + w.mana + " mana");
  }
});

test("and the boss's own bar starts full", () => {
  const rig = bossRig(2);
  for (let i = 0; i < 300 && !rig.RPW.bossState(); i++) rig.step();
  assert.strictEqual(rig.RPW.bossState().mana, 100);
});

console.log("\nthe Alchemist: its four wands");

/** play a few fights with the bot and hand every frame's boss state to `look` */
function watch(seeds, secs, look){
  for (const seed of seeds){
    const rig = bossRig(seed);
    for (let i = 0; i < 60 * secs; i++){
      rig.step();
      // the bot in the player's seat is not the point of these checks, and a fight that ends at thirty
      // seconds shows less of the boss than one that lasts: keep it on its feet
      if (i % 20 === 0){ const me = rig.RPW.sides().find(w => w.ally); if (me && !me.dead) rig.RPW.setVitals(me.id, Math.max(me.hp, me.hpMax * .6), me.mana); }
      const b = rig.RPW.bossState();
      if (!b || b.dead) { if (b && b.dead) break; continue; }
      look(b, seed, i);
      if (rig.RPW.phase() === "over") break;
    }
  }
}

test("only ever two wands out, and they are always one pair", () => {
  let frames = 0, swaps = 0, lastPair = 0;
  watch([1, 2, 3, 4, 5, 6], 40, (b) => {
    const out = b.arms.filter(a => a.live && a.st !== 3);
    assert.ok(out.length <= 2, "at most two wands working, saw " + out.length);
    const pairs = new Set(b.arms.filter(a => a.st !== 3).map(a => a.id === "FL" || a.id === "RR" ? 0 : 1));
    assert.ok(pairs.size <= 1, "working wands belong to one pair");
    if (b.pair !== lastPair){ swaps++; lastPair = b.pair; }
    frames++;
  });
  assert.ok(frames > 1000, "watched a real fight (" + frames + " frames)");
  assert.ok(swaps >= 3, "the pairs traded places (" + swaps + " swaps)");
});

test("it uses every spell, and the two it carries are always two different ones", () => {
  const seen = new Set();
  let beams = 0, live = 0;
  watch([1, 2, 3, 4, 5, 6, 7, 8], 45, (b) => {
    assert.notStrictEqual(b.lock[0], b.lock[1], "the hat locked the same spell twice");
    if (b.phase === "live" || b.phase === "warn"){
      for (const a of b.arms.filter(q => q.live && q.st !== 3)) seen.add(a.spell);
      const heavy = b.arms.filter(q => q.live && q.st !== 3 && (q.spell === "beam" || q.spell === "ward" || q.spell === "grasp")).map(q => q.spell);
      assert.strictEqual(new Set(heavy).size, heavy.length, "two of " + heavy.join("+") + " at once");
      // left hand and right hand carry what the hat locked
      for (const a of b.arms.filter(q => q.live)){
        const left = a.id === "FL" || a.id === "RL";
        assert.strictEqual(a.spell, b.lock[left ? 0 : 1], a.id + " is holding " + a.spell + " but the hat locked " + b.lock.join("+"));
      }
      live++;
    }
    if (b.beamOn) beams++;
  });
  for (const s of ["spark", "rive", "hex", "ward", "beam", "grasp"]) assert.ok(seen.has(s), s + " never appeared");
  assert.ok(beams > 60, "the beam was actually fired");
  assert.ok(live > 1000, "watched enough of the fight (" + live + " frames)");
});

console.log("\nthe Alchemist: the hat and the arms");

test("while the hat spins every arm is behind its back, then the new pair draws and the old pair stays put away", () => {
  let spins = 0, checked = 0;
  for (const seed of [1, 2, 3, 4]){
    const rig = bossRig(seed);
    let inSpin = false, sawOut = 0;
    for (let i = 0; i < 60 * 45; i++){
      rig.step();
      const b = rig.RPW.bossState();
      if (!b || b.dead){ if (b && b.dead) break; continue; }
      // (the two front hands come out for the mirror, whichever pair is working, and go back when it drops)
      const mirror = b.arms.some(a => a.rc > .02 || a.rw > .02), front = a => a.id === "FL" || a.id === "FR";
      const out = b.arms.filter(a => a.out > .5 && !(mirror && front(a))).length;
      assert.ok(out <= 2, "three or four wands out at once (" + out + ")");
      if (b.phase === "spin"){
        if (!inSpin){ spins++; inSpin = true; }
        if (b.spinK > .45){ assert.ok(b.arms.every(a => a.out < .05 || (mirror && front(a))), "an arm was still out mid-spin"); checked++; }
        assert.ok(b.arms.every(a => a.st === 3), "a wand was working while the hat spun");
      } else inSpin = false;
      if (b.phase === "live" && b.arms.filter(a => a.live).every(a => a.out > .99)) sawOut++;
      if (rig.RPW.phase() === "over") break;
    }
    assert.ok(sawOut > 100, "the live pair never came all the way out (seed " + seed + ")");
  }
  assert.ok(spins >= 6, "the hat spun repeatedly (" + spins + " spins)");
  assert.ok(checked > 60, "checked the arms during the spin (" + checked + " frames)");
});

test("the hat really turns: it whirls through whole turns and comes to rest at zero, and the ring's stones end up locked in place", () => {
  let peak = 0, rest = 0, clicks = 0;
  const rig = bossRig(2);
  for (let i = 0; i < 60 * 40; i++){
    rig.step();
    const v = rig.RPW.bossView(), b = rig.RPW.bossState();
    if (!v || !b || b.dead) { if (b && b.dead) break; continue; }
    assert.ok(Number.isFinite(v.hat) && Number.isFinite(v.ring), "hat angle is a number");
    peak = Math.max(peak, Math.abs(v.hat));
    if (b.phase === "live" && b.fires >= 1){ rest = Math.max(rest, Math.abs(v.hat), Math.abs(v.ring)); clicks++; }
    // the two chosen stones sit in the two reading slots (0 and 2)
    assert.strictEqual(JSON.stringify([b.slots[0], b.slots[2]].map(i => ["spark", "rive", "hex", "ward", "beam", "grasp"][i])), JSON.stringify(b.lock));
  }
  assert.ok(peak > 2 * Math.PI * 2, "the hat never made two whole turns (peak " + peak.toFixed(1) + " rad)");
  assert.ok(clicks > 100 && rest < .05, "the hat did not settle back to rest (" + rest.toFixed(3) + " rad)");
});

console.log("\nthe Alchemist: fused spells");

test("it fuses the two spells into a new one, with a star flash first, and it does not always", () => {
  const made = new Set();
  let fused = 0, skipped = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]){
    const rig = bossRig(seed);
    let flashAt = -1, lastFlash = 0, period = null;
    const flashFrames = [];
    let firstCombo = -1;
    for (let i = 0; i < 60 * 70; i++){
      rig.step();
      const b = rig.RPW.bossState();
      if (!b || b.dead){ if (b && b.dead) break; continue; }
      if (b.phase === "spin"){
        if (period && period.combo && !period.fused) skipped++;
        period = null;
      } else if (b.phase === "live" && !period) period = { combo: b.combo, fused: false };
      if (b.flashN > lastFlash){                           // the star
        lastFlash = b.flashN; flashAt = i; fused++; made.add(b.combo);
        assert.ok(b.combo, "a star flashed with nothing to fuse");
        assert.ok(b.arms.filter(a => a.live).every(a => a.cf > .5), "the two wands had not come together when the star flashed");
        if (period) period.fused = true;
        firstCombo = -1;
      }
      if (flashAt >= 0 && firstCombo < 0){
        const kinds = { swarm: "swarm", needle: "needle", wheel: "wheel" };
        const c = b.combo && kinds[b.combo];
        const fresh = { swarm: 4.6, needle: 3.2, wheel: 6.2 };        // a shot that has only just left (its life is nearly all still ahead of it), not one from the last fusion still in flight
        if (c && b.shots.some(s => s.kind === c && s.life >= fresh[c] - .3)){
          firstCombo = i;
          assert.ok(i - flashAt >= 18, "seed " + seed + " " + b.combo + ": the fused spell went off " + (i - flashAt) + " frames after the star: too soon to read it");
          assert.ok(i - flashAt <= 60, "seed " + seed + " " + b.combo + ": the fused spell was " + (i - flashAt) + " frames late");
        }
        if (b.combo === "prism" && b.prism && b.beamOn) firstCombo = i;
      }
      if (rig.RPW.phase() === "over") break;
    }
  }
  assert.ok(fused >= 10, "it fused " + fused + " times in eighteen fights");
  for (const c of ["swarm", "needle", "wheel", "prism"]) assert.ok(made.has(c), "never made " + c);
  assert.ok(skipped >= 3, "it fused every single time it could (" + skipped + " skipped)");
});

test("it fuses often: about half the spins with a pair that can fuse turn into a fused spell, several times a minute", () => {
  let secs = 0, stars = 0, pairs = 0, pairsFused = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]){
    const rig = bossRig(seed);
    let period = null, last = 0, t0 = -1;
    for (let i = 0; i < 60 * 60; i++){
      rig.step();
      const b = rig.RPW.bossState();
      if (b && b.dead) break;
      if (!b) continue;
      const me = rig.RPW.sides().find(w => w.ally);
      if (me) rig.RPW.setVitals(me.id, 100, 100);
      if (b.phase === "spin"){ if (period && period.combo){ pairs++; if (period.fused) pairsFused++; } period = null; }
      else if (b.phase === "live" && !period) period = { combo: b.combo, fused: false };
      if (b.flashN > last){ stars += b.flashN - last; last = b.flashN; if (period) period.fused = true; }
      if (b.phase !== "intro" && t0 < 0) t0 = i;
      secs = secs + 1 / 60;
    }
  }
  const perMin = stars / (secs / 60);
  assert.ok(perMin >= 3, "it fused " + perMin.toFixed(1) + " times a minute (it used to manage about one)");
  assert.ok(pairs >= 15 && pairsFused / pairs >= .45, pairsFused + " of " + pairs + " fusable stretches were fused");
});

test("Hexswarm is ten staggered homing missiles", () => {
  let swarmMax = 0, spread = 0;
  for (let seed = 1; seed <= 30 && !(swarmMax >= 3 && spread >= 20); seed++){
    const rig = bossRig(seed);
    const born = new Map();
    for (let i = 0; i < 60 * 60; i++){
      rig.step();
      if (i % 20 === 0){ const me = rig.RPW.sides().find(w => w.ally); if (me && !me.dead) rig.RPW.setVitals(me.id, me.hpMax, me.mana); }
      const b = rig.RPW.bossState();
      if (!b || b.dead){ if (b && b.dead) break; continue; }
      const sw = b.shots.filter(s => s.kind === "swarm" && s.life > 3.5 && b.combo === "swarm");
      swarmMax = Math.max(swarmMax, sw.length);
      for (const s of b.shots.filter(q => q.kind === "swarm" && b.combo === "swarm")){
        const key = seed + ":" + s.life.toFixed(1);
        if (!born.has(key)) born.set(key, i);
      }
      if (rig.RPW.phase() === "over") break;
    }
    const times = [...born.values()];
    if (times.length > 6) spread = Math.max(spread, Math.max(...times) - Math.min(...times));
  }
  assert.ok(swarmMax >= 3, "never saw a swarm in the air (" + swarmMax + ")");
  assert.ok(spread >= 20, "the swarm launched all at once (" + spread + " frames apart)");
});

test("Sparkwheel is a spinning homing orb that throws rings of sparks and speeds up as it closes", () => {
  let wheels = 0, rings = 0, far = [], near = [], ringGapNear = [], ringGapFar = [], round = 0, bestRing = 0;
  for (let seed = 1; seed <= 30 && wheels < 6; seed++){
    const rig = bossRig(seed);
    let prev = new Set(), lastRingAt = null, seenWheel = false;
    for (let i = 0; i < 60 * 70; i++){
      rig.step();
      if (i % 20 === 0){ const me = rig.RPW.sides().find(w => w.ally); if (me && !me.dead) rig.RPW.setVitals(me.id, me.hpMax, me.mana); }
      const b = rig.RPW.bossState();
      if (!b || b.dead){ if (b && b.dead) break; continue; }
      const w = b.shots.find(s => s.kind === "wheel");
      if (w){
        if (!seenWheel){ seenWheel = true; wheels++; lastRingAt = null; }
        const v = Math.hypot(w.vx, w.vy);
        const d = b.target ? Math.hypot(w.x - b.target.x, w.y - b.target.y) : 999;
        if (d > 230) far.push(v);
        if (d < 130) near.push(v);
        // a ring: sparks that appear this frame on the wheel's rim, in every direction
        const fresh = b.shots.filter(s => s.kind === "spark" && s.life > 1.69 && Math.hypot(s.x - w.x, s.y - w.y) < 30);
        if (fresh.length >= 5){                            // (near the target some of a ring is eaten the moment it is thrown)
          // one ring is on the wheel's rim for a few frames: only a detection well after the last one is a new ring
          if (lastRingAt == null || i - lastRingAt >= 8){
            if (lastRingAt != null) (d < 220 ? ringGapNear : ringGapFar).push(i - lastRingAt);
            lastRingAt = i;
          }
        }
        if (fresh.length >= 8){
          rings++;
          const angs = fresh.map(s => Math.atan2(s.vy, s.vx)).sort((p, q) => p - q);
          let gap = 0; for (let k = 0; k < angs.length; k++){ const nx = k + 1 < angs.length ? angs[k + 1] : angs[0] + 2 * Math.PI; gap = Math.max(gap, nx - angs[k]); }
          assert.ok(gap < 1.6, "the ring has a hole " + gap.toFixed(2) + " rad wide: it is not a circle");
          bestRing = Math.max(bestRing, fresh.length);
        }
      } else seenWheel = false;
      if (rig.RPW.phase() === "over") break;
    }
  }
  assert.ok(wheels >= 3, "saw " + wheels + " sparkwheels in twenty-four fights");
  assert.ok(rings >= 10, "the wheel threw " + rings + " rings of sparks");
  assert.ok(bestRing >= 9, "a ring has " + bestRing + " sparks");
  const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  assert.ok(far.length > 20 && near.length > 10, "watched the wheel at range and up close (" + far.length + ", " + near.length + ")");
  assert.ok(avg(near) > avg(far) * 1.5, "it did not speed up as it closed: " + avg(far).toFixed(0) + " px/s at range, " + avg(near).toFixed(0) + " up close");
  assert.ok(avg(far) < 300, "it is already fast at range (" + avg(far).toFixed(0) + " px/s)");
  if (ringGapNear.length > 3 && ringGapFar.length > 3) assert.ok(avg(ringGapNear) < avg(ringGapFar), "the rings did not come faster as it closed (" + avg(ringGapFar).toFixed(1) + " frames apart at range, " + avg(ringGapNear).toFixed(1) + " near)");
});

test("every spell leaves a wand tip, not the middle of the hat", () => {
  const born = {}; let checked = 0;
  watch([1, 2, 3, 4, 5, 6], 40, (b, seed) => {
    for (const s of b.shots){
      const fresh = (s.kind === "spark" && s.life > 3.975 && s.life < 4) || (s.kind === "rive" && s.life > 3.375 && s.life < 3.4) || (s.kind === "hex" && s.life > 5.175 && s.life < 5.2) || (s.kind === "swarm" && s.life > 4.575 && s.life < 4.6) || (s.kind === "needle" && s.life > 3.175 && s.life < 3.2) || (s.kind === "wheel" && s.life > 6.175 && s.life < 6.2);
      if (!fresh) continue;
      const d = Math.hypot(s.x - b.x, s.y - b.y);
      assert.ok(d > 15 && d < 100, s.kind + " appeared " + d.toFixed(0) + "px from the boss's centre");
      checked++;
    }
  });
  assert.ok(checked > 15, "checked enough shots (" + checked + ")");
});

test("while the beam is open the wand that holds it has swung to the centre line", () => {
  let n = 0, low = 0;
  watch([1, 2, 3, 4, 5, 6, 7, 8], 45, (b) => {
    if (!b.beamOn) return;
    const a = b.arms.find(q => q.spell === "beam" && q.live && q.st === 1);
    if (a){ if (a.foc < .6) low++; else low = 0; assert.ok(low < 20, "beam wand not on the centre line (foc " + a.foc.toFixed(2) + ")"); if (a.foc > .9) n++; }
  });
  assert.ok(n > 20, "saw the beam held on the centre line (" + n + " frames)");
});

console.log("\nthe Alchemist: mana");

test("it spends real mana: the bar drains as it casts, refills, stays in 0-100, and is never pinned", () => {
  let lo = 100, hi = 0, drops = 0, rises = 0, distinct = new Set(), prev = null, frames = 0, low = 0;
  watch([1, 2, 3, 4, 5, 6, 7, 8], 60, (b) => {
    if (b.phase === "intro") return;
    assert.ok(b.mana >= 0 && b.mana <= 100.0001, "mana " + b.mana + " is off the bar");
    lo = Math.min(lo, b.mana); hi = Math.max(hi, b.mana);
    if (prev != null){ if (b.mana < prev - 5) drops++; else if (b.mana > prev) rises++; }
    prev = b.mana; distinct.add(Math.round(b.mana));
    frames++; if (b.mana < 30) low++;
  });
  assert.ok(frames > 2000, "watched " + frames + " frames");
  assert.ok(lo < 25, "it never got low (lowest " + lo + "): it is not really spending");
  assert.ok(hi > 90, "it never refilled (highest " + hi + ")");
  assert.ok(distinct.size > 60, "the bar barely moves (" + distinct.size + " values)");
  assert.ok(drops > 20 && rises > 500, "it should drain in steps and refill smoothly (" + drops + " drops, " + rises + " rises)");
  assert.ok(low / frames < .4, "it spent " + (100 * low / frames).toFixed(0) + "% of the fight nearly empty: it is starved");
});

test("with the bar empty a wand holds its spell instead of firing free, and the hat turns to something it can pay for", () => {
  let dryFrames = 0, freeShots = 0, longest = 0, checked = 0; const episodes = [];
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]){
    const rig = bossRig(seed);
    let lastShots = 0, prevMana = null, peak = 0;
    for (let i = 0; i < 60 * 60; i++){
      rig.step();
      const b = rig.RPW.bossState();
      if (!b || b.dead){ if (b && b.dead) break; continue; }
      if (b.phase === "intro") continue;
      if (b.dry > 0) dryFrames++;
      longest = Math.max(longest, b.dry);
      if (b.dry > 0) peak = Math.max(peak, b.dry); else if (peak > 0){ episodes.push(peak); peak = 0; }
      // a shot appearing while the bar is under the cheapest price and nothing pays for it
      // (a spark burst is paid for once, at its first spark: only fans and stones are one price for one release)
      const n = b.shots.filter(s => (s.kind === "rive" && s.life > 3.35) || (s.kind === "hex" && s.life > 5.15)).length;
      if (n > lastShots && prevMana != null && prevMana < 10 && b.mana < 10) freeShots++;
      lastShots = n; prevMana = b.mana; checked++;
      if (rig.RPW.phase() === "over") break;
    }
  }
  assert.ok(dryFrames > 30, "a wand never had to wait for mana (" + dryFrames + " frames)");
  // it waits at most BOSS_DRY, then the hat is called; the turn itself only waits for the other wand to finish
  // what it is in the middle of (a two-second beam, at worst)
  episodes.sort((a, b) => a - b);
  const p90 = episodes[Math.floor(episodes.length * .9)] || 0;
  assert.ok(episodes.length >= 5, "only " + episodes.length + " waits to look at");
  assert.ok(p90 <= 2.6, "nine waits in ten should be over in 2.6 s; the 90th percentile was " + p90.toFixed(2) + " s");
  assert.ok(longest <= 4.2, "a wand waited " + longest.toFixed(2) + " s: the hat should have turned by then");
  assert.strictEqual(freeShots, 0, freeShots + " spells left with an empty bar");
});

test("the beam drains its mana, and cannot be held on empty", () => {
  let beamFrames = 0, drained = 0;
  watch([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 60, (b) => {
    if (b.beamOn){ beamFrames++; }
    if (b.beamOn && b.mana <= 0.05) drained++;
  });
  assert.ok(beamFrames > 100, "the beam was used (" + beamFrames + " frames)");
  assert.ok(drained < 60, "the beam went on burning at zero (" + drained + " frames)");
});

console.log("\nthe Alchemist: intelligence");

/** put a fast, hard-hitting spark in the air from the player's wizard straight at the boss */
function volley(seed, at, mode){
  const rig = bossRig(seed);
  let started = false, hp0 = 0, id = null, yid = null, t0 = 0, dashes0 = 0, dodges0 = 0, dashCool = 0;
  for (let i = 0; i < 60 * 40; i++){
    rig.step();
    const b = rig.RPW.bossState();
    if (!b) continue;
    if (b.dead) return null;
    if (!started && b.phase === "live" && i >= at && rig.RPW.phase() !== "over"){
      const me = rig.RPW.sides().find(w => w.ally), boss = rig.RPW.sides().find(w => !w.ally);
      if (!me || me.dead) return null;
      if (mode === "ready" && b.dashCool > 0) continue;
      if (mode === "cooling" && b.dashCool <= 0.5) continue;
      started = true; id = boss.id; yid = me.id; hp0 = b.hp; t0 = i; dashes0 = b.dashes; dodges0 = b.dodges;
      dashCool = b.dashCool;
      rig.RPW.fireAt(yid, id, 30);
    }
    if (started && i - t0 === 70) return { hit: b.hp < hp0 - 20, hp0, hp1: b.hp, dashed: b.dashes > dashes0, dodged: b.dodges > dodges0, dashCool };
  }
  return null;
}

test("it steps out of a shot coming straight at it", () => {
  let n = 0, hit = 0, dodged = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]){
    for (const at of [420, 900]){
      const r = volley(seed, at, "any");
      if (!r) continue;
      n++; if (r.hit) hit++; if (r.dodged || r.dashed) dodged++;
    }
  }
  assert.ok(n >= 12, "ran " + n + " volleys");
  assert.ok(hit / n < .5, "a single shot hit " + hit + " of " + n + " times: it is not dodging");
  assert.ok(dodged / n > .7, "it reacted to " + dodged + " of " + n);
});

test("it dashes out of a shot when its dash is ready", () => {
  let n = 0, dashed = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]){
    const r = volley(seed, 480, "ready");
    if (!r) continue;
    n++; if (r.dashed) dashed++;
  }
  assert.ok(n >= 8, "ran " + n + " volleys");
  assert.ok(dashed >= 1, "it never dashed away from a shot in " + n + " tries");
});

test("it is not a slippery ghost: with its dash spent, shots still get through sometimes", () => {
  let n = 0, hit = 0;
  for (let seed = 1; seed <= 30; seed++){
    for (const at of [300, 500, 700]){
      const r = volley(seed, at, "cooling");
      if (!r) continue;
      n++; if (r.hit) hit++;
    }
  }
  assert.ok(n >= 6, "ran " + n + " volleys");
  // a single shot, taken cold: the boss is slow and big. It must not dodge everything.
  assert.ok(hit >= 1, "it dodged every one of " + n + " shots even with its dash spent");
});

test("a light wall goes up in front of light shots: the wand that holds the ward drops it on a threat", () => {
  let wards = 0, reasoned = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]){
    const rig = bossRig(seed);
    let lastW = 0, lastSense = -999;
    for (let i = 0; i < 60 * 50; i++){
      rig.step();
      const b = rig.RPW.bossState();
      if (!b || b.dead){ if (b && b.dead) break; continue; }
      if (b.sensed && b.sensed.hit > 0) lastSense = i;
      if (b.wards > lastW){ wards += b.wards - lastW; if (i - lastSense < 40) reasoned += b.wards - lastW; lastW = b.wards; }
      if (rig.RPW.phase() === "over") break;
    }
  }
  assert.ok(wards >= 6, "it raised the ward " + wards + " times");
  assert.ok(reasoned / wards > .5, "only " + reasoned + " of " + wards + " walls went up with something coming: the ward is on a timer");
});

test("it does not spend spells on a crate: what it throws, it throws with a clear line", () => {
  let fresh = 0, blocked = 0;
  watch([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 50, (b) => {
    const n = b.shots.filter(s => (s.kind === "spark" && s.life > 3.9) || (s.kind === "rive" && s.life > 3.3) || (s.kind === "hex" && s.life > 5.1)).length;
    if (n){ fresh++; if (!b.los) blocked++; }
  });
  assert.ok(fresh > 50, "watched " + fresh + " fresh shots");
  assert.ok(blocked / fresh < .1, blocked + " of " + fresh + " shots left with a crate in the way");
});

test("it keeps a fighting range, and does not get pinned in a corner", () => {
  let n = 0, sum = 0, corner = 0, tooClose = 0, tooFar = 0;
  watch([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 45, (b) => {
    if (b.phase === "intro" || !b.target) return;
    const d = Math.hypot(b.x - b.target.x, b.y - b.target.y);
    n++; sum += d;
    if (d < 130) tooClose++; if (d > 520) tooFar++;
    if ((b.x < 70 || b.x > 890) && (b.y < 70 || b.y > 550)) corner++;
  });
  assert.ok(n > 3000, "watched " + n + " frames");
  const avg = sum / n;
  assert.ok(avg > 250 && avg < 430, "it fights from " + avg.toFixed(0) + " px");
  assert.ok(tooClose / n < .08, "it was on top of you " + (100 * tooClose / n).toFixed(0) + "% of the time");
  assert.ok(corner / n < .05, "it spent " + (100 * corner / n).toFixed(0) + "% of the fight in a corner");
});

test("it dashes to make room when crowded and to get out of the way, but is bound by the cooldown", () => {
  let dashes = 0, secs = 0, tooOften = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]){
    const rig = bossRig(seed);
    let last = 0, lastAt = -999;
    for (let i = 0; i < 60 * 45; i++){
      rig.step();
      const b = rig.RPW.bossState();
      if (!b || b.dead){ if (b && b.dead) break; continue; }
      if (b.phase !== "intro") secs += 1 / 60;
      if (b.dashes > last){ dashes += b.dashes - last; if (i - lastAt < 170) tooOften++; lastAt = i; last = b.dashes; }
      if (rig.RPW.phase() === "over") break;
    }
  }
  assert.ok(dashes >= 6, "it dashed " + dashes + " times in " + secs.toFixed(0) + " s");
  assert.strictEqual(tooOften, 0, "it dashed faster than the three-second cooldown allows");
});

console.log("\nthe Alchemist: the fight");

test("it takes damage from the player's spells, and it can die", () => {
  let dead = 0, hurt = 0;
  for (let seed = 1; seed <= 12; seed++){
    const rig = bossRig(seed);
    for (let i = 0; i < 60 * 120; i++){
      rig.step();
      const me = rig.RPW.sides().find(w => w.ally); if (me && !me.dead) rig.RPW.setVitals(me.id, 100, 100);     // (whether a bot lives long enough to do it is what tools/boss-balance.js measures: this is only whether it can be done)
      const b = rig.RPW.bossState();
      if (b && b.hp < b.hpMax) hurt++;
      if (b && b.dead){ dead++; break; }
      if (rig.RPW.phase() === "over") break;
    }
  }
  assert.ok(hurt > 0, "the boss never lost health");
  assert.ok(dead >= 3, "only " + dead + " of twelve bots that could not be hurt killed it: it is unbeatable, not just hard");
});

test("a killed boss stays dead and the run goes on", () => {
  const rig = bossRig(4);
  for (let i = 0; i < 600 && !(rig.RPW.bossState() && rig.RPW.bossState().phase === "live"); i++) rig.step();
  const id = rig.RPW.sides().find(w => !w.ally).id;
  rig.RPW.smite(id);
  rig.step();
  const after = rig.RPW.bossState();
  assert.ok(after === null || after.dead, "the boss is down");
  for (let i = 0; i < 700; i++) rig.step();
  assert.ok(rig.RPW.waveNow() >= 10, "wave 10 followed");
});


console.log("\nthe Alchemist: the soft parts");

test("the arms overshoot the pose they are sent to, then settle on it", () => {
  let overshoots = 0, settled = 0, worst = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]){
    const rig = bossRig(seed);
    let prevGap = null, crossed = 0, lastSwap = -999, frames = 0;
    for (let i = 0; i < 60 * 40; i++){
      rig.step();
      const v = rig.RPW.bossView(), b = rig.RPW.bossState();
      if (!v || !b || b.phase === "intro") continue;
      for (const a of v.arms){
        assert.ok(a.H.every(Number.isFinite), "hand position is a number");
      }
      // the arm the swap is bringing out: how far the drawn hand is from where it is headed
      const a = v.arms.find(q => q.live);
      const gap = Math.hypot(a.H[0] - a.tH[0], a.H[1] - a.tH[1]);
      worst = Math.max(worst, gap);
      if (b.phase === "spin") { lastSwap = i; }
      if (b.phase === "live" && i - lastSwap < 75 && i - lastSwap > 8){
        // the hand has arrived at least once and is now on the far side of it, or ringing about it
        if (prevGap != null && prevGap < 2 && gap > 1.2) crossed++;
      }
      if (b.phase === "live" && i - lastSwap > 90 && lastSwap > 0 && gap < 6) settled++;
      prevGap = gap;
      if (rig.RPW.phase() === "over" || b.dead) break;
    }
    overshoots += crossed;
  }
  assert.ok(worst > 3, "the drawn hand never lagged the simulated one, so it is not springy (worst gap " + worst.toFixed(1) + ")");
  assert.ok(overshoots > 0, "the hand never rang past its mark after the wands were drawn");
  assert.ok(settled > 200, "and it does not settle (" + settled + " settled frames)");
});

test("the cloth stays cloth: links keep their length, nothing goes to NaN, and it trails when the boss moves", () => {
  let maxStretch = 0, maxAway = 0, maxSwing = 0, n = 0; const aways = [];
  for (const seed of [1, 2, 3, 4]){
    const rig = bossRig(seed);
    for (let i = 0; i < 60 * 30; i++){
      rig.step();
      const v = rig.RPW.bossView();
      if (!v) continue;
      for (const c of v.cloth){
        assert.ok(c.finite, "cloth went to NaN");
        maxStretch = Math.max(maxStretch, c.stretch); maxAway = Math.max(maxAway, c.away); aways.push(c.away); n++;
        maxSwing = Math.max(maxSwing, c.swing);
      }
    }
  }
  assert.ok(n > 2000, "watched the cloth (" + n + " samples)");
  assert.ok(maxStretch < .06, "a cloth link stretched " + (maxStretch * 100).toFixed(1) + "%");
  assert.ok(maxSwing < 2.1, "a link of cloth swung " + maxSwing.toFixed(2) + " rad from straight behind: round the front of the body");
  assert.ok(maxAway > 2, "the cloth never left its rest pose, so it is not being dragged (max " + maxAway.toFixed(1) + "px)");
  aways.sort((a, b) => a - b);
  const median = aways[aways.length >> 1];
  assert.ok(median < 20, "the cloth is not hanging from the boss: typically " + median.toFixed(0) + "px from where it would hang");
});

test("the under-cloak does not flap: it swings no faster than a slow sweep, and no wilder than the cloak over it", () => {
  const speeds = { cloak: [], under: [] };
  for (const seed of [1, 2, 3, 4]){
    const rig = bossRig(seed);
    const tips = { cloak: [], under: [] };
    for (let i = 0; i < 60 * 30; i++){
      rig.step();
      if (i % 20 === 0){ const me = rig.RPW.sides().find(w => w.ally); if (me && !me.dead) rig.RPW.setVitals(me.id, Math.max(me.hp, 60), me.mana); }
      const v = rig.RPW.bossView();
      if (!v) continue;
      tips.cloak.push(v.cloth[2].tip); tips.under.push(v.cloth[6].tip);       // cloth = the five cloak strands, then the three under-cloak strands
    }
    for (const k of ["cloak", "under"]){
      let sum = 0;
      for (let i = 1; i < tips[k].length; i++){ let d = Math.abs(tips[k][i] - tips[k][i - 1]); if (d > Math.PI) d = 2 * Math.PI - d; sum += d * 60 * 180 / Math.PI; }
      speeds[k].push(sum / tips[k].length);
    }
  }
  for (let i = 0; i < 4; i++){
    assert.ok(speeds.under[i] < 150, "the under-cloak hem swung at an average " + speeds.under[i].toFixed(0) + " deg/s (seed " + (i + 1) + ")");
    assert.ok(speeds.under[i] < speeds.cloak[i] * 1.3, "the under-cloak (" + speeds.under[i].toFixed(0) + " deg/s) is wilder than the cloak (" + speeds.cloak[i].toFixed(0) + ")");
  }
});

test("a dash drags the cloth out along the way it came, holds it a moment, and lets it come home", () => {
  let streamed = 0, held = 0, home = 0, tries = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]){
    const rig = bossRig(seed);
    let go = false;
    for (let i = 0; i < 60 * 40 && !go; i++){
      rig.step();
      const me = rig.RPW.sides().find(w => w.ally); if (me && !me.dead) rig.RPW.setVitals(me.id, 100, me.mana);
      const b = rig.RPW.bossState();
      if (b && b.phase === "live" && b.dashCool <= 0 && !b.beamOn && rig.RPW.bossView().stream < .02) go = true;
    }
    if (!go) continue;
    tries++;
    const b0 = rig.RPW.bossState();
    // sideways, whichever side has the room (a dash into the wall is over before the cloth has streamed)
    const side = ((480 - b0.x) * Math.cos(b0.facing + Math.PI / 2) + (310 - b0.y) * Math.sin(b0.facing + Math.PI / 2)) >= 0 ? 1 : -1;
    assert.ok(rig.RPW.bossDash(side * Math.cos(b0.facing + Math.PI / 2), side * Math.sin(b0.facing + Math.PI / 2)), "the dash would not start");
    let peak = 0, at = 0, streamAtHalf = 0;
    for (let i = 0; i < 100; i++){
      rig.step();
      const v = rig.RPW.bossView();
      assert.ok(v.cloth.every(c => c.finite), "cloth went to NaN in a dash");
      assert.ok(v.cloth.every(c => c.swing < 2.1), "cloth swung round the front of the body in a dash");
      if (v.stream > peak){ peak = v.stream; at = i; }
      if (i === 30) streamAtHalf = v.stream;
    }
    if (peak > .6) streamed++;
    if (streamAtHalf > .15) held++;
    if (rig.RPW.bossView().stream < .12) home++;
  }
  assert.ok(tries >= 3, "arranged a dash in " + tries + " fights");
  assert.strictEqual(streamed, tries, "the cloth streamed in " + streamed + " of " + tries + " dashes");
  assert.strictEqual(held, tries, "and stayed out half a second later in " + held + " of " + tries);
  assert.strictEqual(home, tries, "and had come home a second and a half after in " + home + " of " + tries);
});

test("a walk does not stream the cloth: only a dash does", () => {
  let worst = 0;
  const rig = bossRig(3);
  for (let i = 0; i < 60 * 30; i++){
    rig.step();
    const me = rig.RPW.sides().find(w => w.ally); if (me && !me.dead) rig.RPW.setVitals(me.id, 100, me.mana);
    const b = rig.RPW.bossState(), v = rig.RPW.bossView();
    if (b && v && b.dashCool <= 2.2) worst = Math.max(worst, v.stream);       // (for the first three quarters of a second after a dash it is still coming home: not a walk)
  }
  assert.ok(worst < .35, "the cloth was streaming at " + worst.toFixed(2) + " with no dash near");
});

test("the drawn facing lags the simulated one a little and never runs away from it", () => {
  const rig = bossRig(3);
  let maxLag = 0;
  for (let i = 0; i < 60 * 30; i++){
    rig.step();
    const v = rig.RPW.bossView();
    if (!v) continue;
    let d = Math.abs(v.face - v.simFace) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d;
    maxLag = Math.max(maxLag, d);
  }
  assert.ok(maxLag > .01, "the drawn facing is just the simulated one");
  assert.ok(maxLag < .5, "the drawn facing fell " + maxLag.toFixed(2) + " rad behind");
});

console.log("\nthe Alchemist: reflect");

const MIRROR_D = 58, MIRROR_HALF = 62;       // the pane's distance from the boss and half-width (game.js: BOSS_MIRROR_D / _HALF)
const segDist = (ax, ay, bx, by, px, py) => {          // how near a point is to a segment
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
  return Math.hypot(ax + dx * t - px, ay + dy * t - py);
};
/** a player who keeps a beam on the boss whenever the boss has no beam of its own: `look(b, me, prev, i, seed, prevMe, rig)` each frame */
function beamer(seeds, secs, look, opts){
  for (const seed of seeds){
    const rig = bossRig(seed, opts);
    let prev = null, prevMe = null;
    for (let i = 0; i < 60 * secs; i++){
      rig.step();
      const b = rig.RPW.bossState(), me = rig.RPW.sides().find(w => w.ally);
      if (!b || b.dead || !me || me.dead) continue;
      if (b.phase !== "intro" && !b.beamUp && b.los && me.mana > 30) rig.RPW.forceBeam(me.id, true);
      if (me.hp < 60) rig.RPW.setVitals(me.id, 100, me.mana);
      if (me.mana < 40) rig.RPW.setVitals(me.id, me.hp, 100);
      look(b, me, prev, i, seed, prevMe, rig);
      prev = b; prevMe = me;
    }
  }
}

test("a beam at it, when it has no beam of its own, is met by a mirror that costs mana and holds for a moment", () => {
  let opens = 0, longest = 0; const closedAt = [];
  beamer([3, 4, 5, 6], 30, (b, me, prev, i) => {
    if (b.refl && !(prev && prev.refl)){
      opens++;
      assert.ok(prev && !b.beamUp, "it raised a mirror while it was holding a beam of its own");
      assert.ok(prev.mana >= 17.5, "it raised a mirror it could not pay for (" + prev.mana + " mana)");
      assert.ok(prev.reflCd < .05, "it raised a mirror before the last one had cooled (" + prev.reflCd + ")");
    }
    if (b.refl) longest = Math.max(longest, b.refl.t);
    if (!b.refl && prev && prev.refl) closedAt.push(i);
  });
  assert.ok(opens >= 3, "it raised a mirror " + opens + " times against a player who beamed it all fight");
  assert.ok(longest <= 1.85, "a mirror held " + longest.toFixed(2) + "s");
  assert.ok(longest > .5, "a mirror never held longer than " + longest.toFixed(2) + "s");
});

test("the mirror costs 18 mana, and a wizard with less than that cannot raise one", () => {
  const price = seed => {
    const rig = bossRig(seed);
    let at = -1, prev = null;
    for (let i = 0; i < 60 * 30; i++){
      rig.step();
      const b = rig.RPW.bossState(), me = rig.RPW.sides().find(w => w.ally);
      if (!b || b.dead || !me || me.dead) continue;
      const bid = rig.RPW.sides().find(w => w.team === 1).id;
      if (b.phase === "live" && !b.beamUp && b.los){
        if (at < 0) at = i;
        rig.RPW.forceBeam(me.id, true);
        if (i - at < 100) rig.RPW.setVitals(bid, b.hp, 10);              // dry: 10 mana, held there
        else if (i - at === 100) rig.RPW.setVitals(bid, b.hp, 40);       // and then it can pay
        if (i - at < 100) assert.ok(!b.refl, "it raised a mirror on " + b.mana + " mana");
        else if (b.refl && prev && !prev.refl){
          // what it had the moment before (the top-up to 40 lands between two readings), less what it has now, unless a wand let go in the same frame and spent some too
          if (b.arms.some((A, k) => A.st !== prev.arms[k].st)) return false;
          const before = i - at === 101 ? 40 : prev.mana;
          assert.ok(before - b.mana > 15, "the mirror cost " + (before - b.mana).toFixed(1));
          return true;
        }
      }
      prev = b;
      if (me.hp < 60) rig.RPW.setVitals(me.id, 100, me.mana);
      if (me.mana < 40) rig.RPW.setVitals(me.id, me.hp, 100);
    }
    return false;
  };
  assert.ok([3, 4, 5, 6].some(price), "never got to see it pay for a mirror");
});

test("the mirror cools before it can be raised again", () => {
  let last = -1e9, gaps = 0, n = 0, lastSeed = -1;
  beamer([3, 4, 5, 6], 40, (b, me, prev, i, seed) => {
    if (seed !== lastSeed){ lastSeed = seed; last = -1e9; }
    if (prev && prev.refl && !b.refl){ last = i; assert.ok(b.reflCd > 3.9, "cooldown after a mirror (" + b.reflCd + ")"); }
    if (b.refl && !(prev && prev.refl) && last > -1e8){ n++; assert.ok((i - last) / 60 >= 3.9, "raised again after " + ((i - last) / 60).toFixed(2) + "s"); gaps++; }
  });
  assert.ok(gaps >= 1, "saw a second mirror after a first (" + gaps + ")");
});

test("a beam that reaches the glass goes no further, the boss takes none of it, and it comes back at the player", () => {
  let cut = 0, back = 0, dmgFrames = 0, dmg = 0, kicked = 0, aimed = 0, bossHit = 0, fed = 0;
  beamer([3, 4, 5, 6], 30, (b, me, prev, i, seed, prevMe) => {
    const R = b.refl;
    if (!R || !R.out.length || me.beamWind < 1 || !prev) return;
    fed++;
    const pc = { x: b.x + Math.cos(R.ang) * MIRROR_D, y: b.y + Math.sin(R.ang) * MIRROR_D };
    const toPane = Math.hypot(me.x - pc.x, me.y - pc.y), toBoss = Math.hypot(me.x - b.x, me.y - b.y);
    if (me.beamLen < toBoss - 30 && me.beamLen <= toPane + MIRROR_HALF + 5) cut++;
    else assert.fail("the beam ran on past the glass: beam " + me.beamLen + ", glass " + toPane.toFixed(0) + ", boss " + toBoss.toFixed(0));
    if (prev.hp - b.hp > 1.2 && prevMe && prevMe.beamOn && !R.out.length) bossHit++;
    const o = R.out[0], ex = o.x + Math.cos(o.ang) * o.len, ey = o.y + Math.sin(o.ang) * o.len;
    back++;
    const off = Math.abs(((Math.atan2(me.y - o.y, me.x - o.x) - o.ang + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (R.t < .1) { if (off > .25) kicked++; }
    if (segDist(o.x, o.y, ex, ey, me.x, me.y) < 20){
      aimed++;
      if (prevMe && prevMe.hp > me.hp) { dmgFrames++; dmg += prevMe.hp - me.hp; }
    }
  });
  assert.ok(fed > 100, "watched the mirror working (" + fed + " frames)");
  assert.strictEqual(cut, fed, "every frame the beam was cut off at the glass");
  assert.ok(aimed > 40, "the returned beam found the player (" + aimed + " frames)");
  assert.ok(dmg / (aimed / 60) > 8, "the returned beam burned the player at " + (dmg / (aimed / 60)).toFixed(1) + "/s");
  assert.ok(kicked > 0, "the returned beam leaves the glass off the line to its target, and swings onto it");
});

test("the returned beam swings on rather than snapping to its target: there is time to step out of it", () => {
  let first = null, worst = 0, seen = 0;
  beamer([3, 4, 5, 6], 30, (b, me, prev) => {
    const R = b.refl;
    if (!R || !R.out.length){ first = null; return; }
    const o = R.out[0];
    const off = Math.abs(((Math.atan2(me.y - o.y, me.x - o.x) - o.ang + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (first === null){ first = off; seen++; }
    if (prev && prev.refl && prev.refl.out.length){
      const p = prev.refl.out[0]; let d = Math.abs(o.ang - p.ang) % (Math.PI * 2); if (d > Math.PI) d = Math.PI * 2 - d;
      worst = Math.max(worst, d * 60);                         // rad/s it turned this frame
    }
  });
  assert.ok(seen >= 3, "saw returned beams begin (" + seen + ")");
  assert.ok(worst < 1.6, "the returned beam swung at " + worst.toFixed(2) + " rad/s");
});

test("it stays off its own beam, and off the mirror, when it has the beam ready", () => {
  // while a live wand holds the beam, no mirror: the beam answers the beam
  let holding = 0;
  beamer([1, 2, 3, 4, 5, 6], 40, (b) => {
    if (b.beamUp){ holding++; }
  });
  assert.ok(holding > 200, "saw frames with its own beam ready (" + holding + ")");
});

test("the game's own bots know about the mirror: they do not beam a wizard who can raise one, and let go when the glass goes up", () => {
  let opens = 0, into = 0, beams = 0, was = false;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]){
    const rig = bossRig(seed);
    let prev = null;
    for (let i = 0; i < 60 * 60; i++){
      rig.step();
      const b = rig.RPW.bossState(), me = rig.RPW.sides().find(w => w.ally);
      if (!b || !me) continue;
      if (b.dead || me.dead) break;
      if (i % 20 === 0) rig.RPW.setVitals(me.id, Math.max(me.hp, me.hpMax * .6), me.mana);
      if (b.refl && !(prev && prev.refl)) opens++;
      if (me.beamOn && !was) beams++;
      was = me.beamOn;
      if (me.beamOn && me.beamWind >= 1 && b.refl) into++;
      prev = b;
    }
  }
  assert.ok(beams >= 20, "the bot still beams when it makes sense (" + beams + " beams in eight fights)");
  assert.ok(opens <= 12, "the mirror went up " + opens + " times against a bot that knows to leave it alone");
  assert.ok(into < 40, "the bot stood in its own beam against a raised mirror for " + into + " frames");
});

test("with the mirror gone the beam burns it again, and it can still be killed with one", () => {
  let hurt = 0;
  beamer([3, 4, 5, 6], 40, (b, me, prev) => {
    if (prev && !b.refl && !prev.refl && me.beamLen > 0 && me.beamWind >= 1 && prev.hp - b.hp > .05) hurt++;
  });
  assert.ok(hurt > 5, "a beam with no mirror in the way never hurt it (" + hurt + " frames)");
});

const CLASP = .34, OPEN = .16, SEAM = 24;    // game.js: BOSS_MIRROR_CLASP / _OPEN / _SEAM

test("the mirror is raised with the hands: the front two clap together, then fling apart as the pane is drawn out from a seam to full width", () => {
  let mirrors = 0, tooEarly = 0;
  const life = [];
  beamer([3, 4, 5, 6], 40, (b, me, prev, i, seed, prevMe, rig) => {
    const R = b.refl;
    if (!R){
      const whole = life.length && life[life.length - 1].t > CLASP + OPEN + .25;     // one that came down early (the beam stopped) never got to open fully
      if (whole){                                // a mirror has just come down: judge it
        mirrors++;
        const at = t => life.filter(q => Math.abs(q.t - t) < .03).pop();
        const sepAt = t => { const q = at(t); return q && q.sep; };
        // at the clap the hands are together, and the pane is only the seam (as wide as the boss)
        const q0 = at(CLASP - .04);
        assert.ok(q0, "no sample at the clap");
        assert.ok(Math.abs(q0.half - SEAM) < .5, "the pane was " + q0.half.toFixed(1) + " wide while the hands were still coming together");
        assert.ok(q0.rc > .9 && q0.rw < .05, "at the clap the hands were not together (rc " + q0.rc.toFixed(2) + ", rw " + q0.rw.toFixed(2) + ")");
        assert.ok(q0.sep < 45, "the drawn hands were " + q0.sep.toFixed(0) + " apart at the clap");
        // then the arms fling out, and the pane with them
        const q1 = at(CLASP + OPEN + .2);
        assert.ok(q1, "no sample after the pane opened");
        assert.ok(q1.half > 61.5, "the pane was only " + q1.half.toFixed(1) + " wide once open");
        assert.ok(q1.rw > .99, "the arms were not out (rw " + q1.rw.toFixed(2) + ")");
        assert.ok(q1.sep > 130, "the drawn hands were only " + q1.sep.toFixed(0) + " apart with the pane open");
        // and it only ever grows: the pane never narrows while the mirror is up
        for (let k = 1; k < life.length; k++) assert.ok(life[k].half >= life[k-1].half - 1e-6, "the pane narrowed at " + life[k].t.toFixed(2));
      }
      life.length = 0;
      return;
    }
    const v = rig.RPW.bossView();
    if (!v) return;
    const H0 = v.arms[0].H, H2 = v.arms[2].H;
    life.push({ t: R.t, half: R.half, rc: Math.min(b.arms[0].rc, b.arms[2].rc), rw: Math.min(b.arms[0].rw, b.arms[2].rw), sep: Math.hypot(H0[0] - H2[0], H0[1] - H2[1]) });
    // a beam that lands on the seam is already answered: the boss does not burn while the hands come together
  });
  assert.ok(mirrors >= 3, "only " + mirrors + " whole mirrors to judge");
});

test("while the mirror is up its hands are busy: no wand casts, fuses or turns the hat, and they carry on afterwards", () => {
  let held = 0, resumed = 0;
  beamer([3, 4, 5, 6], 40, (b, me, prev) => {
    if (!prev) return;
    if (b.refl && prev.refl && prev.phase !== "spin"){
      held++;
      assert.strictEqual(b.fires, prev.fires, "a wand fired while the mirror was up");
      assert.strictEqual(b.phase, prev.phase, "the boss changed phase (" + prev.phase + " -> " + b.phase + ") with the mirror up");
      assert.strictEqual(b.flashN, prev.flashN, "a spell was fused with the mirror up");
      b.arms.forEach((A, i) => {
        assert.strictEqual(A.st, prev.arms[i].st, "wand " + A.id + " changed state with the mirror up");
        assert.ok(Math.abs(A.k - prev.arms[i].k) < 1e-9, "wand " + A.id + " went on charging with the mirror up");
      });
    }
    if (!b.refl && prev.refl) resumed = 0;
    if (!b.refl && resumed >= 0 && b.fires > prev.fires) resumed++;
  });
  assert.ok(held > 60, "only " + held + " frames of mirror to judge");
  assert.ok(resumed >= 1, "the wands never went back to casting after a mirror");
});

test("the mirror has its own sound, and only when a mirror goes up", () => {
  let opens = 0, stray = 0;
  beamer([3, 4, 5, 6], 40, (b, me, prev, i, seed, prevMe, rig) => {
    const log = rig.RPW.sfxLog().filter(c => c.name === "reflect");
    rig.RPW.sfxClear();
    const opened = b.refl && !(prev && prev.refl);
    if (opened){
      opens++;
      assert.strictEqual(log.length, 1, "the mirror went up with " + log.length + " reflect cues");
      assert.ok(log[0].vol > .3, "cue " + JSON.stringify(log[0]));
    } else if (log.length) stray++;
  });
  assert.ok(opens >= 3, "only " + opens + " mirrors");
  assert.strictEqual(stray, 0, stray + " reflect cues with no mirror going up");
});

console.log("\nthe Alchemist: sound");

test("when the hat stops and locks the two new spells, the two lock-in sounds play together, and only then", () => {
  const rig = bossRig(9);
  let locks = 0, prevPhase = null;
  for (let i = 0; i < 60 * 45; i++){
    rig.RPW.sfxClear();
    rig.step();
    const b = rig.RPW.bossState();
    if (!b) continue;
    const names = rig.RPW.sfxLog().map(c => c.name);
    const a = names.includes("lockin"), c = names.includes("lockin3");
    const landed = prevPhase === "spin" && b.phase !== "spin";
    if (landed){
      locks++;
      assert.ok(a && c, "the hat landed with " + JSON.stringify(names));
      const log = rig.RPW.sfxLog();
      assert.ok(log.every(q => q.vol > .3), "a lock-in cue was near-silent");
    } else assert.ok(!a && !c, "a lock-in sound played with the hat still turning (" + b.phase + ")");
    prevPhase = b.phase;
  }
  assert.ok(locks >= 2, "only " + locks + " spins finished in 45 seconds");
});

test("the boss alert: the music goes down, the alert plays once, the music comes back — for the boss test, and for a real run after wave 8", () => {
  const seq = rig => {
    const log = []; let minDuck = 1, alertAt = -1, backAt = -1, sawDown = false;
    for (let i = 0; i < 60 * 16; i++){
      rig.step();
      const A = rig.RPW.audioState();
      for (const c of rig.RPW.sfxLog()) if (c.name === "bossalert") log.push(i);
      rig.RPW.sfxClear();
      minDuck = Math.min(minDuck, A.duck);
      if (A.alert === 2 && alertAt < 0) alertAt = i;
      if (A.duck < .999) sawDown = true;
      if (sawDown && A.duck >= .999 && backAt < 0) backAt = i;
    }
    return { log, minDuck, alertAt, backAt, end: rig.RPW.audioState() };
  };
  // the boss test: wave 8 is already behind you
  let r = seq(bossRig(5));
  assert.strictEqual(r.log.length, 1, "the alert was asked for " + r.log.length + " times");
  assert.ok(r.minDuck < .4 && r.minDuck > .3, "the music went down to " + r.minDuck.toFixed(2));
  const lead = r.log[0] / 60;
  assert.ok(lead >= .55 && lead < 3, "the alert came " + lead.toFixed(2) + "s in (the run's own countdown first, then the music goes down)");
  assert.ok(r.backAt / 60 > 7, "the music was back at " + (r.backAt / 60).toFixed(1) + "s, before the alert can have finished");
  assert.strictEqual(r.end.duck, 1, "the music never came back");
  assert.strictEqual(r.end.alert, 0);
  // a real run: nothing before wave 8 falls, the alert as it does
  const rig = boot({ seed: 11, diff: 1, room: 1, humans: 1, opts: { coop: 1, mapPreset: "random" } });
  rig.RPW.skipToWave(7);
  const rivals = () => rig.RPW.sides().filter(w => !w.ally);
  for (let i = 0; i < 600 && rivals().length === 0; i++) rig.step();
  for (let i = 0; i < 120; i++) rig.step();
  assert.strictEqual(rig.RPW.audioState().alert, 0, "the alert sounded before wave 8 was cleared");
  assert.ok(!rig.RPW.sfxLog().some(c => c.name === "bossalert"));
  for (const w of rivals()) rig.RPW.smite(w.id);
  rig.step();
  assert.ok(rig.RPW.audioState().alert > 0 || rig.RPW.audioState().duckTo < 1, "wave 8 fell and the music stayed up");
  for (let i = 0; i < 120; i++) rig.step();
  assert.ok(rig.RPW.sfxLog().filter(c => c.name === "bossalert").length === 1, "the alert did not sound after wave 8");
  for (let i = 0; i < 60 * 12; i++) rig.step();
  assert.strictEqual(rig.RPW.audioState().duck, 1, "the music did not come back");
  assert.ok(rig.RPW.sfxLog().filter(c => c.name === "bossalert").length === 1, "the alert sounded again");
});

test("the fused orb has its own sound: once, as the Sparkwheel is launched, and at no other moment", () => {
  let launches = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]){
    const rig = bossRig(seed);
    let prev = null;
    for (let i = 0; i < 60 * 45; i++){
      rig.RPW.sfxClear();
      rig.step();
      const b = rig.RPW.bossState();
      if (b && b.dead) break;
      if (!b) continue;
      const me = rig.RPW.sides().find(w => w.ally);
      if (me) rig.RPW.setVitals(me.id, 100, 100);
      const hex = rig.RPW.sfxLog().filter(c => c.name === "hexspark");
      const launched = prev && prev.fuse && prev.fuse.stage === 1 && !b.fuse && b.combo === "wheel";
      if (launched){
        launches++;
        assert.strictEqual(hex.length, 1, "seed " + seed + ": the orb left with " + hex.length + " hexspark cues");
        assert.ok(hex[0].vol > .3, "the hexspark cue was near-silent");
        assert.ok(!rig.RPW.sfxLog().some(c => c.boss && c.name === "cast:hex"), "the Sparkwheel also made the ordinary hex sound");
      } else assert.strictEqual(hex.length, 0, "seed " + seed + ": hexspark sounded at frame " + i + " (phase " + b.phase + ", fuse " + JSON.stringify(b.fuse) + ")");
      prev = b;
    }
  }
  assert.ok(launches >= 3, "only " + launches + " Sparkwheels in eight fights");
});

test("Hexswarm has its own sound: once, as the missile stream starts, and at no other moment", () => {
  let launches = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]){
    const rig = bossRig(seed);
    let prev = null;
    for (let i = 0; i < 60 * 45; i++){
      rig.RPW.sfxClear();
      rig.step();
      const b = rig.RPW.bossState();
      if (b && b.dead) break;
      if (!b) continue;
      const me = rig.RPW.sides().find(w => w.ally);
      if (me) rig.RPW.setVitals(me.id, 100, 100);
      const hr = rig.RPW.sfxLog().filter(c => c.name === "hexrive");
      const launched = prev && prev.fuse && prev.fuse.stage === 1 && !b.fuse && b.combo === "swarm";
      if (launched){
        launches++;
        assert.strictEqual(hr.length, 1, "seed " + seed + ": the stream started with " + hr.length + " hexrive cues");
        assert.ok(hr[0].vol > .3, "the hexrive cue was near-silent");
        assert.ok(!rig.RPW.sfxLog().some(c => c.boss && c.name === "cast:rive"), "Hexswarm also made the ordinary rive sound");
      } else assert.strictEqual(hr.length, 0, "seed " + seed + ": hexrive sounded at frame " + i + " (phase " + b.phase + ", fuse " + JSON.stringify(b.fuse) + ")");
      prev = b;
    }
  }
  assert.ok(launches >= 3, "only " + launches + " Hexswarms in eight fights");
});

test("the Prism Lance fires the instant it fuses, with no wind-up, has its own sound, and cuts off quickly when it ends", () => {
  let launches = 0, endings = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]){
    const rig = bossRig(seed);
    let prevPrism = false, sawStart = false;
    for (let i = 0; i < 60 * 45; i++){
      rig.RPW.sfxClear();
      rig.step();
      const b = rig.RPW.bossState();
      if (b && b.dead) break;
      if (!b) continue;
      const me = rig.RPW.sides().find(w => w.ally);
      if (me) rig.RPW.setVitals(me.id, 100, 100);
      const boss = rig.RPW.sides().find(w => !w.ally);
      const started = !prevPrism && b.prism;
      const ended = prevPrism && !b.prism;
      if (started){
        launches++; sawStart = true;
        assert.ok(boss.beamOn && boss.beamWind >= 0.999, "seed " + seed + ": the lance wound up first (beamWind " + boss.beamWind + ")");
        const pl = rig.RPW.sfxLog().filter(c => c.name === "prismlance");
        assert.strictEqual(pl.length, 1, "seed " + seed + ": the lance fired with " + pl.length + " prismlance cues");
        assert.ok(pl[0].vol > .3, "the prismlance cue was near-silent");
      }
      if (ended && sawStart){
        endings++;
        const A = rig.RPW.audioState();
        const f = A.fades.find(q => q.name === "prismlance");
        assert.ok(!f || f.out, "the prismlance cue was still playing at full after the lance ended");
      }
      prevPrism = b.prism;
    }
  }
  assert.ok(launches >= 3, "only " + launches + " Prism Lances in eight fights");
  assert.ok(endings >= 3, "only " + endings + " of them were seen to end");
});

test("the Prism Lance overwhelms a beam of the player's at once, not over the usual couple of seconds", () => {
  let overlaps = 0, snaps = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]){
    const rig = bossRig(seed);
    let inOverlap = false;
    for (let i = 0; i < 60 * 45; i++){
      const b0 = rig.RPW.bossState();
      if (b0 && b0.dead) break;
      const me0 = rig.RPW.sides().find(w => w.ally);
      if (me0 && b0){
        if (me0.hp < 60) rig.RPW.setVitals(me0.id, 100, me0.mana);
        if (me0.mana < 40) rig.RPW.setVitals(me0.id, me0.hp, 100);
        if (b0.phase !== "intro" && !me0.beamOn) rig.RPW.forceBeam(me0.id, true);
      }
      rig.step();
      const b = rig.RPW.bossState();
      if (b && b.dead) break;
      if (!b) continue;
      const me = rig.RPW.sides().find(w => w.ally);
      const boss = rig.RPW.sides().find(w => !w.ally);
      const clashing = b.prism && me && me.beamOn && boss.beamOn && me.beamLen > 0 && boss.beamLen > 0;
      if (clashing){
        const sep = Math.hypot(me.x - boss.x, me.y - boss.y) || 1;
        const ratio = me.beamLen / sep;
        if (!inOverlap){
          overlaps++;
          if (ratio <= 0.25) snaps++;
        }
        inOverlap = true;
      } else inOverlap = false;
    }
  }
  assert.ok(overlaps >= 1, "the Prism Lance never met a beam of the player's in these fights");
  assert.ok(snaps === overlaps, "the player's share of the orb was not already small the instant the lance met the beam");
});

test("Needle Rain has its own sound: once, as the volley is launched, and at no other moment", () => {
  let launches = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]){
    const rig = bossRig(seed);
    let prev = null;
    for (let i = 0; i < 60 * 45; i++){
      rig.RPW.sfxClear();
      rig.step();
      const b = rig.RPW.bossState();
      if (b && b.dead) break;
      if (!b) continue;
      const me = rig.RPW.sides().find(w => w.ally);
      if (me) rig.RPW.setVitals(me.id, 100, 100);
      const sr = rig.RPW.sfxLog().filter(c => c.name === "sparkrive");
      const launched = prev && prev.fuse && prev.fuse.stage === 1 && !b.fuse && b.combo === "needle";
      if (launched){
        launches++;
        assert.strictEqual(sr.length, 1, "seed " + seed + ": the volley left with " + sr.length + " sparkrive cues");
        assert.ok(sr[0].vol > .3, "the sparkrive cue was near-silent");
        assert.ok(!rig.RPW.sfxLog().some(c => c.boss && (c.name === "cast:spark" || c.name === "cast:rive")),
                   "Needle Rain also made an ordinary spark/rive sound");
      } else assert.strictEqual(sr.length, 0, "seed " + seed + ": sparkrive sounded at frame " + i + " (phase " + b.phase + ", fuse " + JSON.stringify(b.fuse) + ")");
      prev = b;
    }
  }
  assert.ok(launches >= 3, "only " + launches + " Needle Rains in eight fights");
});

test("when the Alchemist takes the field its own theme fades in over the ladder music, and the ladder music comes back when it falls", () => {
  // the boss test: the boss is already on the field a moment after it starts
  const rig = bossRig(6);
  assert.strictEqual(rig.RPW.audioState().track, "battle", "the boss test did not start on the ladder music");
  let sawBoss = false;
  for (let i = 0; i < 60 * 3 && !sawBoss; i++){ rig.step(); if (rig.RPW.bossState()) sawBoss = true; }
  assert.ok(sawBoss, "the boss never arrived");
  assert.strictEqual(rig.RPW.audioState().track, "boss", "the Alchemist's theme did not take over when it arrived");
  // past its spawn grace, so a strike actually lands
  for (let i = 0; i < 200 && !(rig.RPW.bossState() && rig.RPW.bossState().phase === "live"); i++) rig.step();
  rig.RPW.smite(rig.RPW.sides().find(w => !w.ally).id);
  rig.step();
  assert.strictEqual(rig.RPW.audioState().track, "battle", "the ladder music did not come back once the boss fell");
  // and in a real run reaching the boss the same way, not just the boss test's shortcut
  const real = boot({ seed: 11, diff: 1, room: 1, humans: 1, opts: { coop: 1, mapPreset: "random" } });
  real.RPW.skipToWave(7);
  const rivals = () => real.RPW.sides().filter(w => !w.ally);
  for (let i = 0; i < 600 && rivals().length === 0; i++) real.step();
  for (const w of rivals()) real.RPW.smite(w.id);
  assert.strictEqual(real.RPW.audioState().track, "battle", "the theme changed before the boss actually arrived");
  let arrived = false;
  for (let i = 0; i < 300 && !arrived; i++){ real.step(); if (real.RPW.bossState()) arrived = true; }
  assert.ok(arrived, "the boss never showed up after wave 8");
  assert.strictEqual(real.RPW.audioState().track, "boss", "the theme did not switch over for a real run's boss");
});

test("the reflect sounds: the return of the beam has its own, with the raise; both die away with the glass, neither fades in", () => {
  let opens = 0, checked = 0;
  const seen = new Map();          // seed -> the mirror being followed
  beamer([3, 4, 5, 6], 40, (b, me, prev, i, seed, prevMe, rig) => {
    const log = rig.RPW.sfxLog(); rig.RPW.sfxClear();
    const A = rig.RPW.audioState();
    const r2 = log.filter(c => c.name === "reflect"), r3 = log.filter(c => c.name === "reflect3");
    const opened = b.refl && !(prev && prev.refl);
    let m = seen.get(seed);
    if (opened){
      opens++; m = { open: i, bounce: -1, closed: -1, v: {} }; seen.set(seed, m);
      const f = A.fades.filter(q => q.name === "reflect");
      assert.ok(f.length === 1 && f[0].k > .99, "the raise fades in: " + JSON.stringify(f));
    }
    if (r3.length){
      assert.ok(m && b.refl, "a reflect3 with no mirror up");
      assert.strictEqual(m.bounce, -1, "reflect3 sounded twice for one mirror");
      m.bounce = i - m.open;
      assert.ok(r3[0].vol > .3);
      const f = A.fades.filter(q => q.name === "reflect3");
      assert.ok(f.length === 1 && f[0].k > .99, "the bounce fades in: " + JSON.stringify(f));
    }
    if (m && m.closed < 0 && prev && prev.refl && !b.refl){ m.closed = i; }
    if (m && m.closed >= 0){
      // after the glass is gone both sounds go down and out, and never back up
      for (const name of ["reflect", "reflect3"]){
        const f = A.fades.find(q => q.name === name);
        if (f){
          assert.ok(f.out, name + " was not told to fade at the close");
          if (m.v[name] !== undefined) assert.ok(f.v <= m.v[name] + 1e-9, name + " came back up after the glass went");
          m.v[name] = f.v;
        }
      }
      if (i - m.closed >= 40){
        assert.ok(!A.fades.some(q => /^reflect/.test(q.name)), "a reflect sound was still going " + (i - m.closed) + " frames after the glass went");
        if (m.bounce >= 0) checked++;
        seen.delete(seed);
      }
    }
  });
  assert.ok(opens >= 3, "only " + opens + " mirrors");
  assert.ok(checked >= 2, "only " + checked + " mirrors with a bounce were followed to the end");
});

test("the hat's whirr fades in as the spin starts and out as it stops; the boss alert fades in", () => {
  const rig = bossRig(9);
  let spins = 0, prevPhase = null, sawIn = false, checkedOut = 0, startAt = -1, endAt = -1, alertIn = false, lastV = null;
  for (let i = 0; i < 60 * 40; i++){
    rig.RPW.sfxClear();
    rig.step();
    const b = rig.RPW.bossState();
    if (!b) continue;
    const log = rig.RPW.sfxLog(), A = rig.RPW.audioState();
    const sp = A.fades.find(q => q.name === "spinner");
    const started = b.phase === "spin" && prevPhase !== "spin";
    if (started){
      spins++; startAt = i;
      assert.strictEqual(log.filter(c => c.name === "spinner").length, 1, "the spin started with the whirr asked for " + log.filter(c => c.name === "spinner").length + " times");
      assert.ok(sp && sp.k < .2, "the whirr did not start from nothing: " + JSON.stringify(sp));
      lastV = null;
    } else assert.ok(!log.some(c => c.name === "spinner"), "the whirr was started with the hat not starting to turn");
    if (b.phase === "spin" && sp){
      if (lastV !== null) assert.ok(Math.abs(sp.v - lastV) < .08, "the whirr jumped by " + (sp.v - lastV).toFixed(3) + " in a frame");
      lastV = sp.v;
      if (i - startAt > 30) { assert.ok(sp.k > .99, "still fading in " + (i - startAt) + " frames into the spin (" + sp.k.toFixed(2) + ")"); sawIn = true; }
      assert.ok(!sp.out, "the whirr was fading out with the hat still turning");
    }
    if (prevPhase === "spin" && b.phase !== "spin"){
      endAt = i;
      assert.ok(sp && sp.out, "the whirr was not told to fade when the spin stopped: " + JSON.stringify(sp));
      lastV = sp.v;
    } else if (endAt >= 0 && i > endAt && i - endAt < 40 && sp){
      assert.ok(sp.out && sp.v <= lastV + 1e-9, "the whirr came back up after the spin");
      lastV = sp.v;
    }
    if (endAt >= 0 && i - endAt >= 40 && b.phase !== "spin"){
      assert.ok(!A.fades.some(q => q.name === "spinner"), "the whirr was still going " + (i - endAt) + " frames after the spin");
      if (i - endAt === 40) checkedOut++;
    }
    prevPhase = b.phase;
  }
  assert.ok(spins >= 3 && sawIn && checkedOut >= 2, spins + " spins, faded in " + sawIn + ", faded out " + checkedOut);
  // the alert: up from nothing over its first moments
  const rig2 = bossRig(5);
  let first = -1, vs = [];
  for (let i = 0; i < 60 * 8; i++){
    rig2.step();
    const f = rig2.RPW.audioState().fades.find(q => q.name === "bossalert");
    if (f){ if (first < 0) first = i; vs.push(f.k); }
  }
  assert.ok(first >= 0 && vs[0] < .1, "the alert did not start from nothing (" + vs[0] + ")");
  assert.ok(vs.length > 60 && vs[45] > .9 && vs[vs.length - 1] > .99, "the alert did not come up to full (" + vs[45] + ")");
  for (let i = 1; i < vs.length; i++) assert.ok(vs[i] >= vs[i - 1] - 1e-9, "the alert dipped on the way up");
});



test("the slot-machine reels run while the hat turns and are stopped dead the moment the spells lock in", () => {
  const rig = bossRig(9);
  let spins = 0, prevPhase = null, stopAt = -1, checked = 0, startAt = -1;
  for (let i = 0; i < 60 * 40; i++){
    rig.RPW.sfxClear();
    rig.step();
    const b = rig.RPW.bossState();
    if (!b) continue;
    const log = rig.RPW.sfxLog(), A = rig.RPW.audioState();
    const f = A.fades.find(q => q.name === "slotspin");
    const started = b.phase === "spin" && prevPhase !== "spin";
    const landed = prevPhase === "spin" && b.phase !== "spin";
    if (started){
      spins++; startAt = i;
      assert.strictEqual(log.filter(c => c.name === "slotspin").length, 1, "the spin started with the reels asked for " + log.filter(c => c.name === "slotspin").length + " times");
      assert.ok(log.find(c => c.name === "slotspin").vol > .4, "the reels were near-silent");
      assert.ok(f && f.k > .99, "the reels did not start at once: " + JSON.stringify(f));
    } else assert.ok(!log.some(c => c.name === "slotspin"), "the reels were started with the hat not starting to turn");
    if (b.phase === "spin" && startAt >= 0 && i > startAt){
      assert.ok(f && !f.out && f.k > .99, "the reels were not running at full through the spin (frame " + (i - startAt) + ": " + JSON.stringify(f) + ")");
    }
    if (landed){
      stopAt = i;
      assert.ok(log.some(c => c.name === "lockin") && log.some(c => c.name === "lockin3"), "the spells locked in without the lock-in sounds");
      assert.ok(f && f.out, "the reels were not stopped when the spells locked in: " + JSON.stringify(f));
    } else if (stopAt >= 0 && i > stopAt && i - stopAt <= 12 && f){
      assert.ok(f.out, "the reels came back after the lock");
    }
    if (stopAt >= 0 && i - stopAt === 12 && b.phase !== "spin"){
      assert.ok(!A.fades.some(q => q.name === "slotspin"), "the reels were still going " + (i - stopAt) + " frames after the spells locked in");
      checked++;
    }
    prevPhase = b.phase;
  }
  assert.ok(spins >= 3 && checked >= 2, spins + " spins, " + checked + " stopped");
});

test("when it is not fusing, each spell it throws on its own has the usual spell sound, as loud as yours", () => {
  const seen = { spark: 0, rive: 0, hex: 0, ward: 0 }, sound = { spark: 0, rive: 0, hex: 0, ward: 0 };
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]){
    const rig = bossRig(seed);
    let prev = null;
    for (let i = 0; i < 60 * 45; i++){
      rig.RPW.sfxClear();
      rig.step();
      const b = rig.RPW.bossState();
      if (b && b.dead) break;
      if (!b) continue;
      const me = rig.RPW.sides().find(w => w.ally); if (me) rig.RPW.setVitals(me.id, 100, 100);
      if (prev && prev.phase === "live" && b.phase !== "intro"){
        const mine = rig.RPW.sfxLog().filter(c => c.boss);
        b.arms.forEach((A, k) => {
          const P = prev.arms[k];
          if (!A.live || !P.live) return;
          let spell = null;
          if (A.spell === "spark" && P.st === 0 && A.st === 2) spell = "spark";                                        // a burst starts
          else if (["rive", "hex", "ward"].includes(A.spell) && P.st === 0 && A.st === 0 && P.k > .95 && A.k < .5) spell = A.spell;   // a wand lets go
          if (!spell) return;
          seen[spell]++;
          const c = mine.filter(q => q.name === "cast:" + spell);
          if (c.length){ sound[spell]++; assert.ok(c[0].vol >= .5, spell + " played at " + c[0].vol + ": quieter than yours"); }
        });
      }
      prev = b;
    }
  }
  for (const k of ["spark", "rive", "hex"]) assert.ok(seen[k] >= 4, "only saw " + seen[k] + " " + k + " casts");
  for (const k in seen) assert.strictEqual(sound[k], seen[k], seen[k] + " " + k + " casts, " + sound[k] + " with their sound");
});

console.log("\nthe Alchemist: determinism");

function marks(seed, opts){
  const rig = bossRig(seed, opts), out = [];
  for (let i = 0; i < 60 * 30; i++){ rig.step(); if (i % 20 === 0) out.push(rig.RPW.hash()); }
  return out;
}
test("same seed, same fight, checkpoint for checkpoint", () => {
  for (const seed of [1, 2, 3]) assert.deepStrictEqual(marks(seed), marks(seed), "seed " + seed);
});
test("and on an engine whose trig is one bit out", () => {
  for (const seed of [1, 2, 3]) assert.deepStrictEqual(marks(seed), marks(seed, { skew: true }), "seed " + seed);
});
function beamMarks(seed, opts){
  const rig = bossRig(seed, opts), out = [];
  let mirrors = 0;
  for (let i = 0; i < 60 * 30; i++){
    rig.step();
    const b = rig.RPW.bossState(), me = rig.RPW.sides().find(w => w.ally);
    if (b) mirrors = Math.max(mirrors, b.reflN);
    if (b && !b.dead && me && !me.dead){
      if (b.phase !== "intro" && !b.beamUp && b.los && me.mana > 30) rig.RPW.forceBeam(me.id, true);
      if (me.hp < 60) rig.RPW.setVitals(me.id, 100, me.mana);
      if (me.mana < 40) rig.RPW.setVitals(me.id, me.hp, 100);
    }
    if (i % 20 === 0) out.push(rig.RPW.hash());
  }
  assert.ok(mirrors >= 2, "the mirror was in the fight (" + mirrors + ")");
  return out;
}
test("with a beam on it all fight, mirror and returned beam included: same seed, same fight — and on a trig one bit out", () => {
  for (const seed of [3, 5]){
    assert.deepStrictEqual(beamMarks(seed), beamMarks(seed), "seed " + seed);
    assert.deepStrictEqual(beamMarks(seed), beamMarks(seed, { skew: true }), "seed " + seed + " on the skewed engine");
  }
});
test("and from another seat in a four-player co-op run that reaches the boss", () => {
  const run = seat => {
    const rig = boot({ seed: 5, diff: 1, room: 4, humans: 4, seat, opts: { coop: 1, mapPreset: "random" } });
    rig.RPW.skipToWave(8);
    const out = [];
    for (let i = 0; i < 60 * 25; i++){ rig.step(); if (i % 20 === 0) out.push(rig.RPW.hash()); }
    assert.ok(rig.RPW.bossState(), "the boss came in the co-op run");
    assert.ok(rig.RPW.bossState().hpMax > 300, "and it scaled for the party (" + rig.RPW.bossState().hpMax + ")");
    return out;
  };
  assert.deepStrictEqual(run(0), run(3));
});

console.log("\n" + pass + " passed" + (process.exitCode ? " — with failures" : ""));
