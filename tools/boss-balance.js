/*
 * How hard is the Alchemist? Plays the boss test with a bot in the player's seat
 * and reports how the fight went — win rate, how long, how much the bot had left.
 *
 *   node tools/boss-balance.js                   # 16 seeds, an Archmage-level bot
 *   LEVEL=1 SEEDS=30 node tools/boss-balance.js  # an Adept-level bot, more seeds
 *
 * The bot is the game's own AI (the same one that fills co-op seats), so this is
 * a floor on what a human can do, not a ceiling: a person dodges beams the bot
 * walks into. Read the numbers as "is it fair and finishable", not "is it easy".
 */
"use strict";
const { boot } = require("./determinism.js");
const SEEDS = +(process.env.SEEDS || 16), LEVEL = +(process.env.LEVEL || 2), SECS = +(process.env.SECS || 150);
const rows = [];
for (let seed = 1; seed <= SEEDS; seed++){
  const rig = boot({ seed });
  rig.RPW.bossTest(seed);
  rig.RPW.autoplay(LEVEL);
  let t = 0, res = "timeout", swaps = 0, lastPair = 0, beams = 0, wasBeam = false, minHp = 100;
  const seen = {};
  for (let i = 0; i < 60 * SECS; i++){
    rig.step();
    const b = rig.RPW.bossState();
    if (b){
      if (b.pair !== lastPair){ swaps++; lastPair = b.pair; }
      if (b.beamOn && !wasBeam) beams++;
      wasBeam = b.beamOn;
      for (const a of b.arms) if (a.live && a.st !== 3) seen[a.spell] = 1;
      if (b.dead){ res = "win"; t = i / 60; break; }
    }
    const me = rig.RPW.sides()[0];
    if (me) minHp = Math.min(minHp, me.hp);
    if (rig.RPW.phase() === "over"){ res = "loss"; t = i / 60; break; }
  }
  const b = rig.RPW.bossState();
  rows.push({ seed, res, t: t || SECS, bossHp: b ? b.hp : 0, minHp, swaps, beams, spells: Object.keys(seen).length });
}
const wins = rows.filter(r => r.res === "win");
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
for (const r of rows) console.log(`seed ${String(r.seed).padStart(2)}  ${r.res.padEnd(7)} ${r.t.toFixed(1).padStart(6)}s  boss hp left ${String(Math.round(r.bossHp)).padStart(3)}  swaps ${r.swaps}  beams ${r.beams}  spells seen ${r.spells}`);
console.log(`\nbot level ${LEVEL}: ${wins.length}/${rows.length} won` +
  (wins.length ? `, avg ${avg(wins.map(r => r.t)).toFixed(0)}s to kill` : "") +
  `, avg boss hp left in losses ${Math.round(avg(rows.filter(r => r.res !== "win").map(r => r.bossHp)))}`);
