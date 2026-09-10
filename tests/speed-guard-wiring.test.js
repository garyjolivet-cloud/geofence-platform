// Source-shape checks that geofence-engine.html (/walk, /engine) and
// field-recorder.html (/field) are wired to the shared SpeedGuard module
// (frontend/speed-guard.js). Behaviour is covered by tests/speed-guard.test.js.
//
// Run: `node tests/speed-guard-wiring.test.js`
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

function read(f) { return fs.readFileSync(path.join(__dirname, "../frontend/", f), "utf8"); }
function extractBody(src, startTag) {
  const s = src.indexOf(startTag);
  if (s < 0) throw new Error("could not find " + startTag);
  let depth = 0, i = src.indexOf("{", s);
  const bodyStart = i + 1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(bodyStart, i);
}

/* ---- geofence-engine.html ---- */
(function engine() {
  const h = read("geofence-engine.html");
  assert(/<script src="\/speed-guard\.js"><\/script>/.test(h), "geofence-engine loads /speed-guard.js");

  const onFix = extractBody(h, "onFix(fix){");
  const iGuard = onFix.indexOf("SpeedGuard.consider");
  const iOff = onFix.search(/if\s*\(\s*HUD\.offsite\s*\)/);
  assert(iGuard > -1, "HUD.onFix calls SpeedGuard.consider");
  assert(iOff > -1 && iGuard < iOff, "HUD.onFix calls SpeedGuard.consider BEFORE the if(HUD.offsite) early return");
  assert(/SpeedGuard\.consider\(sm\)/.test(onFix), "it passes the smoothed fix `sm` (has speed/t/lat/lon)");

  const startGPS = extractBody(h, "function startGPS(){");
  assert(/SpeedGuard\.noteStarted\(\)/.test(startGPS), "startGPS() fires the one-time notice");

  const toggleSim = extractBody(h, "function toggleSim(){");
  assert(/SpeedGuard\.configure\(\{\s*suppressed:\s*simMode\s*\}\)/.test(toggleSim.replace(/\s+/g, " ").replace(/\{ /g, "{").replace(/ \}/g, "}"))
    || /SpeedGuard\.configure\(\{suppressed:simMode\}\)/.test(toggleSim.replace(/\s+/g, "")),
    "toggleSim() suppresses the guard in sim mode");
  assert(/SpeedGuard\.reset\(\)/.test(toggleSim), "toggleSim() resets the guard on every toggle");
})();

/* ---- field-recorder.html ---- */
(function fieldRecorder() {
  const h = read("field-recorder.html");
  assert(/<script src="\/speed-guard\.js"><\/script>/.test(h), "field-recorder loads /speed-guard.js");

  // The watchPosition success arrow body: check the consider() call sits with
  // the lastSmoothed assignment and before checkProximityAudio.
  const iSmoothed = h.indexOf("lastSmoothed = (typeof GPSFilter");
  const iConsider = h.indexOf("SpeedGuard.consider(lastSmoothed)");
  const iProx = h.indexOf("checkProximityAudio(lastSmoothed.lat");
  assert(iConsider > -1, "the watchPosition callback calls SpeedGuard.consider(lastSmoothed)");
  assert(iSmoothed > -1 && iConsider > iSmoothed && iConsider < iProx,
    "SpeedGuard.consider runs after lastSmoothed is produced and within the fix callback");

  assert(/SpeedGuard\.noteStarted\(\)/.test(h), "field-recorder fires the one-time notice at start");
  assert(/pagehide[\s\S]{0,160}SpeedGuard\.reset\(\)/.test(h), "the pagehide handler resets the guard");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
