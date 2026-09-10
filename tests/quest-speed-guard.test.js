// Source-shape checks that frontend/ridge-quest.html is correctly wired to
// the shared SpeedGuard module (frontend/speed-guard.js). The guard's
// behaviour is tested in tests/speed-guard.test.js; this only guards the
// integration in ridge-quest.html (the inline copy was extracted).
//
// Run: `node tests/quest-speed-guard.test.js`
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");

function extractMethodBody(startTag) {
  const startIdx = html.indexOf(startTag);
  if (startIdx < 0) throw new Error("could not find " + startTag);
  let depth = 0, i = html.indexOf("{", startIdx);
  const bodyStart = i + 1;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(bodyStart, i);
}

(function testLoadsSharedModule() {
  assert(/<script src="\/speed-guard\.js"><\/script>/.test(html), "ridge-quest.html loads /speed-guard.js");
})();

(function testInlineCopyRemoved() {
  assert(!/const SpeedGuard = \{/.test(html), "the inline `const SpeedGuard = {` object literal is gone (now the shared module)");
  assert(!/#rqEyesUp\{/.test(html), "the inline #rqEyesUp CSS is gone (overlay CSS ships in the module)");
})();

(function testConfiguredAndExempted() {
  assert(/SpeedGuard\.configure\(\{/.test(html), "ridge-quest configures the guard");
  assert(/onNotice:\s*rqToast/.test(html), "the one-time notice routes through rqToast");
  assert(/suppressed:\s*IS_SIM_MODE/.test(html), "the guard is suppressed under IS_SIM_MODE");
  assert(/SpeedGuard\.setExemptFn\(/.test(html), "ridge-quest injects a lift-exemption predicate");
  assert(/QGeo\.corridorDist\([\s\S]{0,120}runType\s*!==\s*"lift"|runType\s*!==\s*"lift"[\s\S]{0,160}QGeo\.corridorDist/.test(html.replace(/\s+/g, " ")),
    "the exemption predicate tests runType:'lift' corridors via QGeo.corridorDist");
})();

(function testOnFixCallsGuardBeforeOffsite() {
  const body = extractMethodBody("_onFix(pos){");
  const iGuard = body.indexOf("SpeedGuard.consider");
  const iOff = body.search(/if\s*\(\s*Quest\._offsite\s*\)/);
  assert(iGuard > -1, "_onFix calls SpeedGuard.consider");
  assert(iOff > -1 && iGuard < iOff, "_onFix calls SpeedGuard.consider BEFORE the if(Quest._offsite) early return");
})();

(function testStartStopHooks() {
  assert(/SpeedGuard\.noteStarted\(\)/.test(html), "Quest.start() calls SpeedGuard.noteStarted()");
  const stop = extractMethodBody("stop(){");
  assert(/SpeedGuard\.reset\(\)/.test(stop), "Quest.stop() calls SpeedGuard.reset()");
})();

(function testRenderFogMapOwnWatchIntact() {
  const body = extractMethodBody("function renderFogMap(){");
  assert(/navigator\.geolocation\.watchPosition/.test(body), "renderFogMap still starts its own watchPosition when untracked");
  assert(/SpeedGuard\.consider/.test(body), "that watch feeds SpeedGuard.consider");
  assert(/!Quest\.active\(\)/.test(body), "the map-only watch is guarded on !Quest.active()");
  assert(/clearWatch\(guardWatchId\)/.test(body) && /SpeedGuard\.reset\(\)/.test(body),
    "the #fogBack teardown clears guardWatchId and calls SpeedGuard.reset()");
})();

(function testTuningKeysStillPresent() {
  const m = html.match(/const QUEST_TUNING = \{[\s\S]*?\n\};/);
  assert(!!m, "QUEST_TUNING extractable");
  for (const k of ["SPEED_GUARD_ENABLED", "SPEED_GUARD_BLOCK_MPS", "SPEED_GUARD_CLEAR_MPS",
    "SPEED_GUARD_CLEAR_DWELL_MS", "SPEED_GUARD_MAX_FIX_GAP_MS", "SPEED_GUARD_LIFT_MIN_MPS"]) {
    assert(m[0].indexOf(k) > -1, "QUEST_TUNING keeps " + k + " (tunable surface, passed to configure)");
  }
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
