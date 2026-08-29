// Unit tests for two real gaps found in a 2026-08-21 codebase audit,
// both in frontend/fence-editor.html:
//
// 1. SimFencer.sd() (Test Mode's own local trigger-detection copy — the
//    third of the three "verbatim mirror" engine-core copies alongside
//    geofence-engine.html's Geofencer and geofence-sim.html's own copy,
//    see CLAUDE.md) had no corridor branch at all, unlike its two
//    siblings — a corridor-shaped stop's pipeline (speak/webhook/guide)
//    could never fire during a Test Mode walk, silently, with nothing
//    else in the UI suggesting why.
// 2. validateZoneGeometry() (the publish-time sanity check) validated
//    circle/polygon/tripline but had no corridor/path minimum-points
//    check — a degenerate <2-point corridor (e.g. a bad GPX import that
//    collapsed to one point) could reach the live engine unfireable
//    with no warning, the exact failure mode this function exists to
//    catch for every other shape type.
//
// Both extracted verbatim out of the shipped file (brace-depth counting,
// same technique as tests/quest-completion-pct.test.js), not
// reimplemented — this tests the actual code that ships.
//
// Run: `node tests/fence-editor-corridor-mirror.test.js` (or as part of
// the full `node --test tests/` suite... note this repo's tests are run
// individually with plain `node`, not the node:test runner — see any
// sibling tests/*.test.js file for the same pattern).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8");

function extractMethodBody(startTag) {
  const startIdx = html.indexOf(startTag);
  if (startIdx < 0) throw new Error("could not find " + startTag + " in fence-editor.html");
  let depth = 0, i = html.indexOf("{", startIdx), bodyStart = i + 1;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(bodyStart, i);
}

// ---- extract SimGeo (toXY/segDist/sdPolygon/sdCircle — the geometry
// helpers SimFencer.sd() depends on) ----
const simGeoM = html.match(/const SimGeo=\{[\s\S]*?\n\};/);
if (!simGeoM) { console.log("FAIL: could not extract SimGeo from fence-editor.html"); process.exit(1); }
// eslint-disable-next-line no-new-func
const SimGeo = new Function("return " + simGeoM[0].replace(/^const SimGeo=/, "").replace(/;$/, ""))();

// ---- extract SimFencer.sd()'s method body as a standalone function ----
// eslint-disable-next-line no-new-func
const simFencerSd = new Function(
  "PT", "zone", "layer", "now", "SimGeo", "simBundle", "simAmbientCenterNow",
  extractMethodBody("sd(PT,zone,layer,now){")
);

// ---- extract haversineM + validateZoneGeometry (standalone functions) ----
// eslint-disable-next-line no-new-func
const haversineM = new Function("a", "b", extractMethodBody("function haversineM(a,b){"));
// eslint-disable-next-line no-new-func
const validateZoneGeometry = new Function(
  "zs", "haversineM",
  extractMethodBody("function validateZoneGeometry(zs){")
);

const simBundle = { ref: [51.305, -117.05] };
// A straight north-south corridor, matching the fixture convention
// tests/quest-corridor-detection.test.js already uses for the exact same
// production geometry (Geofencer.sd()'s corridor branch).
const corridorLayer = {
  kind: "target",
  geometry: { type: "corridor", path: [[51.310, -117.05], [51.300, -117.05]], widthM: 20 }
};

(function testSimFencerCorridorInsideBandIsNegative() {
  const d = simFencerSd([51.305, -117.05], {}, corridorLayer, Date.now(), SimGeo, simBundle);
  assert(d < 0, "a point on the corridor centerline is inside the band (d<0), got " + d);
})();

(function testSimFencerCorridorOutsideBandIsPositive() {
  // ~200m east of the centerline, well outside a 20m-wide corridor.
  const d = simFencerSd([51.305, -117.048], {}, corridorLayer, Date.now(), SimGeo, simBundle);
  assert(d > 0, "a point far off the centerline is outside the band (d>0), got " + d);
})();

(function testSimFencerCorridorNoLongerReturnsNull() {
  // The actual regression this test guards: before the fix, EVERY corridor
  // layer hit the final `return null` regardless of position, meaning
  // _step() (gated on `if(sd==null)return;`) could never advance a
  // corridor stop's trigger state machine out of "out" at all.
  const d = simFencerSd([51.305, -117.05], {}, corridorLayer, Date.now(), SimGeo, simBundle);
  assert(d !== null, "SimFencer.sd() returns a real signed distance for a corridor layer, not null, got " + d);
})();

