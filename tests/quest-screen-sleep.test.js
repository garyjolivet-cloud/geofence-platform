// Unit tests for Ridge Quest's battery "screen sleep" logic (frontend/ridge-quest.html):
//   - stationaryStep: when has the player actually stopped moving? (accuracy-aware,
//     since indoor GPS wanders)
//   - sleepDecision: awake / dim (black overlay) / dim-release (also let the phone
//     lock), given lift mode, time stationary, and time since the last touch
//
// Both are pure and extracted straight out of the shipped file (same technique as
// quest-completion-pct.test.js), so this tests the code that ships. The overlay's
// DOM wiring (ScreenSleep) is checked by hand in a browser.
//
// Run: `node --test tests/quest-screen-sleep.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");

const tuningM = html.match(/const SLEEP_TUNING = \{[\s\S]*?\n\};/);
if (!tuningM) { console.log("FAIL: could not extract SLEEP_TUNING from ridge-quest.html"); process.exit(1); }
const SLEEP_TUNING = eval("(" + tuningM[0].replace(/^const SLEEP_TUNING = /, "").replace(/;$/, "") + ")");

function extractFunctionBody(startTag) {
  const startIdx = html.indexOf(startTag);
  if (startIdx < 0) { console.log("FAIL: could not find " + startTag); process.exit(1); }
  let depth = 0, i = html.indexOf("{", startIdx);
  const bodyStart = i + 1;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(bodyStart, i);
}
// eslint-disable-next-line no-new-func
const stationaryStep = new Function("anchor", "fix", "distFn", "SLEEP_TUNING",
  extractFunctionBody("function stationaryStep(anchor, fix, distFn){"));
// eslint-disable-next-line no-new-func
const sleepDecisionRaw = new Function("s", "SLEEP_TUNING",
  extractFunctionBody("function sleepDecision(s){"));
const sleepDecision = s => sleepDecisionRaw(s, SLEEP_TUNING);
const step = (anchor, fix) => stationaryStep(anchor, fix, (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]), SLEEP_TUNING);

const S = 1000, MIN = 60 * S;
const NOW = 10 * 60 * MIN;
// Idle/stationary durations, in ms, relative to NOW.
const st = o => Object.assign({ now: NOW, lastTouchAt: NOW - 5 * S, liftModeActive: false, saverOff: false, stationaryForMs: 0 }, o);

// ---- stationaryStep ----

(function testFirstFixBecomesAnchor() {
  const a = step(null, { lat: 0, lon: 0, acc: 10, at: 111 });
  assert(a && a.at === 111, "the first fix starts the stationary clock, got " + JSON.stringify(a));
})();

(function testSmallDriftKeepsAnchor() {
  const a0 = { lat: 0, lon: 0, at: 100 };
  const a1 = step(a0, { lat: 10, lon: 5, acc: 8, at: 999 });
  assert(a1 === a0, "drift inside the radius keeps the original anchor (and its start time), got " + JSON.stringify(a1));
})();

(function testRealMoveResetsAnchor() {
  const a0 = { lat: 0, lon: 0, at: 100 };
  const a1 = step(a0, { lat: 100, lon: 0, acc: 8, at: 999 });
  assert(a1 !== a0 && a1.at === 999, "moving past the radius restarts the stationary clock, got " + JSON.stringify(a1));
})();

(function testPoorAccuracyWidensTheRadius() {
  // 50 m of indoor GPS wander with an 80 m accuracy circle is noise, not a walk.
  const a0 = { lat: 0, lon: 0, at: 100 };
  const a1 = step(a0, { lat: 50, lon: 0, acc: 80, at: 999 });
  assert(a1 === a0, "wander smaller than the fix's own accuracy does not reset the anchor, got " + JSON.stringify(a1));
})();

// ---- sleepDecision ----

(function testJustTouchedIsAwakeEvenOnALift() {
  assert(sleepDecision(st({ liftModeActive: true, lastTouchAt: NOW - 10 * S })) === "awake", "a touch 10 s ago keeps the screen awake on a lift");
})();

(function testLiftDimsAfterIdle() {
  assert(sleepDecision(st({ liftModeActive: true, lastTouchAt: NOW - 30 * S })) === "dim", "lift + 30 s idle dims");
})();

(function testLiftNeverReleasesTheWakeLock() {
  // A locked phone suspends JS on iOS: it would miss the dismount and the first run.
  const d = sleepDecision(st({ liftModeActive: true, lastTouchAt: NOW - 20 * MIN, stationaryForMs: 20 * MIN }));
  assert(d === "dim", "on a lift it only ever dims, even after 20 min idle and stationary, got " + d);
})();

(function testNotStationaryLongEnoughStaysAwake() {
  const d = sleepDecision(st({ lastTouchAt: NOW - 2 * MIN, stationaryForMs: 4 * MIN }));
  assert(d === "awake", "4 min stationary is not enough to dim, got " + d);
})();

(function testStationaryFiveMinutesDimsOnceIdle() {
  const d = sleepDecision(st({ lastTouchAt: NOW - 30 * S, stationaryForMs: 5 * MIN }));
  assert(d === "dim", "5 min stationary + 30 s idle dims, got " + d);
})();

(function testTouchOverridesStationaryDim() {
  const d = sleepDecision(st({ lastTouchAt: NOW - 10 * S, stationaryForMs: 30 * MIN }));
  assert(d === "awake", "a touch 10 s ago wakes the screen even after 30 min stationary, got " + d);
})();

(function testLunchReleasesTheWakeLock() {
  const d = sleepDecision(st({ lastTouchAt: NOW - 10 * MIN, stationaryForMs: 10 * MIN }));
  assert(d === "dim-release", "10 min stationary AND 10 min untouched releases the wake lock, got " + d);
})();

(function testARecentTouchDowngradesReleaseToDim() {
  // Touched 2 min ago: the lunch clock effectively restarts from that touch.
  const d = sleepDecision(st({ lastTouchAt: NOW - 2 * MIN, stationaryForMs: 25 * MIN }));
  assert(d === "dim", "stationary 25 min but touched 2 min ago dims without releasing, got " + d);
})();

(function testMovingIsAwake() {
  const d = sleepDecision(st({ lastTouchAt: NOW - 10 * MIN, stationaryForMs: 0 }));
  assert(d === "awake", "not on a lift and not stationary is awake however long since the last touch, got " + d);
})();

(function testBatterySaverAlwaysOffDisablesEverything() {
  const lift = sleepDecision(st({ saverOff: true, liftModeActive: true, lastTouchAt: NOW - 20 * MIN }));
  const lunch = sleepDecision(st({ saverOff: true, lastTouchAt: NOW - 20 * MIN, stationaryForMs: 20 * MIN }));
  assert(lift === "awake" && lunch === "awake", "Battery Saver 'Always Off' disables both stages, got " + lift + "/" + lunch);
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
