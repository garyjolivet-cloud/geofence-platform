// Ridge Quest offline outbox (frontend/rq-outbox.js, 2026-09-24): runs and chute lines logged
// with no phone signal are kept on the phone and sent when the connection returns, never twice.
//
// Run: `node --test tests/rq-outbox.test.js` (or the full suite).
"use strict";
const test = require("node:test");
const assert = require("node:assert");

require("../frontend/rq-outbox.js");
const O = globalThis.RQOutbox;

function mkStore() { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, m }; }
// A fake network: `status` is what the next POSTs return (0 = no signal).
function mkNet(status) {
  const net = { status, sent: [] };
  net.send = (path, body) => { net.sent.push({ path, id: body.clientId }); return Promise.resolve({ status: net.status }); };
  return net;
}
function mk(net, opts = {}) {
  const store = opts.store || mkStore(), sentItems = [];
  let player = opts.player || "p1";
  const box = O.createOutbox({ storage: store, send: net.send, playerId: () => player, onSent: i => sentItems.push(i.body.clientId) });
  return { box, store, sentItems, setPlayer: p => { player = p; } };
}
const run = id => ({ kind: "run", path: "/api/quest-runs", body: { clientId: id, zoneId: "z" } });
const line = (id, n = 3) => ({ kind: "line", path: "/api/chute-lines", body: { clientId: id, points: Array.from({ length: n }, (_, i) => [i, i]) } });

test("with signal, an item is sent once and nothing is kept", async () => {
  const net = mkNet(200), o = mk(net);
  assert.strictEqual(await o.box.deliver(run("r1")), "sent");
  assert.deepStrictEqual(o.sentItems, ["r1"]);
  assert.strictEqual(o.box.pending().length, 0);
});

test("no signal, server errors and an expired login keep the item on the phone", async () => {
  for (const status of [0, 401, 408, 429, 500, 503]) {
    const o = mk(mkNet(status));
    assert.strictEqual(await o.box.deliver(run("r-" + status)), "queued", "status " + status);
    assert.strictEqual(o.box.pending().length, 1);
    assert.ok(o.store.m["rq.outbox"].includes("r-" + status), "persisted in localStorage");
  }
});

test("a request the server will never accept is dropped, not retried forever", async () => {
  const o = mk(mkNet(400));
  assert.strictEqual(await o.box.deliver(run("bad")), "dropped");
  assert.strictEqual(o.box.pending().length, 0);
});

test("a thrown send (fetch rejected) counts as no signal", async () => {
  const box = O.createOutbox({ storage: mkStore(), send: () => Promise.reject(new TypeError("Failed to fetch")), playerId: () => "p1" });
  assert.strictEqual(await box.deliver(run("r1")), "queued");
});

test("back in signal: everything is sent oldest first, and onSent fires for each", async () => {
  const net = mkNet(0), o = mk(net);
  await o.box.deliver(run("r1")); await o.box.deliver(line("l1")); await o.box.deliver(run("r2"));
  assert.strictEqual(o.box.pending().length, 3);
  net.status = 200; net.sent.length = 0;
  assert.strictEqual(await o.box.flush(), 3);
  assert.deepStrictEqual(net.sent.map(s => s.id), ["r1", "l1", "r2"]);
  assert.deepStrictEqual(o.sentItems, ["r1", "l1", "r2"]);
  assert.strictEqual(o.box.pending().length, 0);
});

test("flush stops at the first no-signal failure and keeps the rest in order", async () => {
  const net = mkNet(0), o = mk(net);
  await o.box.deliver(run("r1")); await o.box.deliver(run("r2"));
  net.sent.length = 0;
  assert.strictEqual(await o.box.flush(), 0);
  assert.deepStrictEqual(net.sent.map(s => s.id), ["r1"], "one attempt, not a hammer on every item");
  assert.deepStrictEqual(o.box.pending().map(i => i.body.clientId), ["r1", "r2"]);
});

