/*
 * Matchmaking + relay tests. No dependencies, no ports: rooms.js is driven
 * through fake sockets, so this runs anywhere `node` runs.
 *
 *   node test-relay.js
 */

"use strict";

const assert = require("assert");
const { Player, handle, rooms, sweepStalled, STALL_MS, STALL_LAG, HASH_PARTS, partsSplit } = require("./rooms");

let pass = 0;
function test(name, fn) {
  rooms.clear();
  try {
    fn();
    pass++;
    console.log("  ok  " + name);
  } catch (e) {
    console.error("FAIL  " + name + "\n      " + e.message);
    process.exitCode = 1;
  }
}

/** a player whose outbox we can read back */
function fake(name, lv) {
  const inbox = [];
  const p = new Player({ send: raw => inbox.push(JSON.parse(raw)) });
  p.inbox = inbox;
  p.last = t => [...inbox].reverse().find(m => m.t === t);
  p.say = msg => handle(p, msg);
  p.say({ t: "hello", name, lv });
  return p;
}

test("create makes a room and seats the host at 0", () => {
  const a = fake("Green");
  a.say({ t: "create", total: 4, difficulty: 1 });
  const room = a.last("room");
  assert.ok(room, "expected a room message");
  assert.strictEqual(room.you, 0);
  assert.strictEqual(room.total, 4);
  assert.strictEqual(room.players.length, 1);
  assert.strictEqual(room.players[0].host, true);
  assert.match(room.code, /^[A-Z2-9]{4}$/);
});

test("join by code seats the guest and tells everyone", () => {
  const a = fake("Green");
  a.say({ t: "create", total: 4 });
  const code = a.last("room").code;

  const b = fake("Callum");
  b.say({ t: "join", code });

  assert.strictEqual(b.last("room").you, 1, "guest should be seat 1");
  assert.strictEqual(a.last("room").players.length, 2, "host should see two players");
  assert.deepStrictEqual(
    a.last("room").players.map(p => p.name),
    ["Green", "Callum"]
  );
});

test("a bad code is refused without disturbing anyone", () => {
  const a = fake("Green");
  a.say({ t: "join", code: "ZZZZ" });
  assert.strictEqual(a.last("error").why, "no room with that code");
  assert.strictEqual(rooms.size, 0);
});

test("a full room refuses the next arrival", () => {
  const a = fake("A");
  a.say({ t: "create", total: 2 });
  const code = a.last("room").code;
  fake("B").say({ t: "join", code });
  const c = fake("C");
  c.say({ t: "join", code });
  assert.strictEqual(c.last("error").why, "that room is full");
});

test("quick match fills an open public room before opening a new one", () => {
  const a = fake("A");
  a.say({ t: "quick", total: 3 });
  const b = fake("B");
  b.say({ t: "quick" });
  assert.strictEqual(rooms.size, 1, "both should land in the same room");
  assert.strictEqual(b.last("room").you, 1);
});

test("everyone ready starts the match with one shared seed", () => {
  const a = fake("A");
  a.say({ t: "create", total: 4 });
  const code = a.last("room").code;
  const b = fake("B");
  b.say({ t: "join", code });

  a.say({ t: "ready", v: true });
  assert.ok(!a.last("start"), "one ready player must not start the match");

  b.say({ t: "ready", v: true });
  const sa = a.last("start"), sb = b.last("start");
  assert.ok(sa && sb, "both players should be told to start");
  assert.strictEqual(sa.seed, sb.seed, "the seed must be identical on both clients");
  assert.strictEqual(sa.you, 0);
  assert.strictEqual(sb.you, 1);
  assert.strictEqual(sa.total, 4, "empty seats stay in the count for bots to fill");
});

test("the host can start early and leave the rest to bots", () => {
  const a = fake("A");
  a.say({ t: "create", total: 5 });
  const code = a.last("room").code;
  const b = fake("B");
  b.say({ t: "join", code });
  b.say({ t: "start" });
  assert.ok(!a.last("start"), "a guest must not be able to start");
  a.say({ t: "start" });
  assert.ok(a.last("start"), "the host may start");
});

