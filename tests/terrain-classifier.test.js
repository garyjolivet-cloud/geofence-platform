// Standalone Node test suite for the Artistic Fog-of-War Tiles terrain
// classifier's pure logic (backend/worker.js's named exports: OSM tag
// priority, elevation/slope thresholds, H3-cell variant hashing). This repo
// has no test runner/package.json script — run directly:
//   node tests/terrain-classifier.test.js
// Matches the ad-hoc-Node-script pattern already used by tests/kalman-filter.test.js.
"use strict";
const {
  TERRAIN_TAXONOMY, TERRAIN_LINE_TYPES, BIOME_FALLBACK,
  hashCellToVariant, classifyFromOsm, classifyElevationSlope,
  overpassElementToPolygon, overpassElementToLine
} = require("../backend/worker.js");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log("FAIL:", msg); }
}

// A square polygon around a center point, small enough to not overlap
// neighboring fixtures in these tests.
function squareAround(lon, lat, halfDegrees) {
  return overpassElementToPolygon({
    geometry: [
      { lon: lon - halfDegrees, lat: lat - halfDegrees },
      { lon: lon + halfDegrees, lat: lat - halfDegrees },
      { lon: lon + halfDegrees, lat: lat + halfDegrees },
      { lon: lon - halfDegrees, lat: lat + halfDegrees }
    ]
  });
}

// ============================================================
// (a) TERRAIN_TAXONOMY priority order — first matching rule wins. This is
// the exact list classify-terrain iterates in order (see worker.js's own
// comment: "area tags before linear tags... first matching rule wins").
// A regression here (e.g. someone reordering the array) would silently
// change which terrain type a multi-tagged real-world way resolves to.
// ============================================================
(function testTaxonomyPriorityOrder() {
  function firstMatch(tags) {
    const rule = TERRAIN_TAXONOMY.find(r => r.test(tags));
    return rule ? rule.type : null;
  }
  // A real OSM way is very often multi-tagged (e.g. a building inside a
  // park, or a beach that's also tagged sand) -- confirm the documented
  // priority actually holds for the taxonomy's own declared order.
  assert(firstMatch({ natural: "water" }) === "water_lake", "natural=water -> water_lake");
  assert(firstMatch({ natural: "wetland" }) === "wetland", "natural=wetland -> wetland");
  assert(firstMatch({ building: "yes", natural: "wood" }) === "urban_block",
    "building beats natural=wood (urban_block checked before forest)");
  assert(firstMatch({ highway: "pedestrian", natural: "sand" }) === "plaza",
    "highway=pedestrian beats natural=sand (plaza checked before sand)");
  assert(firstMatch({ natural: "sand", landuse: "farmland" }) === "sand",
    "natural=sand beats landuse=farmland (sand checked before farmland)");
  assert(firstMatch({ landuse: "farmland", natural: "wood" }) === "farmland",
    "landuse=farmland beats natural=wood (farmland checked before forest)");
  assert(firstMatch({ natural: "wood", natural2: "scrub" }) === "forest", "natural=wood -> forest");
  assert(firstMatch({ natural: "scrub" }) === "scrub", "natural=scrub -> scrub");
  assert(firstMatch({ natural: "bare_rock" }) === "rock_face", "natural=bare_rock -> rock_face");
  assert(firstMatch({ natural: "cliff" }) === "rock_face", "natural=cliff -> rock_face");
  assert(firstMatch({ natural: "scree", natural2: "grassland" }) === "scree",
    "natural=scree beats natural=grassland (scree checked before meadow)");
  assert(firstMatch({ natural: "glacier" }) === "snow", "natural=glacier -> snow");
  assert(firstMatch({ natural: "grassland" }) === "meadow", "natural=grassland -> meadow");
  assert(firstMatch({ landuse: "meadow" }) === "meadow", "landuse=meadow -> meadow");
  assert(firstMatch({}) === null, "no matching tags -> null (falls through to elevation/biome)");
})();

// ============================================================
// (b) TERRAIN_LINE_TYPES — waterway/highway tags, buffered-line categories.
// ============================================================
(function testLineTypesPriority() {
  function firstMatch(tags) {
    const rule = TERRAIN_LINE_TYPES.find(r => r.test(tags));
    return rule ? rule.type : null;
  }
  assert(firstMatch({ waterway: "river" }) === "water_river", "waterway=river -> water_river");
  assert(firstMatch({ waterway: "stream" }) === "water_river", "waterway=stream -> water_river");
  assert(firstMatch({ highway: "path" }) === "trail", "highway=path -> trail");
  assert(firstMatch({ highway: "footway" }) === "trail", "highway=footway -> trail");
  assert(firstMatch({ highway: "track" }) === "trail", "highway=track -> trail");
  assert(firstMatch({ "piste:type": "downhill" }) === "trail", "piste:type=* -> trail");
  assert(firstMatch({ highway: "motorway" }) === null, "highway=motorway (not in the trail list) -> null");
})();

