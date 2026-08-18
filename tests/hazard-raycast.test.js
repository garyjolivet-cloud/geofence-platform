// Unit tests for Phase 5a's forward hazard raycasting (2026-08-17): the
// visitor's current heading is projected HAZARD_LOOKAHEAD_M ahead via
// Geo.destPoint(), then that projected segment is tested against a hazard
// cylinder with the same Geo.segCylinderCross() the fast-mover rescue
// already uses (see tests/cylinder-segment-cross.test.js). This file only
// covers the new destPoint() math and the composed "does a forward ray
// toward/away from a known hazard cross it" scenario — segCylinderCross's
// own geometry edge cases are already covered there.
//
// Extracts Geo.destPoint and Geo.segCylinderCross straight out of the real
// shipped file (geofence-engine.html) via vm, same technique as
// cylinder-segment-cross.test.js, so this tests the actual code that
// ships, not a reimplementation. checkHazardAhead() itself (the cooldown/
// BUNDLE-iteration wrapper) isn't extracted — it needs a real DOM
// (document.getElementById for the banner, Audio.say) — same reasoning
// gpsfilter-trigger-comparison.test.js documents for why it reimplements
// state-machine slices locally instead of extracting DOM-coupled code.
//
// Run: `node --test tests/hazard-raycast.test.js` (or as part of the full
// `node --test tests/` suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

// ---- extract Geo.destPoint and Geo.segCylinderCross from the real shipped file ----
const html = fs.readFileSync(path.join(__dirname, "../frontend/geofence-engine.html"), "utf8");