test("input masks are relayed to the other seats, tagged with the sender", () => {
  const a = fake("A");
  a.say({ t: "create", total: 2 });
  const code = a.last("room").code;
  const b = fake("B");
  b.say({ t: "join", code });
  a.say({ t: "ready", v: true });
  b.say({ t: "ready", v: true });

  const beforeA = a.inbox.length;
  a.say({ t: "in", f: 12, m: 0b1010 });
  assert.strictEqual(a.inbox.length, beforeA, "a sender must not receive its own input back");

  const got = b.last("in");
  assert.deepStrictEqual({ seat: got.seat, f: got.f, m: got.m }, { seat: 0, f: 12, m: 0b1010 });
});

test("input before the match starts is ignored", () => {
  const a = fake("A");
  a.say({ t: "create", total: 2 });
  const code = a.last("room").code;
  const b = fake("B");
  b.say({ t: "join", code });
  a.say({ t: "in", f: 1, m: 7 });
  assert.ok(!b.last("in"), "lobby input should not be relayed");
});

test("leaving reseats the room and tells the survivors", () => {
  const a = fake("A");
  a.say({ t: "create", total: 4 });
  const code = a.last("room").code;
  const b = fake("B");
  b.say({ t: "join", code });
  const c = fake("C");
  c.say({ t: "join", code });

  b.say({ t: "bye" });
  const room = c.last("room");
  assert.strictEqual(room.players.length, 2);
  assert.deepStrictEqual(room.players.map(p => p.seat), [0, 1], "seats stay contiguous");
  assert.strictEqual(room.you, 1, "C moves up into seat 1");
});

test("a mid-match departure is announced so clients can hand the seat to a bot", () => {
  const a = fake("A");
  a.say({ t: "create", total: 2 });
  const code = a.last("room").code;
  const b = fake("B");
  b.say({ t: "join", code });
  a.say({ t: "ready", v: true });
  b.say({ t: "ready", v: true });
  b.say({ t: "bye" });
  assert.ok(a.last("left"), "the survivor should be told somebody left");
});

test("the last player out closes the room", () => {
  const a = fake("A");
  a.say({ t: "create", total: 2 });
  assert.strictEqual(rooms.size, 1);
  a.say({ t: "bye" });
  assert.strictEqual(rooms.size, 0);
});

test("names are cleaned and clipped", () => {
  const a = fake("  <script>alert(1)</script>  ");
  a.say({ t: "create", total: 2 });
  const nm = a.last("room").players[0].name;
  assert.ok(!/[<>()]/.test(nm), "markup characters should be stripped: " + nm);
  assert.ok(nm.length <= 14, "names cap at 14 characters");
});

test("a player's level reaches everybody else", () => {
  // It is only there so the others can draw the right jewels on your cape, but
  // if it does not arrive, every stranger looks like a beginner.
  const a = fake("A", 14), code = (a.say({ t: "create", total: 2 }), a.last("room").code);
  const b = fake("B", 3); b.say({ t: "join", code });
  const seen = a.last("room").players;
  assert.strictEqual(seen.find(x => x.name === "A").lv, 14);
  assert.strictEqual(seen.find(x => x.name === "B").lv, 3);
});

test("and it survives into the match itself", () => {
  const a = fake("A", 22), code = (a.say({ t: "create", total: 2 }), a.last("room").code);
  const b = fake("B", 9); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  const players = b.last("start").players;
  assert.strictEqual(players.find(x => x.name === "A").lv, 22);
  assert.strictEqual(players.find(x => x.name === "B").lv, 9);
});

test("a missing level is simply level one", () => {
  const a = fake("A");                       // no level at all, like an older client
  a.say({ t: "create", total: 2 });
  assert.strictEqual(a.last("room").players[0].lv, 1);
});

test("a nonsense level cannot reach anyone's renderer", () => {
  // A client can claim any level — it wins nothing but a prettier cloak — but
  // "banana" arriving in somebody else's drawing code is a crash, not a cheat.
  for (const junk of ["banana", -5, 0, 1e9, null, {}, NaN, "12; DROP"]){
    const a = fake("A", junk);
    a.say({ t: "create", total: 2 });
    const lv = a.last("room").players[0].lv;
    assert.ok(Number.isInteger(lv) && lv >= 1 && lv <= 999,
      "level " + JSON.stringify(junk) + " should have been clamped, got " + lv);
    a.say({ t: "bye" });
  }
});

