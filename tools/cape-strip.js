/*
 * Draw the cape, so a person can look at it.
 *
 * Every other cape tool here prints numbers, and numbers are what let a cape
 * that reads as a plank pass a suite about lag. This one traces the actual
 * silhouette out of the running game, frame by frame, through a hard direction
 * reversal — and puts the old build's cape beside the new one on the same
 * motion so the difference is visible rather than argued.
 *
 *   node tools/cape-strip.js  [out.svg]
 *
 * RPW_GAME_SRC picks which game.js the rig boots, which is how "before" is got.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const OUT = process.argv[2] || path.join(__dirname, "..", "Claude outputs", "cape-before-after.svg");
const LEVEL = 11;
const EVERY = 6, SHOTS = 9;

/* One run, in a child process, because the rig caches the game source at
   require time and we need two different sources in one report. */
function trace(src){
  const script = `
    const { boot } = require(${JSON.stringify(path.join(__dirname, "determinism.js"))});
    const rig = boot({ seed: 5, diff: 0, room: 2, humans: 1, opts: { mapPreset: "arena" } });
    rig.RPW.startMatch({ mode: "match", seed: 5, difficulty: 0, total: 2, humans: 1,
                         seat: 0, levels: [${LEVEL}, ${LEVEL}], opts: { mapPreset: "arena" } });
    for (let i = 0; i < 200; i++) rig.step();
    rig.fire("keydown", "d");
    for (let i = 0; i < 60; i++) rig.step();
    rig.fire("keyup", "d"); rig.fire("keydown", "a");     // hard reversal
    const out = [];
    for (let i = 0; i < ${EVERY * SHOTS}; i++){
      rig.step();
      if (i % ${EVERY} === 0){
        const c = rig.RPW.capeOf(0);
        out.push({ left: c.left, right: c.right, nodes: c.nodes });
      }
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const env = Object.assign({}, process.env);
  if (src) env.RPW_GAME_SRC = src; else delete env.RPW_GAME_SRC;
  return JSON.parse(execFileSync(process.execPath, ["-e", script], { env, maxBuffer: 1 << 24 }));
}

const before = trace(process.env.RPW_OLD_SRC || "/tmp/rpwold/game.js");
const after  = trace(null);

const W = 96, H = 118, PAD = 8;
const poly = (row, i, ox, oy, fill, stroke) => {
  const s = row[i];
  const pts = s.left.concat(s.right.slice().reverse())
    .map(p => (ox + p.x).toFixed(1) + "," + (oy + p.y).toFixed(1)).join(" ");
  return `<polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="0.9"/>`;
};
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PAD * 2 + W * SHOTS}" height="${PAD * 2 + H * 2 + 34}" viewBox="0 0 ${PAD * 2 + W * SHOTS} ${PAD * 2 + H * 2 + 34}">`;
svg += `<rect width="100%" height="100%" fill="#12131a"/>`;
svg += `<text x="${PAD}" y="${PAD + 12}" fill="#8b90a6" font-family="system-ui,sans-serif" font-size="12">before — one rigid arc swinging about the collar</text>`;
svg += `<text x="${PAD}" y="${PAD + H + 28}" fill="#8b90a6" font-family="system-ui,sans-serif" font-size="12">after — the hem trails, overshoots and comes back</text>`;
for (let i = 0; i < SHOTS; i++){
  const ox = PAD + W * i + W / 2, oyA = PAD + 20 + H / 2, oyB = PAD + H + 36 + H / 2;
  svg += `<circle cx="${ox}" cy="${oyA}" r="7" fill="none" stroke="#454a63" stroke-width="1"/>`;
  svg += `<circle cx="${ox}" cy="${oyB}" r="7" fill="none" stroke="#454a63" stroke-width="1"/>`;
  svg += poly(before, i, ox, oyA, "rgba(150,160,200,0.20)", "#7f88ad");
  svg += poly(after,  i, ox, oyB, "rgba(150,200,170,0.20)", "#79c39a");
}
svg += `</svg>`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, svg);
console.log("wrote " + OUT);
