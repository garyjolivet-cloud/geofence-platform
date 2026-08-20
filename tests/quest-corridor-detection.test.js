// Unit tests for Ridge Quest R1's corridor-crossing detector: the
// signed-distance-to-corridor math (QGeo.corridorDist) and the
// classification logic (direction via nearest-endpoint, ski/lift/hike
// activity, duration gating) in frontend/ridge-quest.html.
//
// Extracts the real QGeo object and the real classification body of
// Quest._classifyAndLog straight out of the shipped file via vm, so this
// tests the actual code that ships, not a reimplementation — same
// technique tests/cylinder-segment-cross.test.js already established for
// this codebase's other self-contained geometry modules. The classification
// body is wrapped in a standalone function (stripping only the trailing
// `api(...)` POST call, which needs a live fetch/session and belongs to a
// manual on-mountain test, not a unit test) rather than reimplemented.
//
// Run: `node --test tests/quest-corridor-detection.test.js` (or as part of
// the full `node --test tests/` suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");

// ---- extract QGeo (the local corridor/haversine geometry helpers) ----
const qgeoM = html.match(/const QGeo = \{[\s\S]*?\n\};/);
if (!qgeoM) { console.log("FAIL: could not extract QGeo from ridge-quest.html"); process.exit(1); }
const QGeo = eval("(" + qgeoM[0].replace(/^const QGeo = /, "").replace(/;$/, "") + ")");

// ---- extract QUEST_TUNING ----
const tuningM = html.match(/const QUEST_TUNING = \{[\s\S]*?\n\};/);
if (!tuningM) { console.log("FAIL: could not extract QUEST_TUNING from ridge-quest.html"); process.exit(1); }
const QUEST_TUNING = eval("(" + tuningM[0].replace(/^const QUEST_TUNING = /, "").replace(/;$/, "") + ")");

// ---- extract the classification body of Quest._classifyAndLog, stopping
// before the api() POST (needs a live session/fetch, out of scope for a
// unit test) ----
const startTag = "_classifyAndLog(corridor, buffer, selectedActivity){";
const startIdx = html.indexOf(startTag);
if (startIdx < 0) { console.log("FAIL: could not find _classifyAndLog in ridge-quest.html"); process.exit(1); }
const endTag = "\n    api(\"/api/quest-runs\"";
const endIdx = html.indexOf(endTag, startIdx);
if (endIdx < 0) { console.log("FAIL: could not find end of _classifyAndLog body in ridge-quest.html"); process.exit(1); }
const classifyBody = html.slice(startIdx + startTag.length, endIdx) + "\nreturn run;";
// eslint-disable-next-line no-new-func
const classify = new Function("corridor", "buffer", "selectedActivity", "QGeo", "QUEST_TUNING", classifyBody);

// ---- test fixtures ----
// A straight north-south corridor near Golden BC, "top" at path[0] (higher
// latitude), "bottom" at path[1] — matches the authoring convention
// (Fence Editor draws top to bottom) the direction-classification comment
// documents.
const straightRun = {
  zoneId: "z1", name: "Test Run", difficulty: "blue", runType: "run", widthM: 20,
  path: [[51.310, -117.05], [51.300, -117.05]],
  ref: [51.305, -117.05]
};
// path[0] is "top" by the same authoring convention as straightRun above
// (Fence Editor draws a corridor top to bottom) — a lift's top terminal is
// path[0], its base is path[1].
const liftLine = {
  zoneId: "z2", name: "Test Lift", difficulty: null, runType: "lift", widthM: 15,
  path: [[51.310, -117.05], [51.300, -117.05]],
  ref: [51.305, -117.05]
};
const hikeRoute = {
  zoneId: "z3", name: "Test Hike", difficulty: null, runType: "hike", widthM: 15,
  path: [[51.310, -117.05], [51.300, -117.05]],
  ref: [51.305, -117.05]
};

function mkFix(lat, lon, tOffsetS, extra) {
  return Object.assign({ lat, lon, t: 1700000000000 + tOffsetS * 1000, speed: 0, alt: null }, extra || {});
}

// ---- QGeo.corridorDist ----

(function testCorridorDistInsideBand() {
  const d = QGeo.corridorDist([51.305, -117.05], straightRun, straightRun.ref);
  assert(d < 0, "a point on the corridor centerline is inside the band (d<0), got " + d);
})();