test("a level given on join is kept too", () => {
  const a = fake("A", 5), code = (a.say({ t: "create", total: 2 }), a.last("room").code);
  const b = fake("B", 1);
  b.say({ t: "join", code, lv: 31 });        // the client restates it as it joins
  assert.strictEqual(a.last("room").players.find(x => x.name === "B").lv, 31);
});

test("seats are NOT renumbered mid-match", () => {
  // Renumbering after a mid-match departure hands a survivor someone else's seat,
  // so their keys drive the wrong wizard and their own stands there doing nothing.
  const a = fake("A"), code = (a.say({ t: "create", total: 3 }), a.last("room").code);
  const b = fake("B"); b.say({ t: "join", code });
  const c = fake("C"); c.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true }); c.say({ t: "ready", v: true });
  const seatC = c.last("start").you;
  assert.strictEqual(seatC, 2, "C should start in seat 2");
  b.say({ t: "bye" });                       // the middle seat leaves
  const roster = a.last("left").players;
  const stillC = roster.find(p => p.name === "C");
  assert.strictEqual(stillC.seat, 2, "C must keep seat 2 after B leaves mid-match");
  assert.ok(!roster.some(p => p.seat === 1), "seat 1 is vacant, not reassigned");
});

test("seats ARE compacted in the lobby, where nothing is running", () => {
  const a = fake("A"), code = (a.say({ t: "create", total: 3 }), a.last("room").code);
  const b = fake("B"); b.say({ t: "join", code });
  const c = fake("C"); c.say({ t: "join", code });
  b.say({ t: "bye" });
  const roster = a.last("room").players;
  assert.deepStrictEqual(roster.map(p => p.seat), [0, 1], "lobby seats stay contiguous");
});

test("the seat that fell behind is dropped, and only that one", () => {
  const a = fake("A"), code = (a.say({ t: "create", total: 2 }), a.last("room").code);
  const b = fake("B"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  for (let f = 0; f < 40; f++) a.say({ t: "in", f, m: 0 });   // A plays on
  b.say({ t: "in", f: 2, m: 0 });                             // B stopped early
  const gone = sweepStalled(Date.now() + STALL_MS + 1000);
  assert.strictEqual(gone.length, 1, "only the straggler is dropped");
  assert.strictEqual(gone[0].seat, 1, "and it is B's seat");
  assert.ok(b.last("dropped"), "the dropped client is told why");
  assert.ok(!a.last("dropped"), "the player who kept up is left alone");
});

test("a room where everyone is merely waiting loses nobody", () => {
  // lockstep stalls make every client go quiet at once; that must not be read
  // as everyone failing, or one hiccup would empty the room
  const a = fake("A"), code = (a.say({ t: "create", total: 2 }), a.last("room").code);
  const b = fake("B"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "in", f: 30, m: 0 });
  b.say({ t: "in", f: 30, m: 0 });          // level with each other, then silence
  const gone = sweepStalled(Date.now() + STALL_MS + 1000);
  assert.strictEqual(gone.length, 0, "nobody is dropped for waiting together");
});

test("clients that disagree at the same frame are told they have desynced", () => {
  const a = fake("A"), code = (a.say({ t: "create", total: 2 }), a.last("room").code);
  const b = fake("B"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "hash", f: 120, h: 111 });
  assert.ok(!a.last("desync"), "one client alone proves nothing");
  b.say({ t: "hash", f: 120, h: 222 });
  assert.ok(a.last("desync"), "a disagreement at the same frame is reported");
  assert.strictEqual(a.last("desync").f, 120);
});

test("clients that agree are left alone", () => {
  const a = fake("A"), code = (a.say({ t: "create", total: 2 }), a.last("room").code);
  const b = fake("B"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "hash", f: 60, h: 999 });
  b.say({ t: "hash", f: 60, h: 999 });
  assert.ok(!a.last("desync"), "matching worlds are not reported as desynced");
});

/* ------------------------------------------------------- naming the culprit

   A desync you cannot name costs a whole coordinated session with a friend in
   another timezone to reproduce, and the next report says exactly as little.
   Each client sends a checksum per component alongside the whole-world one, so
   the relay can say which part parted company. These tests pin that: the wrong
   name is worse than no name, because it sends us reading the wrong function. */

const P = (w, s, c, r) => ({ wizards: w, spells: s, scenery: c, rolls: r });

