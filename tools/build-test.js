/*
 * Can two clients tell they are running different programs?
 *
 * index.html is served fresh on every visit; game.js is served with four hours
 * of browser cache. Reuse a ?v= number across a deploy and one player is running
 * last night's game.js while the other is running this morning's — and both
 * report the same version, because the version is the thing that is wrong.
 *
 * So the build id carries a fingerprint of the code the client is actually
 * executing. This checks that it does, that it changes when the code changes,
 * and that a client which cannot compute one degrades to the version tag rather
 * than being locked out.
 *
 *   node tools/build-test.js
 */
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const gameSrc = fs.readFileSync(path.join(SRC, "game.js"), "utf8");
const netSrc  = fs.readFileSync(path.join(SRC, "net.js"),  "utf8");
const acctSrc = fs.readFileSync(path.join(SRC, "account.js"), "utf8");

let pass = 0; const fails = [];
const ok = (name, cond, extra) => {
  if (cond){ pass++; console.log("  ok  " + name); }
  else { console.log("FAIL  " + name + (extra ? "\n      " + extra : "")); fails.push(name); }
};

const gradStub = { addColorStop(){} };
const ctxStub = () => new Proxy({}, {
  get(t, p){ if (p in t) return t[p];
             if (p === "createRadialGradient" || p === "createLinearGradient") return () => gradStub;
             if (p === "canvas") return { width: 960, height: 620 };
             return () => {}; },
  set(t, p, v){ t[p] = v; return true; } });
function fakeEl(id){
  const children = [];
  const el = { id, style:{ setProperty(){} }, textContent:"", innerHTML:"",
    classList:{ toggle(){}, add(){}, remove(){}, contains(){ return false; } },
    dataset:{}, hidden:false, children,
    appendChild(c){ children.push(c); return c; }, _ls:{},
    addEventListener(t, fn){ (el._ls[t] ||= []).push(fn); },
    focus(){}, play(){ return { catch(){} }; }, pause(){}, setAttribute(){},
    volume:1, currentTime:0, closest(){ return null; },
    getContext(){ return ctxStub(); }, width:960, height:620 };
  Object.defineProperty(el, "length", { get: () => children.length });
  el[Symbol.iterator] = function*(){ yield* children; };
  return el;
}

/* one client, running exactly the code it is handed and serving exactly that
   code back to its own fetch — which is what a browser cache does */
function boot({ version, game, net, account, withFetch = true }){
  const els = {};
  const files = {
    ["src/game.js?v=" + version]: game,
    ["src/net.js?v=" + version]: net,
    ["src/account.js?v=" + version]: account
  };
  const tags = Object.keys(files).map(src => ({ getAttribute: a => a === "src" ? src : null }));
  const sandbox = {
    console, performance: { now: () => 0 },
    requestAnimationFrame(){ return 1; }, setTimeout(){ return 0; }, clearTimeout(){},
    setInterval(){ return 0; }, clearInterval(){},
    Math, Date, Object, Array, JSON, Symbol, Proxy, Number, String, Boolean, Error, Promise,
    document: {
      getElementById(id){ return els[id] || (els[id] = fakeEl(id)); },
      createElement(tag){ return fakeEl(tag); },
      getElementsByTagName(t){ return t === "script" ? tags : []; }
    },
    WebSocket: function(){ this.readyState = 0; },
    navigator: { clipboard: null },
    localStorage: { getItem(){ return null; }, setItem(){} }
  };
  if (withFetch) sandbox.fetch = async (u) => {
    if (!(u in files)) throw new Error("404 " + u);
    return { text: async () => files[u] };
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.window.matchMedia = () => ({ matches: false });
  sandbox.window.addEventListener = () => {};
  sandbox.addEventListener = () => {};
  sandbox.window.RPW_RELAY = "wss://fake/ws";
  els.pips = fakeEl("pips"); els.pips.appendChild(fakeEl("pip")); els.pips.appendChild(fakeEl("pip"));
  els.diffRow = fakeEl("diffRow");
  for (let i = 0; i < 4; i++) els.diffRow.appendChild(fakeEl("d" + i));
  vm.createContext(sandbox);
  vm.runInContext(acctSrc, sandbox, { filename: "account.js" });
  vm.runInContext(game,    sandbox, { filename: "game.js" });
  vm.runInContext(net,     sandbox, { filename: "net.js" });
  return sandbox;
}

/* a change to the SIMULATION, of the size a real commit makes */
const gameChanged = (() => {
  const from = "const DASH_CD = 3;";
  if (!gameSrc.includes(from)) throw new Error("anchor for the mutated build is gone: " + from);
  return gameSrc.replace(from, "const DASH_CD = 4;");
})();

(async () => {
  const base = { version: "59", game: gameSrc, net: netSrc, account: acctSrc };
  const A = boot(base);
  const B = boot(base);
  const C = boot({ ...base, game: gameChanged });
  const D = boot({ ...base, withFetch: false });
  const E = boot({ ...base, version: "60" });
  await new Promise(r => setImmediate(r));   // let each fingerprint settle

  const id = s => s.window.RPW.NET.build();
  const idA = id(A), idB = id(B), idC = id(C), idD = id(D), idE = id(E);
  console.log("  A " + idA + "\n  B " + idB + "\n  C " + idC + " (DASH_CD changed)\n  D " + idD + " (no fetch)\n  E " + idE + " (v60)");

  ok("a client fingerprints the code it is running", /^59\.[0-9a-z]+$/.test(idA), "got " + idA);
  ok("two clients on identical code agree", idA === idB, idA + " vs " + idB);
  ok("one changed simulation constant is a different build", idA !== idC,
     "DASH_CD 3 and DASH_CD 4 both call themselves " + idA + " — this is the bug");
  ok("and it is the FINGERPRINT that differs, not the version",
     idC.split(".")[0] === "59" && idC.split(".")[1] !== idA.split(".")[1],
     idA + " vs " + idC);
  ok("a client that cannot fingerprint itself still reports its version", idD === "59", "got " + idD);
  ok("a different version tag still shows", idE.split(".")[0] === "60", "got " + idE);

  /* the relay is the half that acts on it */
  const { buildsDiffer } = require("../server/rooms");
  ok("the relay refuses a room holding both", buildsDiffer(new Set([idA, idC])) === true);
  ok("the relay allows a room holding matching clients", buildsDiffer(new Set([idA, idB])) === false);
  ok("the relay does not lock out a client with no fingerprint",
     buildsDiffer(new Set([idA, idD])) === false,
     "a browser that cannot fetch its own scripts would never play again");
  ok("the relay still catches a plain version split", buildsDiffer(new Set([idA, idE])) === true);

  console.log("\n" + (fails.length ? fails.length + " FAILING" : pass + " passing"));
  process.exitCode = fails.length ? 1 : 0;
})();
