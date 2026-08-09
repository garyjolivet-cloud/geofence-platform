// Standalone Node test suite for the RECORD program's "Danger Zones" heatmap
// (frontend/record.html's Heatmap tab + backend/worker.js's
// GET /api/projects/:id/record/heatmap). This repo has no test
// runner/package.json -- run directly: `node tests/record-heatmap.test.js`
// (or `node --test tests/`, matching kalman-filter.test.js's convention).
//
// The heatmap has no standalone module to `require()` -- its logic is
// inline in worker.js's route handler (grid-bucketing SQL) and in
// record.html's refreshHeatmap() (cells -> GeoJSON). Both are mirrored
// here verbatim rather than reimplemented, and run for real: the SQL runs
// against Node's built-in node:sqlite (D1 is SQLite under the hood, so the
// exact query worker.js sends is what's under test, not an approximation
// of it). If worker.js's heatmap handler or record.html's refreshHeatmap
// change, update the mirrored copies below to match -- same caution as the
// other verbatim-mirror spots this codebase already flags (see
// GEOFENCE_TRIGGER section of CLAUDE.md).
"use strict";
const { DatabaseSync } = require("node:sqlite");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log("FAIL:", msg); }
}

// ---------- schema (mirrors migrations/0028_record_sessions.sql) ----------
function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE position_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      acc REAL,
      heading REAL,
      ts INTEGER NOT NULL
    );
  `);
  return db;
}

// D1-shaped wrapper around node:sqlite so the query below is called exactly
// the way worker.js calls it: env.DB.prepare(sql).bind(...args).all()
function d1(db) {
  return { prepare: sql => ({ bind: (...args) => ({ all: () => ({ results: db.prepare(sql).all(...args) }) }) }) };
}

// ---------- mirrors worker.js's GET .../record/heatmap handler body ----------
// (auth/HTTP plumbing stripped out; the query-building logic is verbatim)
function runHeatmap(DB, pid, { gridMParam, from, to } = {}) {
  const gridM = Math.max(3, Math.min(200, Number(gridMParam) || 15));
  const step = gridM / 111320; // rough metres->degrees; fine at the scale this tool operates over
  const conds = ["project_id=?"], binds = [pid];
  if (from) { conds.push("ts>=?"); binds.push(Number(from)); }
  if (to) { conds.push("ts<=?"); binds.push(Number(to)); }
  const { results } = DB.prepare(
    `SELECT ROUND(lat/?)*? AS lat, ROUND(lon/?)*? AS lon, COUNT(*) AS count FROM position_history WHERE ${conds.join(" AND ")} GROUP BY 1,2`
  ).bind(step, step, step, step, ...binds).all();
  return { gridM, cells: results || [] };
}

// ---------- mirrors record.html's refreshHeatmap() cells -> GeoJSON step ----------
function cellsToFeatures(cells) {
  return (cells || []).map(c => ({ type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] }, properties: { count: c.count } }));
}

// ---------- fixture geometry helpers (same technique as kalman-filter.test.js) ----------
const R_LAT = 111320;
function destPoint(lat, lon, bearingDeg, distM) {
  const phi = lat * Math.PI / 180;
  const brg = bearingDeg * Math.PI / 180;
  const dLat = (distM * Math.cos(brg)) / R_LAT;
  const dLon = (distM * Math.sin(brg)) / (R_LAT * Math.cos(phi));
  return [lat + dLat, lon + dLon];
}
function jitter(i, magM) {
  return magM * (0.6 * Math.sin(i * 1.7 + 0.3) + 0.4 * Math.sin(i * 4.1 + 1.9));
}
let nextId = 1;
function insertPoint(db, { sid = "sess-1", pid = "proj-golden", lat, lon, ts }) {
  db.prepare("INSERT INTO position_history (session_id,project_id,lat,lon,acc,heading,ts) VALUES (?,?,?,?,?,?,?)")
    .run(sid, pid, lat, lon, 8, null, ts);
  return nextId++;
}

// ============================================================
// (a) A repeatedly-revisited spot ("danger zone") collapses into one
//     high-count cell, distinct from a spot only passed once.
// ============================================================
(function testHotspotClustering() {
  const db = makeDb();
  const T0 = 1700000000000;
  const HOTSPOT = [51.300000, -117.000000]; // base of a jump/hazard, revisited all afternoon
  const WAYPOINT = destPoint(HOTSPOT[0], HOTSPOT[1], 90, 700); // a trail point passed once, 700m away

  // 40 pings clustered within a few metres of the hotspot, at 20 different
  // timestamps 5 minutes apart across the afternoon.
  for (let i = 0; i < 40; i++) {
    const [lat, lon] = destPoint(HOTSPOT[0], HOTSPOT[1], (i * 37) % 360, Math.abs(jitter(i, 4)));
    insertPoint(db, { lat, lon, ts: T0 + i * 300000 });
  }
  // 3 pings at the lone waypoint (a single pass-through).
  for (let i = 0; i < 3; i++) {
    insertPoint(db, { lat: WAYPOINT[0], lon: WAYPOINT[1], ts: T0 + 1000000 + i * 1000 });
  }

  const { cells } = runHeatmap(d1(db), "proj-golden", { gridMParam: "15" });
  const totalCount = cells.reduce((s, c) => s + c.count, 0);
  assert(totalCount === 43, "cell counts conserve every inserted row (got total " + totalCount + ", expected 43)");

  const hotspotCell = cells.find(c => c.count >= 30);
  assert(!!hotspotCell, "the revisited spot collapses into a single high-count cell");
  const waypointCell = cells.find(c => c.count === 3);
  assert(!!waypointCell, "the single pass-through stays a separate, low-count cell");
  if (hotspotCell && waypointCell) {
    assert(hotspotCell.lat !== waypointCell.lat || hotspotCell.lon !== waypointCell.lon,
      "hotspot and waypoint are reported as distinct grid cells, not merged");
  }
  assert(cells.length <= 4, "40 tightly-clustered pings don't fragment into many separate cells at gridM=15 (got " + cells.length + " cells)");
})();

// ============================================================
// (b) Grid size trade-off: a coarser grid merges nearby activity into
//     fewer cells; a finer grid can resolve it into more.
// ============================================================
(function testGridSizeTradeoff() {
  const db = makeDb();
  const T0 = 1700000000000;
  const BASE = [51.301000, -117.001000];
  const SUB_A = BASE;
  const SUB_B = destPoint(BASE[0], BASE[1], 90, 12); // 12m east -- two distinct sub-spots

  for (let i = 0; i < 10; i++) {
    const [latA, lonA] = destPoint(SUB_A[0], SUB_A[1], (i * 53) % 360, Math.abs(jitter(i, 1)));
    insertPoint(db, { lat: latA, lon: lonA, ts: T0 + i * 60000 });
    const [latB, lonB] = destPoint(SUB_B[0], SUB_B[1], (i * 71) % 360, Math.abs(jitter(i, 1)));
    insertPoint(db, { lat: latB, lon: lonB, ts: T0 + i * 60000 + 30000 });
  }

  const fine = runHeatmap(d1(db), "proj-golden", { gridMParam: "8" });
  const coarse = runHeatmap(d1(db), "proj-golden", { gridMParam: "60" });

  assert(fine.cells.reduce((s, c) => s + c.count, 0) === 20, "fine grid still accounts for every row");
  assert(coarse.cells.reduce((s, c) => s + c.count, 0) === 20, "coarse grid still accounts for every row");
  assert(fine.cells.length >= 2, "an 8m grid resolves two 20m-apart sub-spots into separate cells (got " + fine.cells.length + ")");
  assert(coarse.cells.length === 1, "a 60m grid merges the same two sub-spots into one cell (got " + coarse.cells.length + ")");
  assert(coarse.cells.length <= fine.cells.length, "coarsening the grid never produces more cells than a finer one");
})();

// ============================================================
// (c) A project only ever sees its own position history.
// ============================================================
(function testProjectIsolation() {
  const db = makeDb();
  const T0 = 1700000000000;
  for (let i = 0; i < 5; i++) insertPoint(db, { pid: "proj-golden", lat: 51.3 + i * 0.0001, lon: -117.0, ts: T0 + i * 1000 });
  for (let i = 0; i < 9; i++) insertPoint(db, { pid: "proj-other", lat: 51.3 + i * 0.0001, lon: -117.0, ts: T0 + i * 1000 });

  const mine = runHeatmap(d1(db), "proj-golden", { gridMParam: "15" });
  assert(mine.cells.reduce((s, c) => s + c.count, 0) === 5, "another project's pings never leak into this project's heatmap");
})();

// ============================================================
// (d) Date-range filter narrows the heatmap to a time window (e.g. "just
//     this morning's patrol") without touching the folder/session filter.
// ============================================================
(function testDateRangeFilter() {
  const db = makeDb();
  const morning = 1700000000000; // 08:00-ish
  const afternoon = morning + 6 * 3600 * 1000; // +6h
  for (let i = 0; i < 6; i++) insertPoint(db, { lat: 51.3, lon: -117.0 + i * 0.0001, ts: morning + i * 1000 });
  for (let i = 0; i < 4; i++) insertPoint(db, { lat: 51.3, lon: -117.0 + i * 0.0001, ts: afternoon + i * 1000 });

  const all = runHeatmap(d1(db), "proj-golden", { gridMParam: "15" });
  assert(all.cells.reduce((s, c) => s + c.count, 0) === 10, "no date filter returns every ping");

  const morningOnly = runHeatmap(d1(db), "proj-golden", { gridMParam: "15", from: morning, to: morning + 3600 * 1000 });
  assert(morningOnly.cells.reduce((s, c) => s + c.count, 0) === 6, "from/to narrows the heatmap to the morning window only");
})();

// ============================================================
// (e) gridM is clamped to [3, 200] and defaults to 15 -- same bounds as
//     the <select id="heatmapGridM"> options in record.html plus the
//     server-side clamp that protects against a hostile/typo'd value.
// ============================================================
(function testGridMClamping() {
  const db = makeDb();
  insertPoint(db, { lat: 51.3, lon: -117.0, ts: 1700000000000 });
  assert(runHeatmap(d1(db), "proj-golden", {}).gridM === 15, "missing gridM defaults to 15");
  assert(runHeatmap(d1(db), "proj-golden", { gridMParam: "not-a-number" }).gridM === 15, "non-numeric gridM falls back to 15");
  assert(runHeatmap(d1(db), "proj-golden", { gridMParam: "1" }).gridM === 3, "gridM below 3 clamps up to 3");
  assert(runHeatmap(d1(db), "proj-golden", { gridMParam: "9999" }).gridM === 200, "gridM above 200 clamps down to 200");
  assert(runHeatmap(d1(db), "proj-golden", { gridMParam: "30" }).gridM === 30, "an in-range gridM passes through unchanged");
})();

// ============================================================
// (f) cells -> GeoJSON: coordinate order is [lon, lat] (GeoJSON convention),
//     not [lat, lon] -- an easy transpose bug that would silently plot every
//     cell in the wrong place without erroring.
// ============================================================
(function testCellsToGeoJSON() {
  const features = cellsToFeatures([{ lat: 51.3, lon: -117.0, count: 12 }]);
  assert(features.length === 1, "one cell in, one feature out");
  const [lon, lat] = features[0].geometry.coordinates;
  assert(lon === -117.0 && lat === 51.3, "GeoJSON coordinates are [lon, lat], matching the cell's own lon/lat");
  assert(features[0].properties.count === 12, "count carries through to feature properties unchanged");
})();

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
