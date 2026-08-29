/*
 * Build a single self-contained HTML file.
 *
 * Inlines src/style.css, src/game.js, src/net.js and every audio file as a
 * data: URI, so the result runs from a file:// path, an email attachment, or
 * anywhere that will not serve a folder.
 *
 *   node tools/build-single.js [outfile]     # default: dist/rock-paper-wizards.html
 *
 * The trade is size: roughly 3.5MB, because the audio is base64. For the web
 * build, deploy the folder as it is instead — the browser will cache the audio
 * separately and the page itself stays under 30KB.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = process.argv[2] || path.join(root, "dist", "rock-paper-wizards.html");

const read = p => fs.readFileSync(path.join(root, p), "utf8");
const dataUri = p =>
  "data:audio/mpeg;base64," + fs.readFileSync(path.join(root, p)).toString("base64");

let html = read("index.html");

// styles
html = html.replace(
  '<link rel="stylesheet" href="src/style.css">',
  "<style>\n" + read("src/style.css") + "\n</style>"
);

// scripts (match the src with an optional ?v= cache-bust query)
html = html.replace(
  /<script src="src\/game\.js(\?[^"]*)?"[^>]*><\/script>/,
  "<script>\n" + read("src/game.js") + "\n</script>"
);
html = html.replace(
  /<script src="src\/net\.js(\?[^"]*)?"[^>]*><\/script>/,
  "<script>\n" + read("src/net.js") + "\n</script>"
);

// audio
let audioCount = 0;
html = html.replace(/src="(assets\/audio\/[^"]+)"/g, (_, file) => {
  audioCount++;
  return 'src="' + dataUri(file) + '"';
});

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);

const mb = (Buffer.byteLength(html) / 1048576).toFixed(2);
console.log(`wrote ${out}`);
console.log(`  ${mb} MB, ${audioCount} audio files inlined`);