(function testSimFencerPolygonUnaffected() {
  // Confirm the fix didn't disturb the pre-existing polygon branch above it.
  const polyLayer = { kind: "target", geometry: { type: "polygon", coords: [[51.301, -117.051], [51.301, -117.049], [51.299, -117.05]] } };
  const d = simFencerSd([51.3003, -117.05], {}, polyLayer, Date.now(), SimGeo, simBundle);
  assert(typeof d === "number", "polygon layers still resolve to a real number, got " + d);
})();

(function testValidateGeometryRejectsShortCorridor() {
  const zs = [{ name: "Bad Corridor", shape: { type: "corridor", coords: [[-117.05, 51.305]] } }];
  const problems = validateZoneGeometry(zs, haversineM);
  assert(problems.length === 1 && /corridor needs at least 2 points/.test(problems[0]),
    "a 1-point corridor is rejected with a clear message, got " + JSON.stringify(problems));
})();

(function testValidateGeometryAcceptsValidCorridor() {
  const zs = [{ name: "Good Corridor", shape: { type: "corridor", coords: [[-117.05, 51.310], [-117.05, 51.300]] } }];
  const problems = validateZoneGeometry(zs, haversineM);
  assert(problems.length === 0, "a 2-point corridor passes validation, got " + JSON.stringify(problems));
})();

// (The former "path needs at least 2 points" check went away with the
// "path" shape type — Path/Walking Path/Corridor were consolidated into
// one "corridor" concept, migration 0055. A moving-audio corridor is still
// a corridor and covered by the corridor check above.)

(function testValidateGeometryUnaffectedForOtherShapes() {
  // Confirm the new branches didn't disturb the three pre-existing checks.
  const zs = [
    { name: "Good Circle", shape: { type: "circle", radiusM: 12 } },
    { name: "Bad Circle", shape: { type: "circle", radiusM: 0 } },
    { name: "Good Polygon", shape: { type: "polygon", coords: [[0, 0], [0, 1], [1, 0]] } },
    { name: "Bad Tripline", shape: { type: "tripline", from: [51.3, -117.05], to: [51.3, -117.05] } }
  ];
  const problems = validateZoneGeometry(zs, haversineM);
  assert(problems.length === 2, "circle-radius and tripline-degenerate checks still fire as before, got " + JSON.stringify(problems));
})();

// ---- moving-audio corridor serialization is mirrored across all 3 sites ----
// Path/Walking Path/Corridor were consolidated (migration 0055). "Moving
// audio" is now a toggle on a corridor that re-serializes to the former
// "Path" bundle form (top-level zo.path + movement fields). This is the
// one genuinely new serialization behavior, and — per CLAUDE.md's
// verbatim-mirror rule — it must be handled identically in zoneToEngine
// (publish), engineToZone (import), and editorToSimBundle (Test Mode).
// This test guards the source of all three against a future edit dropping
// it from one, without needing a full runtime scaffold.
(function testMovingAudioMirroredInAllThree() {
  const zoneToEngine = extractMethodBody("function zoneToEngine(z){");
  const engineToZone = extractMethodBody("function engineToZone(zo){");
  const editorToSimBundle = extractMethodBody("function editorToSimBundle(){");

  // The retired "path" shape type must not linger in any of the three.
  for (const [name, body] of [["zoneToEngine", zoneToEngine], ["engineToZone", engineToZone], ["editorToSimBundle", editorToSimBundle]]) {
    assert(!/["']path["']/.test(body) || /zo\.path|z\.path|\.path\b/.test(body),
      name + " no longer references a \"path\" shape-type string");
  }

  // zoneToEngine: a moving-audio corridor emits top-level path + marker + width.
  assert(/movingAudio/.test(zoneToEngine) && /zo\.path\s*=/.test(zoneToEngine) &&
    /zo\.movingAudio\s*=\s*true/.test(zoneToEngine) && /zo\.widthM\s*=/.test(zoneToEngine),
    "zoneToEngine emits zo.path + zo.movingAudio + zo.widthM for a moving-audio corridor");

  // engineToZone: reconstructs a corridor with movingAudio from a top-level path.
  assert(/movingCorridor\s*=\s*Array\.isArray\(zo\.path\)/.test(engineToZone) &&
    /type:\s*["']corridor["']/.test(engineToZone) && /z\.movingAudio\s*=\s*true/.test(engineToZone),
    "engineToZone rebuilds a corridor with movingAudio=true when zo.path is present");

  // editorToSimBundle: same top-level path emission, gated on movingAudio.
  assert(/movingAudio/.test(editorToSimBundle) && /out\.path\s*=/.test(editorToSimBundle) &&
    /out\.movingAudio\s*=\s*true/.test(editorToSimBundle),
    "editorToSimBundle emits out.path + out.movingAudio for a moving-audio corridor");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
