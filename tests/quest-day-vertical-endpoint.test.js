// Mirror-tests for POST /api/quest-day-vertical (backend/worker.js) — the
// endpoint that persists Ridge Quest's checkpoint-measured running daily
// vertical into player_day_stats.checkpoint_vertical_m.
//
// worker.js is a Cloudflare Worker ES module with no test-friendly export
// (same constraint tests/quest-stats.test.js documents), so the handler's
// two pieces of real logic — input clamping and the MAX() upsert semantics
// — are reimplemented here and checked, and a source-regex confirms the
// shipped handler still matches this contract.
//
// Run: `node tests/quest-day-vertical-endpoint.test.js`
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

/* ---- reimplements the handler's clamp (worker.js) ---- */
function clampVertical(raw) {
  let v = Number(raw);
  if (!Number.isFinite(v)) return null; // -> 400
  return Math.max(0, Math.min(100000, Math.round(v)));
}

/* ---- reimplements the ON CONFLICT DO UPDATE SET checkpoint_vertical_m =
       MAX(checkpoint_vertical_m, excluded.checkpoint_vertical_m) ---- */
function upsert(store, key, v) {
  store[key] = Math.max(store[key] || 0, v);
  return store[key];
}

(function testClampRejectsNonNumber() {
  assert(clampVertical(undefined) === null, "missing verticalM -> null (400)");
  assert(clampVertical("abc") === null, "non-numeric verticalM -> null (400)");
  assert(clampVertical(NaN) === null, "NaN verticalM -> null (400)");
})();

(function testClampFloorsAtZero() {
  assert(clampVertical(-50) === 0, "a negative total clamps to 0, got " + clampVertical(-50));
})();

(function testClampCeilingAndRounding() {
  assert(clampVertical(1e9) === 100000, "an absurd total clamps to 100000, got " + clampVertical(1e9));
  assert(clampVertical(1234.7) === 1235, "the stored value is rounded, got " + clampVertical(1234.7));
})();

(function testUpsertIsMonotonic() {
  const s = {};
  upsert(s, "p|2026-12-20", 300);
  upsert(s, "p|2026-12-20", 600);
  assert(s["p|2026-12-20"] === 600, "a larger report advances the day total, got " + s["p|2026-12-20"]);
  upsert(s, "p|2026-12-20", 450); // a stale / out-of-order post
  assert(s["p|2026-12-20"] === 600, "a smaller (stale/out-of-order) report never decreases it, got " + s["p|2026-12-20"]);
})();

(function testUpsertPerDayIndependent() {
  const s = {};
  upsert(s, "p|2026-12-20", 600);
  upsert(s, "p|2026-12-21", 200);
  assert(s["p|2026-12-20"] === 600 && s["p|2026-12-21"] === 200, "each day-bucket accumulates independently");
})();

/* ---- the shipped handler still matches this contract ---- */
(function testHandlerSourceMatchesContract() {
  const worker = fs.readFileSync(path.join(__dirname, "../backend/worker.js"), "utf8");
  const idx = worker.indexOf('path === "/api/quest-day-vertical"');
  assert(idx > 0, "POST /api/quest-day-vertical handler exists in worker.js");
  const body = worker.slice(idx, idx + 1400);
  assert(/playerAuth\(request, env\)/.test(body), "handler is player-authed");
  assert(/Math\.max\(0, Math\.min\(100000, Math\.round\(v\)\)\)/.test(body), "handler clamps to [0, 100000] and rounds");
  assert(/questDateBucket\(/.test(body) && /questSeasonId\(/.test(body), "handler buckets by the -7h day + season helpers");
  assert(/MAX\(checkpoint_vertical_m,\s*excluded\.checkpoint_vertical_m\)/.test(body), "handler upserts with MAX() (upgrade-only)");
  assert(/P\.playerId/.test(body) && /P\.appId/.test(body), "row is keyed to the authenticated player + their app, not the body");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