test("the desync report names only the component that actually differs", () => {
  const a = fake("A"), code = (a.say({ t: "create", total: 2 }), a.last("room").code);
  const b = fake("B"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "hash", f: 240, h: 111, parts: P(1, 2, 3, 4) });
  b.say({ t: "hash", f: 240, h: 222, parts: P(1, 9, 3, 4) });
  const d = a.last("desync");
  assert.ok(d, "a disagreement is still reported");
  assert.deepStrictEqual(d.parts, ["spells"], "only the spells differ, so only the spells are named");
  assert.strictEqual(d.f, 240);
});

test("several differing components are all named", () => {
  const a = fake("A"), code = (a.say({ t: "create", total: 2 }), a.last("room").code);
  const b = fake("B"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "hash", f: 60, h: 1, parts: P(1, 2, 3, 4) });
  b.say({ t: "hash", f: 60, h: 2, parts: P(7, 2, 8, 4) });
  assert.deepStrictEqual(a.last("desync").parts, ["wizards", "scenery"]);
});

test("a client that sends no parts leaves the report unnamed rather than wrong", () => {
  const a = fake("A"), code = (a.say({ t: "create", total: 2 }), a.last("room").code);
  const b = fake("B"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "hash", f: 60, h: 1, parts: P(1, 2, 3, 4) });
  b.say({ t: "hash", f: 60, h: 2 });
  const d = a.last("desync");
  assert.ok(d, "the desync itself is still reported");
  assert.deepStrictEqual(d.parts, [], "a missing measurement is not agreement");
});

test("junk in the parts field cannot crash the relay or invent a component", () => {
  const a = fake("A"), code = (a.say({ t: "create", total: 2 }), a.last("room").code);
  const b = fake("B"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "hash", f: 60, h: 1, parts: { wizards: "x", spells: null } });
  b.say({ t: "hash", f: 60, h: 2, parts: P(1, 2, 3, 4) });
  assert.deepStrictEqual(a.last("desync").parts, []);
});

test("matching parts alongside matching worlds report nothing at all", () => {
  const a = fake("A"), code = (a.say({ t: "create", total: 2 }), a.last("room").code);
  const b = fake("B"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "hash", f: 60, h: 7, parts: P(1, 2, 3, 4) });
  b.say({ t: "hash", f: 60, h: 7, parts: P(1, 2, 3, 4) });
  assert.ok(!a.last("desync"));
});

test("partsSplit keeps the component order the game reports them in", () => {
  assert.deepStrictEqual(partsSplit([P(1, 1, 1, 1), P(2, 1, 2, 2)]), ["wizards", "scenery", "rolls"]);
  assert.deepStrictEqual(partsSplit([P(1, 1, 1, 1), P(1, 1, 1, 1)]), []);
});

/* ------------------------------------------------------- builds and waiting

   Two clients on different builds are two different programs. Everything about
   that looks like a desync from the outside, which sends people hunting the
   netcode when the fix is to press refresh — so the build is part of the
   handshake and a split room never starts.

   And a client that is merely WAITING must never be mistaken for one that has
   gone. In lockstep a client sends input only when it steps, and it cannot step
   until its peer's input arrives; on a Japan-to-Canada link that is seconds of
   perfectly healthy silence. */

function fakeB(name, build){
  const p = fake(name);
  p.say({ t: "hello", name, build });
  return p;
}

test("a room where everyone is on the same build starts", () => {
  const a = fakeB("A", "46");
  a.say({ t: "create", total: 2 });
  const code = a.last("room").code;
  const b = fakeB("B", "46"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "start" });
  assert.ok(a.last("start"), "the match started");
  assert.ok(!a.last("badbuild"), "and nobody was told otherwise");
});

test("a room split across two builds refuses to start, and says why", () => {
  const a = fakeB("A", "46");
  a.say({ t: "create", total: 2 });
  const code = a.last("room").code;
  const b = fakeB("B", "45"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "start" });
  assert.ok(!a.last("start"), "the match must not start");
  const bad = a.last("badbuild");
  assert.ok(bad, "the host is told");
  assert.ok(b.last("badbuild"), "and so is the joiner");
  assert.deepStrictEqual(bad.builds, ["45", "46"], "and told which builds are in the room");
});

/* The version tag is not enough on its own, and this is the case that mattered:
   index.html is served fresh every time, game.js is cached for four hours. Reuse
   a version across a deploy and one player runs the old file, the other the new
   one, and both report the same number. So the id carries a fingerprint of the
   code each client is actually running, and the check has to look at it. */