(function testCorridorDistOutsideBand() {
  // ~200m east of the centerline, well outside a 20m-wide corridor.
  const d = QGeo.corridorDist([51.305, -117.048], straightRun, straightRun.ref);
  assert(d > 0, "a point far off the centerline is outside the band (d>0), got " + d);
})();

(function testCorridorDistHalfWidthBoundary() {
  // corridorDist = perpendicular distance minus widthM/2 — at exactly the
  // half-width offset, d should be ~0.
  const halfWidthDeg = (straightRun.widthM / 2) / QGeo.mPerDegLon(51.305);
  const d = QGeo.corridorDist([51.305, -117.05 + halfWidthDeg], straightRun, straightRun.ref);
  assert(Math.abs(d) < 0.5, "point exactly at the half-width offset has d~=0, got " + d);
})();

// ---- classify(): direction + activity ----

(function testSkiDescendingFastEnough() {
  const buffer = [
    mkFix(51.310, -117.05, 0, { speed: 6 }),
    mkFix(51.305, -117.05, 20, { speed: 6 }),
    mkFix(51.300, -117.05, 40, { speed: 6 })
  ];
  const run = classify(straightRun, buffer, "ski", QGeo, QUEST_TUNING);
  assert(run && run.activity === "ski", "descending fast enough on a plain run classifies as ski, got " + (run && run.activity));
})();

(function testHikeDescendingTooSlow() {
  const buffer = [
    mkFix(51.310, -117.05, 0, { speed: 1 }),
    mkFix(51.305, -117.05, 60, { speed: 1 }),
    mkFix(51.300, -117.05, 120, { speed: 1 })
  ];
  const run = classify(straightRun, buffer, "ski", QGeo, QUEST_TUNING);
  assert(run && run.activity === "hike", "descending too slowly on a plain run classifies as hike (skinning), got " + (run && run.activity));
})();

(function testHikeAscendingOnPlainRun() {
  const buffer = [
    mkFix(51.300, -117.05, 0, { speed: 1 }),
    mkFix(51.305, -117.05, 60, { speed: 1 }),
    mkFix(51.310, -117.05, 120, { speed: 1 })
  ];
  const run = classify(straightRun, buffer, "ski", QGeo, QUEST_TUNING);
  assert(run && run.activity === "hike", "ascending a plain run (not descending, so never 'ski') classifies as hike, got " + (run && run.activity));
})();

(function testLiftAscending() {
  const buffer = [
    mkFix(51.300, -117.05, 0, { speed: 4 }),
    mkFix(51.310, -117.05, 300, { speed: 4 })
  ];
  const run = classify(liftLine, buffer, "ski", QGeo, QUEST_TUNING);
  assert(run && run.activity === "lift", "ascending a lift corridor classifies as lift, got " + (run && run.activity));
})();

(function testLiftDescendingDiscarded() {
  const buffer = [
    mkFix(51.310, -117.05, 0, { speed: 4 }),
    mkFix(51.300, -117.05, 300, { speed: 4 })
  ];
  const run = classify(liftLine, buffer, "ski", QGeo, QUEST_TUNING);
  assert(run === undefined, "descending a lift corridor (foot traffic) is discarded, not logged, got " + JSON.stringify(run));
})();

(function testHikeRouteAlwaysHike() {
  const buffer = [
    mkFix(51.300, -117.05, 0, { speed: 1 }),
    mkFix(51.310, -117.05, 400, { speed: 1 })
  ];
  const run = classify(hikeRoute, buffer, "ski", QGeo, QUEST_TUNING);
  assert(run && run.activity === "hike", "any crossing of a hike-type corridor classifies as hike, got " + (run && run.activity));
})();

(function testTooShortDiscarded() {
  const buffer = [
    mkFix(51.310, -117.05, 0, { speed: 6 }),
    mkFix(51.300, -117.05, 2, { speed: 6 }) // 2s, below MIN_DURATION_S
  ];
  const run = classify(straightRun, buffer, "ski", QGeo, QUEST_TUNING);
  assert(run === undefined, "a crossing shorter than MIN_DURATION_S is discarded (flicker), got " + JSON.stringify(run));
})();

(function testTooLongDiscarded() {
  const buffer = [
    mkFix(51.310, -117.05, 0, { speed: 6 }),
    mkFix(51.300, -117.05, 6000, { speed: 6 }) // 100min, above MAX_DURATION_S
  ];
  const run = classify(straightRun, buffer, "ski", QGeo, QUEST_TUNING);
  assert(run === undefined, "a crossing longer than MAX_DURATION_S is discarded (stuck GPS), got " + JSON.stringify(run));
})();