test("flush drops an item the server refuses and carries on with the next", async () => {
  const o = mk({ send: (p, b) => Promise.resolve({ status: b.clientId === "bad" ? 400 : 200 }) });
  o.box.add(run("bad")); o.box.add(run("good"));
  assert.strictEqual(await o.box.flush(), 1);
  assert.strictEqual(o.box.pending().length, 0);
});

test("the same item is never queued twice", async () => {
  const o = mk(mkNet(0));
  await o.box.deliver(run("r1")); o.box.add(run("r1"));
  assert.strictEqual(o.box.pending().length, 1);
});

test("items are only ever sent by the rider who logged them", async () => {
  const net = mkNet(0), store = mkStore(), o = mk(net, { store });
  await o.box.deliver(run("mine"));
  o.setPlayer("p2"); net.status = 200; net.sent.length = 0;
  assert.strictEqual(o.box.pending().length, 0, "another rider on the same phone sees nothing");
  assert.strictEqual(await o.box.flush(), 0);
  assert.strictEqual(net.sent.length, 0);
  o.setPlayer("p1");
  assert.strictEqual(await o.box.flush(), 1, "sent once the original rider is back");
});

test("survives a reload: a new outbox on the same storage still has the items", async () => {
  const store = mkStore();
  await mk(mkNet(0), { store }).box.deliver(run("r1"));
  const again = mk(mkNet(200), { store });
  assert.strictEqual(again.box.pending().length, 1);
  assert.strictEqual(await again.box.flush(), 1);
});

test("storage that throws (private mode) falls back to memory for this session", async () => {
  const bad = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  const net = mkNet(0);
  const box = O.createOutbox({ storage: bad, send: net.send, playerId: () => "p1" });
  assert.strictEqual(await box.deliver(run("r1")), "queued");
  assert.strictEqual(box.pending().length, 1);
  net.status = 200;
  assert.strictEqual(await box.flush(), 1);
  const nullStore = O.createOutbox({ storage: null, send: mkNet(0).send, playerId: () => "p1" });
  assert.strictEqual(await nullStore.deliver(run("r2")), "queued");
});

test("the queue is bounded, and lines are dropped before runs", async () => {
  const o = mk(mkNet(0));
  o.box.add(run("keep-run"));
  for (let i = 0; i < O.OUTBOX.MAX_ITEMS + 5; i++) o.box.add(line("l" + i));
  const p = o.box.pending();
  assert.ok(p.length <= O.OUTBOX.MAX_ITEMS);
  assert.ok(p.some(i => i.body.clientId === "keep-run"), "the run survives");
  assert.ok(!p.some(i => i.body.clientId === "l0"), "the oldest line went first");
  const big = mk(mkNet(0));
  big.box.add(run("r"));
  for (let i = 0; i < 20; i++) big.box.add(line("big" + i, 4000));
  assert.ok(JSON.stringify(big.box.pending()).length <= O.OUTBOX.MAX_CHARS, "size-capped too");
  assert.ok(big.box.pending().some(i => i.body.clientId === "r"));
});

test("a second flush while one is running does nothing (no double send)", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const sent = [];
  const box = O.createOutbox({ storage: mkStore(), playerId: () => "p1",
    send: (p, b) => { sent.push(b.clientId); return gate.then(() => ({ status: 200 })); } });
  box.add(run("r1"));
  const a = box.flush(), b = box.flush();
  release();
  assert.strictEqual(await b, 0);
  assert.strictEqual(await a, 1);
  assert.deepStrictEqual(sent, ["r1"]);
});

test("client ids look like UUIDs and are unique", () => {
  const ids = new Set(Array.from({ length: 200 }, () => O.newClientId()));
  assert.strictEqual(ids.size, 200);
  ids.forEach(id => assert.match(id, /^[A-Za-z0-9-]{8,64}$/, "accepted by the server's validClientId"));
});