test("same version, different code: the room refuses to start", () => {
  const a = fakeB("A", "59.k3x9p1");
  a.say({ t: "create", total: 2 });
  const code = a.last("room").code;
  const b = fakeB("B", "59.zzq004"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "start" });
  assert.ok(!a.last("start"), "two different programs must not start a match");
  assert.ok(a.last("badbuild"), "and both players are told to refresh");
  assert.ok(b.last("badbuild"));
});

test("same version and the same code plays", () => {
  const a = fakeB("A", "59.k3x9p1");
  a.say({ t: "create", total: 2 });
  const code = a.last("room").code;
  const b = fakeB("B", "59.k3x9p1"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "start" });
  assert.ok(a.last("start"), "identical clients must still be able to play");
  assert.ok(!a.last("badbuild"));
});

test("a client that could not fingerprint itself is not locked out", () => {
  // an old browser, or a blocked request: silent on the question, not evidence
  const a = fakeB("A", "59.k3x9p1");
  a.say({ t: "create", total: 2 });
  const code = a.last("room").code;
  const b = fakeB("B", "59"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "start" });
  assert.ok(a.last("start"), "a missing fingerprint must not cost somebody the match");
});

test("the fingerprint survives the relay's sanitising", () => {
  const a = fakeB("A", "59.k3x9p1");
  a.say({ t: "create", total: 2 });
  const code = a.last("room").code;
  const b = fakeB("B", "60.k3x9p1"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "start" });
  assert.ok(!a.last("start"), "a different version tag is still a different build");
  assert.deepStrictEqual(a.last("badbuild").builds, ["59.k3x9p1", "60.k3x9p1"],
    "the id must reach the relay intact — digits-only sanitising ate the fingerprint");
});

test("a client that is waiting is not a client that has gone", () => {
  const a = fakeB("A", "46");
  a.say({ t: "create", total: 2 });
  const code = a.last("room").code;
  const b = fakeB("B", "46"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "start" });
  // A races ahead; B has sent nothing for longer than the stall timeout but
  // keeps saying it is there, which is what a waiting client does
  for (let f = 0; f < 200; f++) a.say({ t: "in", f, m: 0 });
  const room = rooms.get(code);
  const longAgo = Date.now() - (STALL_MS + 5000);
  room.players.find(p => p.seat === 1).lastIn = longAgo;
  b.say({ t: "alive" });
  assert.strictEqual(sweepStalled().length, 0, "a waiting client was dropped");
  // and one that says nothing at all is still swept up
  room.players.find(p => p.seat === 1).lastIn = longAgo;
  assert.strictEqual(sweepStalled().length, 1, "a client that has gone was not dropped");
});

test("and normal lag is never mistaken for falling behind", () => {
  const a = fakeB("A", "46");
  a.say({ t: "create", total: 2 });
  const code = a.last("room").code;
  const b = fakeB("B", "46"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "start" });
  for (let f = 0; f < 200; f++) a.say({ t: "in", f, m: 0 });
  for (let f = 0; f < 200 - (STALL_LAG - 1); f++) b.say({ t: "in", f, m: 0 });
  const room = rooms.get(code);
  for (const p of room.players) p.lastIn = Date.now() - (STALL_MS + 5000);
  assert.strictEqual(sweepStalled().length, 0,
    "a seat less than STALL_LAG frames behind must never be dropped");
});

test("a ping comes back with what the furthest other player costs", () => {
  const a = fakeB("A", "46");
  a.say({ t: "create", total: 2 });
  const code = a.last("room").code;
  const b = fakeB("B", "46"); b.say({ t: "join", code });
  // each side reports its own measured round trip
  a.say({ t: "ping", s: 1, rtt: 40 });
  b.say({ t: "ping", s: 2, rtt: 300 });
  a.say({ t: "ping", s: 3, rtt: 40 });
  assert.strictEqual(a.last("pong").s, 3, "the echo carries the stamp back");
  assert.strictEqual(a.last("pong").peer, 300, "A is told B's leg, not its own");
  b.say({ t: "ping", s: 4, rtt: 300 });
  assert.strictEqual(b.last("pong").peer, 40, "and B is told A's");
});

