// Ridge Quest: tilting the PHONE tilts the MAP (2026-09-23).
//
// Field report: "tilt is not working when I tilt the phone. It only works when I touch
// with two fingers." It was never wired up — device-heading.js measured the phone's tilt
// but nothing on the map read it, and a code comment said pitch was "gesture-only".
// Now the map follows the phone: flat = top-down, raised toward the horizon = tilted view,
// capped at MapLibre's default maxPitch of 60.
//
// pitchForPhoneTilt is pure and extracted from the shipped file; the handler lives inside
// the map screen's closure, so its wiring is pinned with source-level checks.
//
// Run: `node --test tests/quest-tilt-pitch.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8").replace(/\r/g, "");
const dh = fs.readFileSync(path.join(__dirname, "../frontend/device-heading.js"), "utf8");

function extractBody(startTag) {
  const startIdx = html.indexOf(startTag);
  if (startIdx < 0) return "";
  let depth = 0, i = html.indexOf("{", startIdx);
  const bodyStart = i + 1;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(bodyStart, i);
}
const maxM = html.match(/const TILT_PITCH_MAX_DEG = (\d+);/);
const dbM = html.match(/const TILT_PITCH_DEADBAND_DEG = ([\d.]+);/);
assert(!!maxM && !!dbM, "found TILT_PITCH_MAX_DEG and TILT_PITCH_DEADBAND_DEG");
const MAX = maxM ? +maxM[1] : 60;
// eslint-disable-next-line no-new-func
const pitchForPhoneTilt = new Function("TILT_PITCH_MAX_DEG", "tiltDeg",
  extractBody("function pitchForPhoneTilt(tiltDeg){"));
const f = t => pitchForPhoneTilt(MAX, t);

// ---- the mapping ----
(function testFollowsThePhone() {
  assert(f(0) === 0, "phone flat (0 deg) => map straight down (0)");
  assert(f(30) === 30 && f(45) === 45, "a mid tilt maps 1:1 (30 -> 30, 45 -> 45)");
  assert(f(60) === 60, "60 deg => 60");
})();

(function testCappedAtMapMaxPitch() {
  assert(f(75) === 60 && f(90) === 60, "phone upright (75-90 deg) => capped at the map's max pitch of 60, never higher");
  assert(MAX === 60, "the cap is MapLibre's default maxPitch (60) — this map sets no other");
})();

(function testMonotonic() {
  let prev = -1, ok = true;
  for (let t = 0; t <= 90; t += 5) { const p = f(t); if (p < prev) ok = false; prev = p; }
  assert(ok, "more phone tilt never gives LESS map tilt");
})();

(function testBadInputMeansNoOpinion() {
  // null => the caller leaves pitch alone (two-finger gesture only, as before).
  [null, undefined, NaN, Infinity, "45", {}, []].forEach(v =>
    assert(f(v) === null, "tilt " + String(v) + " => null (leave the pitch to the gesture)"));
  assert(f(-5) === 0, "a slightly negative reading clamps to 0 rather than a negative pitch");
})();

(function testDeadbandIsSmallButReal() {
  const db = dbM ? +dbM[1] : 0;
  assert(db >= 1 && db <= 3, "the deadband (" + db + " deg) is big enough to ignore hand tremor but small enough to feel immediate");
})();

// ---- wiring (source-level: the handler is inside renderFogMap's closure) ----
(function testHandlerAppliesBearingAndPitchTogether() {
  const h = html.match(/DeviceHeading\.onChange\(\(h, tilt\)=>\{[\s\S]*?\n    \}\);/);
  assert(!!h, "the orientation handler receives the tilt as its 2nd argument");
  const body = h ? h[0] : "";
  assert(/if\(autoOrient\)/.test(body), "phone-tilt only applies while nobody is touching the map (a finger still wins)");
  assert(/pitchForPhoneTilt\(tilt\)/.test(body) && /cam\.pitch = tp/.test(body), "the phone's tilt becomes the map pitch");
  assert(/TILT_PITCH_DEADBAND_DEG/.test(body) && /map\.getPitch\(\)/.test(body), "pitch only changes past the deadband (no re-render for hand tremor)");
  assert(/map\.jumpTo\(cam\)/.test(body) && !/map\.setBearing/.test(body), "bearing and pitch go in ONE camera update (one redraw, not two)");
})();

