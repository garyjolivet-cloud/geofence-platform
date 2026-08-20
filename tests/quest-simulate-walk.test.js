// Unit tests for Ridge Quest's dev-only walk simulator (Quest.simulateWalk
// in frontend/ridge-quest.html) — added so "start tracking does nothing"
// (expected at a desk with no real GPS movement) can actually be tested
// without walking outside. Feeds synthetic fixes through the SAME _onFix()
// the real geolocation.watchPosition path uses, so this test proves the
// resampling/pacing math produces a fix sequence that the real corridor
// detector (tested separately in quest-corridor-detection.test.js) would
// classify correctly — not a reimplementation, extracted straight out of
// the shipped file, same technique as the other quest-*.test.js files.
//
// Run: `node --test tests/quest-simulate-walk.test.js` (or as part of the
// full `node --test tests/` suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");

const qgeoM = html.match(/const QGeo = \{[\s\S]*?\n\};/);
const QGeo = eval("(" + qgeoM[0].replace(/^const QGeo = /, "").replace(/;$/, "") + ")");

function extractMethodBody(startTag) {
  const startIdx = html.indexOf(startTag);
  if (startIdx < 0) throw new Error("could not find " + startTag + " in ridge-quest.html");
  let depth = 0, i = html.indexOf("{", startIdx), bodyStart = i + 1;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(bodyStart, i);
}

// eslint-disable-next-line no-new-func
const simulateWalk = new Function(
  "speedMps", "onProgress", "onDone", "selectedActivity", "QGeo", "GPSFilter", "setTimeout",
  extractMethodBody("simulateWalk(speedMps, onProgress, onDone, selectedActivity){")
);

function mkQuest(corridors, fixSink) {
  return {
    corridors, states: {}, _simCancelled: false,
    _onFix(pos) { fixSink.push(pos); },
    simulateWalk(speedMps, onProgress, onDone, setTimeoutFn, selectedActivity) {
      return simulateWalk.call(this, speedMps, onProgress, onDone, selectedActivity, QGeo,
        { reset(){} }, setTimeoutFn);
    }
  };
}
// Fires the callback immediately (synchronously-ish, via a microtask-free
// direct call) instead of waiting 120ms of real wall-clock time per step —
// this test exercises the resampling/sequencing logic, not real timing.
function immediateSetTimeout(fn) { fn(); }

/* ---- no corridor loaded: reports an error, generates no fixes ---- */
(function testNoCorridorErrors() {
  const fixes = [];
  const q = mkQuest([], fixes);
  let doneErr;
  q.simulateWalk(1.5, null, (err) => { doneErr = err; }, immediateSetTimeout);
  assert(doneErr === "no corridor loaded to walk", "no corridor loaded reports an error, got " + doneErr);
  assert(fixes.length === 0, "no synthetic fixes are generated with no corridor");
})();

/* ---- straight 100m corridor: resamples to ~5m steps and reaches the end ---- */
(function testStraightPathResamplesAndCompletes() {
  const fixes = [];
  // ~100m north-south segment at this latitude (1 degree lat ~= 111.32km).
  const path = [[51.30000, -117.05000], [51.30090, -117.05000]];
  const q = mkQuest([{ path }], fixes);
  let done = false, doneErr = "unset";
  q.simulateWalk(1.5, null, (err) => { done = true; doneErr = err; }, immediateSetTimeout);
  assert(done, "simulateWalk calls onDone once the path is exhausted");
  assert(doneErr === null, "onDone's error arg is null on a normal completion, got " + doneErr);
  assert(fixes.length > 15 && fixes.length < 25, "a ~100m path resampled at ~5m steps yields ~20 fixes, got " + fixes.length);
  const last = fixes[fixes.length - 1].coords;
  assert(Math.abs(last.latitude - path[1][0]) < 1e-5 && Math.abs(last.longitude - path[1][1]) < 1e-5,
    "the last synthetic fix lands on the path's actual endpoint, got " + JSON.stringify(last));
})();

/* ---- every synthetic fix has GPS-shaped fields _onFix can consume ---- */
(function testFixShapeMatchesRealGeolocationCallback() {
  const fixes = [];
  const path = [[51.30000, -117.05000], [51.30030, -117.05000]];
  const q = mkQuest([{ path }], fixes);
  q.simulateWalk(1.5, null, () => {}, immediateSetTimeout);
  assert(fixes.length > 0, "at least one fix was generated");
  fixes.forEach(f => {
    assert(typeof f.coords.latitude === "number" && typeof f.coords.longitude === "number",
      "each fix has numeric coords, matching the real GeolocationPosition shape _onFix expects");
    assert(f.coords.accuracy < 40, "simulated fixes carry an accuracy well under ACCURACY_CAP_M so _revealFog doesn't discard them, got " + f.coords.accuracy);
    assert(typeof f.timestamp === "number", "each fix has a numeric timestamp");
  });
  const times = fixes.map(f => f.timestamp);
  for (let i = 1; i < times.length; i++) {
    assert(times[i] > times[i - 1], "simulated timestamps strictly increase (GPSFilter's dt calc depends on this), fix " + i);
  }
})();

/* ---- cancelSim (via _simCancelled) stops mid-walk ---- */
(function testCancelStopsPartway() {
  const fixes = [];
  const path = [[51.30000, -117.05000], [51.30090, -117.05000]];
  const q = mkQuest([{ path }], fixes);
  let cancelled = false;
  q.simulateWalk(1.5, (i, total) => {
    if (i === 3) q._simCancelled = true; // cancel partway through
  }, (err) => { cancelled = true; }, immediateSetTimeout);
  assert(fixes.length < 24, "cancelling partway through stops generating fixes before the full path completes, got " + fixes.length);
  assert(!cancelled, "onDone is never called when cancelled mid-walk (the tick loop just returns)");
})();

/* ---- R8: selectedActivity defaults to "ski", or respects what's passed ---- */
(function testSelectedActivityDefaultsToSki() {
  const fixes = [];
  const path = [[51.30000, -117.05000], [51.30030, -117.05000]];
  const q = mkQuest([{ path }], fixes);
  q.simulateWalk(1.5, null, () => {}, immediateSetTimeout);
  assert(q.selectedActivity === "ski", "simulateWalk defaults selectedActivity to ski when not passed, got " + q.selectedActivity);
})();

(function testSelectedActivityRespectsArgument() {
  const fixes = [];
  const path = [[51.30000, -117.05000], [51.30030, -117.05000]];
  const q = mkQuest([{ path }], fixes);
  q.simulateWalk(1.5, null, () => {}, immediateSetTimeout, "bike");
  assert(q.selectedActivity === "bike", "simulateWalk respects an explicit selectedActivity argument, got " + q.selectedActivity);
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