test("and a nonsense round trip cannot poison it", () => {
  const a = fakeB("A", "46");
  a.say({ t: "create", total: 2 });
  const code = a.last("room").code;
  const b = fakeB("B", "46"); b.say({ t: "join", code });
  b.say({ t: "ping", s: 1, rtt: -5 });
  a.say({ t: "ping", s: 2, rtt: 10 });
  assert.ok(a.last("pong").peer >= 0, "a negative trip must not come back");
  b.say({ t: "ping", s: 3, rtt: 999999 });
  a.say({ t: "ping", s: 4, rtt: 10 });
  assert.ok(a.last("pong").peer <= 60000, "and an absurd one is clamped");
});

test("alone in a room, there is nobody else to wait for", () => {
  const a = fakeB("A", "46");
  a.say({ t: "create", total: 2 });
  a.say({ t: "ping", s: 1, rtt: 120 });
  assert.strictEqual(a.last("pong").peer, 0, "a lone host is told zero, not its own trip");
});

/* ---------------------------------------------------------------- arenas

   The host picks an arena; the relay sanitises it and hands the SAME value to
   every client. An arena name the relay does not recognise is quietly rewritten
   to "random", so a list here that has drifted from the client's list makes the
   host's choice disappear for the whole room with no error anywhere. Forest and
   Castle shipped that way. These tests pin the lists together. */

const fs = require("fs");
const pathM = require("path");
const REPO = pathM.join(__dirname, "..");
const gameSrc   = fs.readFileSync(pathM.join(REPO, "src/game.js"), "utf8");
const workerSrc = fs.readFileSync(pathM.join(REPO, "cloudflare/worker/src/index.js"), "utf8");