function extractMethod(name, signature) {
  const re = new RegExp(signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{[\\s\\S]*?\\n  \\}");
  const m = html.match(re);
  if (!m) { console.log("FAIL: could not extract Geo." + name + " from geofence-engine.html"); process.exit(1); }
  return m[0].slice(m[0].indexOf("{") + 1, -1);
}
const Geo = {
  R: 6371000,
  mPerDegLat: 111320,
  mPerDegLon(lat) { return 111320 * Math.cos(lat * Math.PI / 180); },
  toXY(p, ref) { return { x: (p[1] - ref[1]) * this.mPerDegLon(ref[0]), y: (p[0] - ref[0]) * this.mPerDegLat }; },
};
// eslint-disable-next-line no-eval
eval("Geo.destPoint = function(p, distM, bearingDeg){" + extractMethod("destPoint", "destPoint(p, distM, bearingDeg)") + "}");
// eslint-disable-next-line no-eval
eval("Geo.segCylinderCross = function(prevLL, curLL, prevAlt, curAlt, center, R, bottom, top){" +
  extractMethod("segCylinderCross", "segCylinderCross(prevLL, curLL, prevAlt, curAlt, center, R, bottom, top)") + "}");

const center = [51.30, -117.05];
const eastDeg = (m2) => m2 / Geo.mPerDegLon(51.30);

// ---- Geo.destPoint ----

(function testDestPointDueEast() {
  const p = Geo.destPoint(center, 100, 90);
  const distBack = Geo.mPerDegLon(51.30) * (p[1] - center[1]);
  assert(Math.abs(distBack - 100) < 0.5, "due-east projection lands ~100m east (got " + distBack.toFixed(2) + "m)");
  assert(Math.abs(p[0] - center[0]) < 1e-6, "due-east projection doesn't drift in latitude (got dLat=" + (p[0] - center[0]) + ")");
})();

(function testDestPointIsInverseOfBearing() {
  // round-trip: project out, then the bearing from center to the
  // projected point should match the bearing we projected along.
  for (const b of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const p = Geo.destPoint(center, 200, b);
    const y = Math.sin((p[1] - center[1]) * Math.PI / 180) * Math.cos(p[0] * Math.PI / 180);
    const x = Math.cos(center[0] * Math.PI / 180) * Math.sin(p[0] * Math.PI / 180) -
      Math.sin(center[0] * Math.PI / 180) * Math.cos(p[0] * Math.PI / 180) * Math.cos((p[1] - center[1]) * Math.PI / 180);
    const backBearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    assert(Math.abs(((backBearing - b + 540) % 360) - 180) < 0.1,
      "bearing " + b + "°: destPoint's own inverse bearing matches within tolerance (got " + backBearing.toFixed(2) + ")");
  }
})();

// ---- composed forward-ray scenario (destPoint + segCylinderCross) ----

(function testForwardRayTowardHazardCrosses() {
  // visitor 80m west of a 20m-radius, altM=100±10 hazard cylinder, heading
  // due east (90°) with a 20m lookahead — same shape checkHazardAhead()
  // itself builds each tick.
  // 20m lookahead from 80m away wouldn't reach the cylinder — visitor needs
  // to be close enough that the projected ray actually clips it.
  const closeVisitor = [51.30, -117.05 - eastDeg(15)];
  const closeProj = Geo.destPoint(closeVisitor, 20, 90);
  const cross = Geo.segCylinderCross([closeVisitor[0], closeVisitor[1]], closeProj, 100, 100, center, 20, 90, 110);
  assert(cross.crossed, "forward ray from 15m out, heading straight at a 20m-radius hazard, 20m lookahead: crosses");
})();

(function testForwardRayAwayFromHazardDoesNotCross() {
  // visitor already outside the 20m-radius cylinder (25m out), heading
  // further away (270°/west) — must stay outside the whole projected
  // segment. (A visitor placed *inside* the radius and moving away would
  // legitimately report crossed==true, since the segment still exits
  // through the boundary — that's not this scenario.)
  const visitor = [51.30, -117.05 - eastDeg(25)];
  const proj = Geo.destPoint(visitor, 20, 270);
  const cross = Geo.segCylinderCross(visitor, proj, 100, 100, center, 20, 90, 110);
  assert(!cross.crossed, "forward ray heading away from the hazard: does not cross");
})();

(function testForwardRayFromInsideHazardHasZeroTEnter() {
  // checkHazardAhead() (frontend/geofence-engine.html etc.) additionally
  // requires cross.tEnter>0 before warning, specifically to suppress this
  // case: a visitor already standing inside the hazard cylinder projects a
  // ray that starts inside, which segCylinderCross correctly reports as
  // "crossed" (the segment does intersect the volume) but with tEnter==0 —
  // without the extra gate this would fire "hazard ahead" even while the
  // visitor is walking OUT of the hazard.
  const insideVisitor = [51.30, -117.05 - eastDeg(5)]; // 5m from center, inside the 20m radius
  const proj = Geo.destPoint(insideVisitor, 20, 270); // heading away, out through the boundary
  const cross = Geo.segCylinderCross(insideVisitor, proj, 100, 100, center, 20, 90, 110);
  assert(cross.crossed, "ray starting inside the hazard: segCylinderCross still reports crossed (it's the wrapper's job to filter this)");
  assert(cross.tEnter === 0, "ray starting inside the hazard: tEnter is exactly 0, which checkHazardAhead()'s tEnter>0 gate excludes (got " + cross.tEnter + ")");
})();

(function testForwardRayTooFarAwayDoesNotReach() {
  // visitor 200m out, only a 20m lookahead — same distance/heading as the
  // "crosses" case above but too far to reach the cylinder within the ray.
  const visitor = [51.30, -117.05 - eastDeg(200)];
  const proj = Geo.destPoint(visitor, 20, 90);
  const cross = Geo.segCylinderCross(visitor, proj, 100, 100, center, 20, 90, 110);
  assert(!cross.crossed, "forward ray heading at the hazard but lookahead too short to reach it: does not cross");
})();

(function testForwardRayWrongAltitudeBandDoesNotCross() {
  const visitor = [51.30, -117.05 - eastDeg(15)];
  const proj = Geo.destPoint(visitor, 20, 90);
  // visitor's own altitude (200) is nowhere near the hazard's 90-110 band —
  // checkHazardAhead() passes the visitor's own alt for both ends of the
  // projected segment (a flat forward step, not a climb).
  const cross = Geo.segCylinderCross(visitor, proj, 200, 200, center, 20, 90, 110);
  assert(!cross.crossed, "forward ray horizontally on-target but visitor's altitude outside the hazard's vertical band: does not cross");
})();

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
