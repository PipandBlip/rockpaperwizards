/*
 * Matchmaking + relay tests. No dependencies, no ports: rooms.js is driven
 * through fake sockets, so this runs anywhere `node` runs.
 *
 *   node test-relay.js
 */

"use strict";

const assert = require("assert");
const { Player, handle, rooms, sweepStalled, STALL_MS } = require("./rooms");

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

console.log(`\n${pass} passing`);
