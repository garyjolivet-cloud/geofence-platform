// Standalone Node test suite for Map Paint's pure logic (backend/worker.js's
// named exports partitionManualCells / normalizeTerrainPaint) plus the H3
// polygon->cells contract the extended classify-terrain route relies on for
// drawn regions. No test runner — run directly:
//   node tests/terrain-paint.test.js
// Matches tests/terrain-classifier.test.js / tests/kalman-filter.test.js.
"use strict";
const { partitionManualCells, normalizeTerrainPaint } = require("../backend/worker.js");
const h3 = require("h3-js");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log("FAIL:", msg); }
}

// ============================================================
// (a) Drawn-polygon -> H3 cell set. classify-terrain's polygon branch calls
// h3.polygonToCells(ring, 10, true) exactly the way it already does for
// buffered corridors. Confirm the contract: every returned cell is res 10,
// the set is non-empty for a real-world ring, and it actually covers the
// ring's interior (a centroid check).
// ============================================================
(function testPolygonToCells() {
  // ~1.5km box around Kicking Horse (lon,lat order — GeoJSON, isGeoJson=true)
  const ring = [
    [-117.06, 51.30], [-117.04, 51.30], [-117.04, 51.31], [-117.06, 51.31], [-117.06, 51.30]
  ];
  const cells = h3.polygonToCells([ring], 10, true);
  assert(cells.length > 0, "a real-world polygon ring yields at least one res-10 cell");
  assert(cells.every(c => h3.getResolution(c) === 10), "every cell from polygonToCells(...,10,...) is resolution 10");
  const centroidCell = h3.latLngToCell(51.305, -117.05, 10);
  assert(cells.includes(centroidCell), "the region's centroid cell is in the returned set (ring interior is covered)");
  // A point well outside the ring is not in the set.
  const outside = h3.latLngToCell(51.40, -117.20, 10);
  assert(!cells.includes(outside), "a cell far outside the ring is not included");
})();

// ============================================================
// (b) partitionManualCells — the classifier drops hand-painted cells from its
// working set before any OSM/DEM work, so a re-run never re-classifies or
// (via the "source<>'manual'" DELETE) wipes them.
// ============================================================
(function testPartitionManualCells() {
  const region = h3.gridDisk(h3.latLngToCell(51.305, -117.05, 10), 2); // 19 cells
  const manual = new Set([region[0], region[5], region[10]]);
  const toClassify = partitionManualCells(region, manual);
  assert(toClassify.length === region.length - 3, "3 manual cells removed from a 19-cell region -> 16 to classify");
  assert(!toClassify.some(c => manual.has(c)), "no manual cell survives into the classify set");
  assert(region.filter(c => !manual.has(c)).every(c => toClassify.includes(c)), "every non-manual cell is kept");
  // Accepts a plain array for manualCells too, and a no-manual region is a pass-through.
  assert(partitionManualCells(region, []).length === region.length, "empty manual list -> whole region classified");
  assert(partitionManualCells(region, [region[1]]).length === region.length - 1, "array (not Set) manual list is honoured");
  // The classifier's "every cell is hand-painted" early return: toClassify empty.
  assert(partitionManualCells([region[0]], new Set([region[0]])).length === 0,
    "a region fully covered by manual cells produces an empty classify set");
})();

// ============================================================
// (c) normalizeTerrainPaint — POST /api/projects/:id/terrain-cells body
// validation/normalisation: h3 length guard (1..20), terrain_type guard,
// variant_index integer default, empty -> error, 2000-cell cap -> error.
// ============================================================
(function testNormalizeTerrainPaint() {
  const goodCell = h3.latLngToCell(51.305, -117.05, 10);

  const empty = normalizeTerrainPaint({});
  assert(empty.error && !empty.paint, "no paint and no erase -> error");
  assert(normalizeTerrainPaint({ paint: [], erase: [] }).error, "empty paint + empty erase arrays -> error");

  const ok = normalizeTerrainPaint({
    paint: [
      { h3Cell: goodCell, terrainType: "forest", variantIndex: 2 },
      { h3Cell: goodCell, terrainType: "rock_face" },              // variantIndex defaults to 0
      { h3Cell: goodCell, terrainType: "forest", variantIndex: 1.7 } // non-integer -> 0
    ],
    erase: [goodCell, "not-a-real-but-short"]
  });
  assert(!ok.error, "a valid body normalises without error");
  assert(ok.paint.length === 3, "all three well-formed paint entries kept");
  assert(ok.paint[1].variantIndex === 0, "missing variantIndex defaults to 0");
  assert(ok.paint[2].variantIndex === 0, "non-integer variantIndex coerced to 0");
  assert(ok.erase.length === 2, "short erase strings kept");

  const dirty = normalizeTerrainPaint({
    paint: [
      { h3Cell: "x".repeat(21), terrainType: "forest" },   // > 20 chars
      { h3Cell: goodCell, terrainType: "" },                // empty terrainType
      { h3Cell: goodCell, terrainType: "y".repeat(41) },    // terrainType too long
      { h3Cell: 12345, terrainType: "forest" },             // non-string cell
      { h3Cell: goodCell, terrainType: "meadow", variantIndex: 1 } // the only good one
    ],
    erase: ["", "z".repeat(21), goodCell]
  });
  assert(dirty.paint.length === 1 && dirty.paint[0].terrainType === "meadow", "malformed paint entries are dropped, valid one kept");
  assert(dirty.erase.length === 1 && dirty.erase[0] === goodCell, "empty / over-length erase strings dropped");

  const huge = normalizeTerrainPaint({ paint: Array.from({ length: 2001 }, () => ({ h3Cell: goodCell, terrainType: "forest" })) });
  assert(huge.error && /2000/.test(huge.error), "over 2000 cells in one call -> error (client must batch)");
  const atCap = normalizeTerrainPaint({ paint: Array.from({ length: 2000 }, () => ({ h3Cell: goodCell, terrainType: "forest" })) });
  assert(!atCap.error, "exactly 2000 cells is allowed");
})();

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