(function testVerticalDeltaFromAltitude() {
  const buffer = [
    mkFix(51.310, -117.05, 0, { speed: 6, alt: 2400 }),
    mkFix(51.300, -117.05, 40, { speed: 6, alt: 2100 })
  ];
  const run = classify(straightRun, buffer, "ski", QGeo, QUEST_TUNING);
  assert(run && run.verticalM === -300, "vertical_m is the net (last-first) altitude delta, got " + (run && run.verticalM));
})();

(function testVerticalNullWithoutAltitude() {
  const buffer = [
    mkFix(51.310, -117.05, 0, { speed: 6 }),
    mkFix(51.300, -117.05, 40, { speed: 6 })
  ];
  const run = classify(straightRun, buffer, "ski", QGeo, QUEST_TUNING);
  assert(run && run.verticalM === null, "vertical_m is null when no fix carried an altitude reading, got " + (run && run.verticalM));
})();

// ---- R8: selectedActivity — manual player choice drives classification
// on plain (non-lift, non-hike-runType) corridors ----

(function testBikeDescendingFastEnough() {
  const buffer = [
    mkFix(51.310, -117.05, 0, { speed: 5 }),
    mkFix(51.305, -117.05, 20, { speed: 5 }),
    mkFix(51.300, -117.05, 40, { speed: 5 })
  ];
  const run = classify(straightRun, buffer, "bike", QGeo, QUEST_TUNING);
  assert(run && run.activity === "bike", "descending fast enough with bike selected classifies as bike, got " + (run && run.activity));
})();

(function testBikeDescendingTooSlowFallsBackToHike() {
  const buffer = [
    mkFix(51.310, -117.05, 0, { speed: 1 }),
    mkFix(51.305, -117.05, 60, { speed: 1 }),
    mkFix(51.300, -117.05, 120, { speed: 1 })
  ];
  const run = classify(straightRun, buffer, "bike", QGeo, QUEST_TUNING);
  assert(run && run.activity === "hike", "descending too slowly with bike selected falls back to hike (pushing the bike), got " + (run && run.activity));
})();

(function testHikeSelectedOverridesSpeed() {
  // Fast enough to clear the SKI threshold, but hike was explicitly
  // selected — manual choice overrides auto-detection entirely for hike.
  const buffer = [
    mkFix(51.310, -117.05, 0, { speed: 6 }),
    mkFix(51.305, -117.05, 20, { speed: 6 }),
    mkFix(51.300, -117.05, 40, { speed: 6 })
  ];
  const run = classify(straightRun, buffer, "hike", QGeo, QUEST_TUNING);
  assert(run && run.activity === "hike", "hike selected classifies as hike regardless of speed, got " + (run && run.activity));
})();

(function testDriveSelectedAnySpeed() {
  const buffer = [
    mkFix(51.310, -117.05, 0, { speed: 15 }),
    mkFix(51.300, -117.05, 40, { speed: 15 })
  ];
  const run = classify(straightRun, buffer, "drive", QGeo, QUEST_TUNING);
  assert(run && run.activity === "drive", "drive selected classifies as drive at any speed, got " + (run && run.activity));
})();

(function testDriveSelectedEvenAscending() {
  // Manual override, no direction check either — driving up a road logs
  // as drive, not silently discarded the way an ascending ski corridor
  // (non-lift) would fall to "hike" under the default branch.
  const buffer = [
    mkFix(51.300, -117.05, 0, { speed: 15 }),
    mkFix(51.310, -117.05, 40, { speed: 15 })
  ];
  const run = classify(straightRun, buffer, "drive", QGeo, QUEST_TUNING);
  assert(run && run.activity === "drive", "drive selected classifies as drive even ascending, got " + (run && run.activity));
})();

(function testBikeCrossingLiftCorridorStillLift() {
  // Lift detection stays authoritative regardless of what's selected — you
  // can't "select" your way out of having ridden a lift.
  const buffer = [
    mkFix(51.300, -117.05, 0, { speed: 4 }),
    mkFix(51.310, -117.05, 300, { speed: 4 })
  ];
  const run = classify(liftLine, buffer, "bike", QGeo, QUEST_TUNING);
  assert(run && run.activity === "lift", "ascending a lift corridor is still a lift ride regardless of selectedActivity, got " + (run && run.activity));
})();