// ---- behaviour: run the REAL handler against a fake map and fake sensor readings ----
(function testHandlerBehaviour() {
  const m = html.match(/DeviceHeading\.onChange\((\(h, tilt\)=>\{[\s\S]*?\n    \})\);/);
  if (!m) { assert(false, "could not extract the orientation handler"); return; }
  const make = (autoOrient, currentPitch) => {
    const calls = [], headings = [];
    const map = { getPitch: () => currentPitch, jumpTo: c => calls.push(c) };
    const here = { setHeading: h => headings.push(h) };
    // eslint-disable-next-line no-new-func
    const handler = new Function("autoOrient", "map", "here", "wedgeHeadingFor", "pitchForPhoneTilt", "TILT_PITCH_DEADBAND_DEG",
      "return " + m[1])(autoOrient, map, here, h => h, t => pitchForPhoneTilt(MAX, t), dbM ? +dbM[1] : 1.5);
    return { handler, calls, headings };
  };

  let r = make(true, 0); r.handler(120, 40);
  assert(r.calls.length === 1 && r.calls[0].bearing === 120 && r.calls[0].pitch === 40,
    "tilt the phone to 40 deg with the map flat => ONE camera update: bearing 120 AND pitch 40, got " + JSON.stringify(r.calls));

  r = make(true, 40); r.handler(120, 40.8);
  assert(r.calls.length === 1 && r.calls[0].bearing === 120 && !("pitch" in r.calls[0]),
    "a sub-deadband wobble (40 -> 40.8) still turns the map but does not touch pitch, got " + JSON.stringify(r.calls));

  r = make(true, 0); r.handler(200, 85);
  assert(r.calls[0].pitch === 60, "phone nearly upright (85 deg) => pitch capped at 60, got " + r.calls[0].pitch);

  r = make(true, 30); r.handler(50, null);
  assert(r.calls.length === 1 && r.calls[0].bearing === 50 && !("pitch" in r.calls[0]),
    "no tilt reading (no permission) => bearing only, pitch left to the gesture, got " + JSON.stringify(r.calls));

  r = make(true, 0); r.handler(null, 35);
  assert(r.calls.length === 1 && r.calls[0].pitch === 35 && !("bearing" in r.calls[0]),
    "no compass but a tilt reading => pitch only, got " + JSON.stringify(r.calls));

  r = make(true, 0); r.handler(null, null);
  assert(r.calls.length === 0, "nothing usable => no camera update at all");

  r = make(false, 0); r.handler(120, 40);
  assert(r.calls.length === 0, "a finger is on the map (autoOrient off) => the phone must NOT move the camera");
  assert(r.headings.length === 1, "...but the avatar's heading wedge still updates");
})();

(function testResumeAfterFingersLiftIncludesPitch() {
  const r = html.match(/function scheduleOrientResume\(\)\{[\s\S]*?\n    \}/);
  assert(!!r && /pitchForPhoneTilt\(DeviceHeading\.tilt\)/.test(r[0]) && /pitch:tp/.test(r[0]),
    "2.5 s after the fingers lift, the map eases back to the phone's tilt as well as its heading");
})();

(function testOldGestureOnlyClaimIsGone() {
  assert(!/pitch\s+itself\s+is\s+gesture-only/.test(html), "the comment claiming pitch is gesture-only is gone");
  assert(!/it only ever calls setBearing/.test(html), "the comment claiming auto-orient only ever calls setBearing is gone");
})();

(function testDeviceHeadingStillSuppliesTilt() {
  assert(/API\.tilt\s*=\s*smoothTilt/.test(dh) && /subs\[i\]\(smooth, smoothTilt\)/.test(dh),
    "device-heading.js still publishes the smoothed tilt as onChange's 2nd argument");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