/** the arena names a source file lists in its mapPreset whitelist */
function presetList(src){
  const line = src.split("\n").find(l => l.includes("mapPreset:") && l.includes("includes("));
  assert.ok(line, "no mapPreset whitelist found");
  return line.slice(line.indexOf("[") + 1, line.indexOf("]"))
             .split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
}
/** the arenas the client can actually BUILD */
const buildable = ["random"].concat((() => {
  const body = gameSrc.slice(gameSrc.indexOf("const MAP_PRESETS = {"));
  const names = [];
  for (const line of body.split("\n").slice(1)){
    if (line.startsWith("};")) break;              // end of the object
    const m = line.match(/^\s{2}([a-z]+):\s*\[/);
    if (m) names.push(m[1]);
  }
  return names;
})());

function roomWith(preset){
  const a = fake("Host");
  a.say({ t: "create", total: 2, opts: { mapPreset: preset } });
  return a;
}

test("every arena the client can build survives the relay", () => {
  assert.ok(buildable.length >= 6, "expected the presets plus random, got " + buildable);
  for (const name of buildable){
    assert.strictEqual(roomWith(name).last("room").opts.mapPreset, name,
                       name + " was rewritten by the relay");
  }
});

test("and an arena nobody has heard of falls back to random", () => {
  assert.strictEqual(roomWith("swamp").last("room").opts.mapPreset, "random");
  assert.strictEqual(roomWith(undefined).last("room").opts.mapPreset, "random");
});

test("the relay offers exactly what the client can build", () => {
  assert.deepStrictEqual(presetList(require("fs").readFileSync(
    pathM.join(REPO, "server/rooms.js"), "utf8")).sort(), [...buildable].sort());
});

test("and the Cloudflare worker agrees with the node relay", () => {
  assert.deepStrictEqual(presetList(workerSrc).sort(), [...buildable].sort(),
                         "cloudflare/worker/src/index.js and server/rooms.js must be patched in step");
});

/* The two relays are the same protocol implemented twice, and the live site
   runs the worker while every test here drives the node twin. Anything the node
   side learns that the worker does not is a fix that silently never ships. */
test("the worker knows every message the node relay knows", () => {
  const roomsSrc = fs.readFileSync(pathM.join(REPO, "server/rooms.js"), "utf8");
  const verbs = src => new Set([...src.matchAll(/case "([a-z]+)":/g)].map(m => m[1]));
  const node = verbs(roomsSrc), worker = verbs(workerSrc);
  const missing = [...node].filter(v => !worker.has(v));
  assert.deepStrictEqual(missing, [], "the worker is missing: " + missing.join(", "));
});

test("and reports a peer's round trip the same way", () => {
  assert.ok(/case "ping"/.test(workerSrc), "the worker does not answer a ping");
  assert.ok(/peer/.test(workerSrc.slice(workerSrc.indexOf('case "ping"'), workerSrc.indexOf('case "ping"') + 700)),
            "the worker's pong carries no peer trip, so its clients cannot size their input delay");
});

test("and refuses a split-build room the same way", () => {
  assert.ok(/buildSplit/.test(workerSrc), "the worker has no build check");
  assert.ok(/badbuild/.test(workerSrc), "the worker never says badbuild");
  const lag = s => +(s.match(/const STALL_LAG = (\d+)/) || [])[1];
  const roomsSrc = fs.readFileSync(pathM.join(REPO, "server/rooms.js"), "utf8");
  assert.strictEqual(lag(workerSrc), lag(roomsSrc), "the two relays disagree about STALL_LAG");
  assert.ok(lag(workerSrc) >= 30, "STALL_LAG is tight enough to drop a merely-lagging player");
});

test("the client's own sanitiser knows them too", () => {
  assert.deepStrictEqual(presetList(gameSrc).sort(), [...buildable].sort());
});

test("the co-op flag survives the relay, and is a flag", () => {
  const a = fake("Host");
  a.say({ t: "create", total: 4, opts: { coop: 1 } });
  assert.strictEqual(a.last("room").opts.coop, 1);
  const b = fake("Host2");
  b.say({ t: "create", total: 4, opts: { coop: "yes please" } });
  assert.strictEqual(b.last("room").opts.coop, 1, "anything truthy means co-op");
  const c = fake("Host3");
  c.say({ t: "create", total: 4 });
  assert.strictEqual(c.last("room").opts.coop, 0, "and a duel is the default");
});

test("the host can switch a waiting room between duel and co-op", () => {
  const a = fake("Host");
  a.say({ t: "create", total: 2, opts: { coop: 0, mapPreset: "forest" } });
  a.say({ t: "config", opts: { coop: 1 } });
  const opts = a.last("room").opts;
  assert.strictEqual(opts.coop, 1, "the switch took");
  assert.strictEqual(opts.mapPreset, "forest", "and did not wipe the arena");
});

test("every seat is told the same arena when the match starts", () => {
  const a = fake("A");
  a.say({ t: "create", total: 2, opts: { mapPreset: "forest" } });
  const code = a.last("room").code;
  const b = fake("B"); b.say({ t: "join", code });
  a.say({ t: "ready", v: true }); b.say({ t: "ready", v: true });
  a.say({ t: "start" });
  assert.strictEqual(a.last("start").opts.mapPreset, "forest");
  assert.strictEqual(b.last("start").opts.mapPreset, "forest");
});

/* The relay names the component; the game turns the name into a sentence and
   the simulation produces it in the first place. Three files, one vocabulary --
   a name that exists in only two of them reports a desync no one can read. */

test("the worker names desync components exactly as the node relay does", () => {
  const roomsSrc = fs.readFileSync(pathM.join(REPO, "server/rooms.js"), "utf8");
  const list = src => {
    const m = src.match(/const HASH_PARTS = \[([^\]]*)\]/);
    assert.ok(m, "no HASH_PARTS list found");
    return m[1].split(",").map(x => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  };
  assert.deepStrictEqual(list(workerSrc), list(roomsSrc),
    "cloudflare/worker/src/index.js and server/rooms.js must be patched in step");
  assert.ok(/partsSplit\(/.test(workerSrc), "the worker never works out which component split");
  assert.ok(/t: "desync", f, parts/.test(workerSrc), "the worker's desync report carries no component names");
});

test("the game measures every component the relays can name, and can say it out loud", () => {
  const roomsSrc = fs.readFileSync(pathM.join(REPO, "server/rooms.js"), "utf8");
  const parts = roomsSrc.match(/const HASH_PARTS = \[([^\]]*)\]/)[1]
    .split(",").map(x => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const hp = gameSrc.slice(gameSrc.indexOf("hashParts()"), gameSrc.indexOf("hashParts()") + 1400);
  for (const k of parts){
    assert.ok(hp.includes(k), "hashParts() never measures " + k + ", so the relay can never name it");
    assert.ok(/DESYNC_WORDS = \{[\s\S]*?\}/.exec(gameSrc)[0].includes(k),
      "the game has no words for a " + k + " desync, so the report reads as blank");
  }
});

console.log(`\n${pass} passing`);
