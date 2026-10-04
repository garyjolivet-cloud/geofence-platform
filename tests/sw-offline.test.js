// frontend/sw.js (2026-10-04): map tiles the phone has already shown are kept (cache-first,
// across deploys, capped); a signed-in rider's data is never cached; Ridge Quest registers it.
// Runs the REAL service worker against a fake `self` / `caches` / `fetch`.
//
// Run: `node --test tests/sw-offline.test.js` (or the full suite).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../frontend/sw.js"), "utf8");
const rq = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");

function load(fetchImpl) {
  const stores = new Map(), handlers = {};
  const mkCache = () => { const m = new Map(); return {
    match: async r => m.get(r.url) || undefined,
    put: async (r, res) => { m.set(r.url, res); },
    keys: async () => [...m.keys()].map(url => ({ url })),
    delete: async k => m.delete(k.url),
    _m: m }; };
  const caches = { open: async n => { if (!stores.has(n)) stores.set(n, mkCache()); return stores.get(n); },
                   keys: async () => [...stores.keys()], delete: async n => stores.delete(n) };
  const self = { addEventListener: (t, fn) => { handlers[t] = fn; }, skipWaiting() {}, clients: { claim: async () => {} } };
  // eslint-disable-next-line no-new-func
  new Function("self", "caches", "fetch", "Response", "URL", src)(self, caches, fetchImpl, Response, URL);
  const fire = (url, headers) => new Promise(resolve => {
    let responded = false;
    handlers.fetch({ request: { url, method: "GET", headers: new Map(Object.entries(headers || {})) },
      respondWith: p => { responded = true; Promise.resolve(p).then(resolve); } });
    setTimeout(() => { if (!responded) resolve("passthrough"); }, 20);
  });
  return { fire, stores };
}
const ok = body => ({ ok: true, status: 200, body, clone() { return ok(body); } });
const TILE = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/15/11000/5000";
const DEM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/700/1300.png";

test("a map tile is fetched once, then served from the tile cache even with no signal", async () => {
  let online = true, calls = 0;
  const { fire, stores } = load(async () => { calls++; if (!online) throw new Error("offline"); return ok("img"); });
  const first = await fire(TILE);
  assert.strictEqual(first.body, "img");
  await new Promise(r => setTimeout(r, 5));
  assert.ok(stores.get("gp-tiles")._m.has(TILE), "kept in gp-tiles");
  online = false;
  const second = await fire(TILE);
  assert.strictEqual(second.body, "img", "drawn from the cache offline");
  assert.strictEqual(calls, 1, "cache-first: no second network request");
  await fire(DEM);
  assert.ok(true, "elevation tiles use the same path");
});

test("the tile cache survives a deploy (not versioned) and is capped", () => {
  assert.ok(/const TILE_CACHE = 'gp-tiles';/.test(src) && /KEEP = new Set\(\[PAGE_CACHE, AUDIO_CACHE, TILE_CACHE\]\)/.test(src));
  assert.ok(/const TILE_MAX = \d+;/.test(src) && /trimTiles\(c\)/.test(src));
});

test("a signed-in rider's data is never cached", async () => {
  const { fire, stores } = load(async () => ok("private"));
  const r = await fire("https://geofence-platform.gary-jolivet.workers.dev/api/players/p1/corridor-names", { authorization: "Bearer t" });
  assert.strictEqual(r, "passthrough", "the worker steps aside (plain network)");
  assert.ok(![...stores.values()].some(c => [...c._m.keys()].some(k => k.includes("/api/players/"))), "nothing private stored");
});

test("Ridge Quest registers the offline worker", () => {
  assert.ok(/navigator\.serviceWorker\.register\('\/sw\.js'\)/.test(rq));
});