// ============================================================
// (c) classifyFromOsm — real point-in-polygon classification against
// synthetic OSM-shaped area features, the way classify-terrain actually
// calls it per H3 cell centroid.
// ============================================================
(function testClassifyFromOsm() {
  const lakePoly = squareAround(-117.20, 51.30, 0.01);
  const forestPoly = squareAround(-117.00, 51.30, 0.01);
  const areaFeatures = [
    { type: "water_lake", poly: lakePoly },
    { type: "forest", poly: forestPoly }
  ];
  const trailLine = overpassElementToLine({ geometry: [{ lon: -116.80, lat: 51.30 }, { lon: -116.79, lat: 51.31 }] });
  let trailBuf = null;
  try { trailBuf = require("@turf/turf").buffer(trailLine, 4 / 1000, { units: "kilometers" }); } catch (e) {}
  const lineFeatures = trailBuf ? [{ type: "trail", poly: trailBuf }] : [];

  assert(classifyFromOsm(-117.20, 51.30, areaFeatures, lineFeatures) === "water_lake",
    "point inside the lake polygon classifies as water_lake");
  assert(classifyFromOsm(-117.00, 51.30, areaFeatures, lineFeatures) === "forest",
    "point inside the forest polygon classifies as forest");
  assert(classifyFromOsm(-116.795, 51.305, areaFeatures, lineFeatures) === "trail",
    "point on the buffered trail line classifies as trail");
  assert(classifyFromOsm(-115.00, 51.30, areaFeatures, lineFeatures) === null,
    "point outside every feature returns null (falls through to elevation/biome)");
  // Area features are checked before line features (classify-terrain's own
  // ordering) -- a point inside both an area and near a line resolves to
  // the area match.
  const overlapLine = overpassElementToLine({ geometry: [{ lon: -117.205, lat: 51.295 }, { lon: -117.195, lat: 51.305 }] });
  let overlapBuf = null;
  try { overlapBuf = require("@turf/turf").buffer(overlapLine, 4 / 1000, { units: "kilometers" }); } catch (e) {}
  if (overlapBuf) {
    const withOverlap = classifyFromOsm(-117.20, 51.30, areaFeatures, [{ type: "trail", poly: overlapBuf }]);
    assert(withOverlap === "water_lake", "area match takes priority over an overlapping line match at the same point");
  }
})();

// ============================================================
// (d) classifyElevationSlope — the fallback heuristic thresholds, tuned
// against Kicking Horse alpine terrain (see CLAUDE.md). A regression here
// silently reclassifies real cells whenever OSM has no tag for them.
// ============================================================
(function testElevationSlopeThresholds() {
  assert(classifyElevationSlope(1000, 40) === "rock_face", "slope>35deg -> rock_face regardless of elevation");
  assert(classifyElevationSlope(3000, 36) === "rock_face", "slope>35deg -> rock_face even at high elevation");
  assert(classifyElevationSlope(2500, 25) === "scree", "slope 20-35deg above 2200m -> scree");
  assert(classifyElevationSlope(1500, 25) !== "scree", "slope>20deg but below 2200m -> NOT scree (falls through)");
  assert(classifyElevationSlope(1500, 25) === null, "slope>20deg below 2200m and below 2800m -> null (no elevation signal)");
  assert(classifyElevationSlope(3000, 10) === "snow", "gentle slope above 2800m -> snow");
  assert(classifyElevationSlope(2000, 5) === null, "gentle slope, moderate elevation -> null (falls through to biome fallback)");
  // Boundary values -- confirm the comparisons are strict > , not >=, matching
  // the source exactly (worker.js: `slopeDeg > 35`, `elevationM > 2200`, `elevationM > 2800`).
  assert(classifyElevationSlope(2200, 25) === null, "elevation exactly at the 2200m scree threshold does NOT qualify (strict >)");
  assert(classifyElevationSlope(2800, 5) === null, "elevation exactly at the 2800m snow threshold does NOT qualify (strict >)");
  assert(classifyElevationSlope(1000, 35) === null, "slope exactly at the 35deg rock_face threshold does NOT qualify (strict >)");
})();

// ============================================================
// (e) BIOME_FALLBACK — the per-project last-resort default, keyed by the
// project.terrain_biome values the PATCH route validates against.
// ============================================================
(function testBiomeFallback() {
  assert(BIOME_FALLBACK.alpine === "meadow", "alpine biome falls back to meadow");
  assert(BIOME_FALLBACK.forest === "forest", "forest biome falls back to forest");
  assert(BIOME_FALLBACK.coastal === "sand", "coastal biome falls back to sand");
  assert(BIOME_FALLBACK.urban === "plaza", "urban biome falls back to plaza");
  assert(BIOME_FALLBACK.farmland === "farmland", "farmland biome falls back to farmland");
  assert(Object.keys(BIOME_FALLBACK).length === 5, "exactly 5 biome options (matches the PATCH route's validation set)");
})();

// ============================================================
// (f) hashCellToVariant — deterministic, stable across repeated calls
// (re-running classify-terrain after a corridor edit must not visually
// reshuffle tiles a visitor has already walked past -- see worker.js's own
// comment on terrain_cell.variant_index).
// ============================================================
(function testHashCellToVariant() {
  const cellA = "8a12c045a08ffff", cellB = "8a12c045a0affff";
  const v1 = hashCellToVariant(cellA);
  const v2 = hashCellToVariant(cellA);
  assert(v1 === v2, "same H3 cell hashes to the same variant every time (deterministic, not random)");
  assert(v1 >= 0 && v1 <= 2, "variant index is always in range [0,2] (3 variants per category)");
  const vB = hashCellToVariant(cellB);
  assert(typeof vB === "number" && vB >= 0 && vB <= 2, "a different cell also hashes into [0,2]");
  // Distribution sanity check -- not a strict requirement, but a hash that
  // collapsed to a single constant would defeat the whole "avoid visible
  // repetition" purpose the 3-variants-per-category design exists for.
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(hashCellToVariant("8a12c045a0" + String(i).padStart(4, "0") + "fff"));
  assert(seen.size === 3, "hashing many distinct cells produces all 3 variant buckets, not a degenerate constant");
})();

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
