// Unit tests for Phase 5b's AR-view occlusion (2026-08-18): does a straight
// line from the visitor (local origin) to a placed AR object pass through a
// hazard cylinder? Same closed-form segment-vs-cylinder combination as
// Geo.segCylinderCross (see tests/cylinder-segment-cross.test.js) and
// Phase 5a's forward hazard ray (tests/hazard-raycast.test.js), just run in
// ar-view.js's own local XYZ (already visitor-relative, via placeMesh())
// instead of lat/lon — no THREE.Raycaster, every occluder is a known
// analytic cylinder.
//
// Extracts segCylinderOcclude straight out of the real shipped file
// (frontend/ar-view.js) via vm, same technique as the other two Geo-math
// test files, so this tests the actual code that ships, not a
// reimplementation.
//
// Coordinates throughout: local XYZ, visitor always at origin (0,0,0),
// +Y up, -Z north (matching ar-view.js's own placeMesh() convention).
// Altitude bands are already visitor-relative (bottom/top would have had
// visitorAltM subtracted by onFix() before reaching this function for
// real) — small numbers like ±10 are realistic, not the raw absolute
// altitudes (~1270m) a real hazard zone's altM would carry.
//
// Run: `node --test tests/ar-occlusion.test.js` (or as part of the full
// `node --test tests/*.test.js` suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

// ---- extract segCylinderOcclude from the real shipped file ----
// Strict mode ("use strict" above) scopes a bare top-level `var` declared
// inside eval() locally, discarding it — same reasoning cylinder-segment-
// cross.test.js/hazard-raycast.test.js avoid by assigning onto an existing
// object's property instead (mutating a reachable object works fine in
// strict-mode eval; declaring a new binding doesn't).
const js = fs.readFileSync(path.join(__dirname, "../frontend/ar-view.js"), "utf8");
const m = js.match(/function segCylinderOcclude\(P1, cylCenterXZ, R, bottom, top\)\{[\s\S]*?\n\}/);
if (!m) { console.log("FAIL: could not extract segCylinderOcclude from frontend/ar-view.js"); process.exit(1); }
const M = {};
// eslint-disable-next-line no-eval
eval("M.segCylinderOcclude = function(P1, cylCenterXZ, R, bottom, top){" +
  m[0].slice(m[0].indexOf("{") + 1, -1) + "}");
const segCylinderOcclude = M.segCylinderOcclude;

// A hazard cylinder 30m ahead of the visitor, 20m radius.
const cylCenter = { x: 0, z: -30 };
const R = 20;

(function testClearLineNotOccluded() {
  // Object 100m off to the side — the line from the visitor to it never
  // gets anywhere near the cylinder.
  const obj = { x: 100, y: 0, z: -30 };
  assert(!segCylinderOcclude(obj, cylCenter, R, -10, 10), "object with a clear line of sight (off to the side): not occluded");
})();

(function testGenuineObstructionOccludes() {
  // Object straight past the cylinder (z=-80, further than the cylinder's
  // own center at z=-30), same altitude as the visitor — the line from
  // the visitor must pass through the cylinder to reach it.
  const obj = { x: 0, y: 0, z: -80 };
  assert(segCylinderOcclude(obj, cylCenter, R, -10, 10), "object directly behind a hazard cylinder from the visitor's position: occluded");
})();

(function testVisitorInsideHazardFailsOpen() {
  // Cylinder centered ON the visitor's own position — the segment starts
  // inside it (tEnter<=0). Must not occlude: a visitor standing inside a
  // hazard still sees their own object.
  const insideCenter = { x: 0, z: 0 };
  const obj = { x: 5, y: 0, z: -5 };
  assert(!segCylinderOcclude(obj, insideCenter, R, -10, 10), "visitor standing inside the hazard cylinder: fails open (visible)");
})();

(function testObjectInsideHazardFailsOpen() {
  // Object placed exactly at the cylinder's own center (tExit>=1, segment
  // ends inside it) — an object inside a hazard's own volume isn't hidden
  // by it.
  const obj = { x: 0, y: 0, z: -30 };
  assert(!segCylinderOcclude(obj, cylCenter, R, -10, 10), "object placed inside the hazard cylinder's own volume: fails open (visible)");
})();

(function testOutsideAltitudeBandNotOccluded() {
  // Same horizontal alignment as the genuine-obstruction case above, but
  // the hazard's vertical band (50-70) is well above where the visitor
  // and object both are (0) — never overlaps vertically, so horizontal
  // alignment alone doesn't matter.
  const obj = { x: 0, y: 0, z: -80 };
  assert(!segCylinderOcclude(obj, cylCenter, R, 50, 70), "horizontally aligned but altitude band never overlaps: not occluded");
})();

(function testWindowsDoNotOverlapInTime() {
  // The radius-inside window (~t=0.038-0.192, close to the visitor) and
  // the altitude-inside window (~t=0-0.01, an object climbing steeply to
  // y=1000 only stays within the ±10 band for the very first sliver of
  // the segment) don't overlap — mirrors cylinder-segment-cross.test.js's
  // own equivalent case for segCylinderCross.
  const obj = { x: 0, y: 1000, z: -260 };
  assert(!segCylinderOcclude(obj, cylCenter, R, -10, 10), "radius-inside window and altitude-inside window don't overlap in time: not occluded");
})();

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