(function testBikeCrossingHikeRuntypeStillHike() {
  // A corridor the author explicitly marked runType:"hike" stays hike even
  // with a different activity selected — it's a real hiking-only trail.
  const buffer = [
    mkFix(51.300, -117.05, 0, { speed: 5 }),
    mkFix(51.310, -117.05, 60, { speed: 5 })
  ];
  const run = classify(hikeRoute, buffer, "bike", QGeo, QUEST_TUNING);
  assert(run && run.activity === "hike", "a runType:hike corridor stays hike regardless of selectedActivity, got " + (run && run.activity));
})();

// ---- R9: coverage-percentage gate — fixes the "traverse clips multiple
// nearby corridors" over-crediting bug by requiring the crossing to have
// actually covered most of THIS corridor's own length, not just entered
// and exited its band once ----

(function testPerpendicularClipDiscardedForLowCoverage() {
  // A short crossing near the corridor's midpoint only (like a traverse
  // clipping across a chute) — covers a sliver of the corridor's ~1.1km
  // length, nowhere near CORRIDOR_COMPLETION_PCT.
  const buffer = [
    mkFix(51.305, -117.0505, 0, { speed: 2 }),
    mkFix(51.305, -117.0495, 20, { speed: 2 })
  ];
  const run = classify(straightRun, buffer, "ski", QGeo, QUEST_TUNING);
  assert(run === undefined, "a brief midpoint-only clip is discarded for low coverage, got " + JSON.stringify(run));
})();

(function testPartialDescentBelowThresholdDiscarded() {
  // Covers only the top ~30% of the corridor's length (dropped in, stopped
  // partway) — below the default 50% threshold.
  const buffer = [
    mkFix(51.310, -117.05, 0, { speed: 6 }),
    mkFix(51.307, -117.05, 15, { speed: 6 })
  ];
  const run = classify(straightRun, buffer, "ski", QGeo, QUEST_TUNING);
  assert(run === undefined, "covering well under half the corridor's length is discarded, got " + JSON.stringify(run));
})();

(function testFullDescentSparseBufferPasses() {
  // Only 2 fixes (start/end of the full corridor) — a fast mover's sparse
  // fix sequence still traces the corridor's whole length as a polyline,
  // so coverage is measured against that line, not against the 2 raw
  // points, and a genuine full descent isn't penalized for having few fixes.
  const buffer = [
    mkFix(51.310, -117.05, 0, { speed: 6 }),
    mkFix(51.300, -117.05, 40, { speed: 6 })
  ];
  const run = classify(straightRun, buffer, "ski", QGeo, QUEST_TUNING);
  assert(run && run.activity === "ski", "a full-length crossing with only 2 fixes still passes the coverage gate, got " + JSON.stringify(run));
})();

(function testOnCoverageFeedbackFires() {
  const calls = [];
  const self = { onCoverage: (name, pct, passed) => calls.push({ name, pct, passed }) };
  const buffer = [
    mkFix(51.310, -117.05, 0, { speed: 6 }),
    mkFix(51.300, -117.05, 40, { speed: 6 })
  ];
  classify.call(self, straightRun, buffer, "ski", QGeo, QUEST_TUNING);
  assert(calls.length === 1, "onCoverage fires once per classified crossing, got " + calls.length);
  assert(calls[0].name === "Test Run", "onCoverage receives the corridor's name, got " + calls[0].name);
  assert(calls[0].pct > 0.9, "a full-length crossing reports high coverage, got " + calls[0].pct);
  assert(calls[0].passed === true, "a full-length crossing reports passed=true, got " + calls[0].passed);
})();

(function testOnCoverageFeedbackFiresOnDiscard() {
  const calls = [];
  const self = { onCoverage: (name, pct, passed) => calls.push({ name, pct, passed }) };
  const buffer = [
    mkFix(51.305, -117.0505, 0, { speed: 2 }),
    mkFix(51.305, -117.0495, 20, { speed: 2 })
  ];
  classify.call(self, straightRun, buffer, "ski", QGeo, QUEST_TUNING);
  assert(calls.length === 1, "onCoverage fires even when the crossing is discarded for low coverage, got " + calls.length);
  assert(calls[0].passed === false, "a low-coverage crossing reports passed=false, got " + calls[0].passed);
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
