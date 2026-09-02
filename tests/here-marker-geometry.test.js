// Unit test for the GPS-accuracy ring geometry in frontend/here-marker.js —
// the shared "you are here" avatar's accuracy circle is drawn as a real
// ground-circle polygon (haversineDest swept over 48 bearings), not a
// metre-scaled MapLibre circle-radius expression, so it stays a true circle
// at any zoom.
//
// Extracts haversineDest + accuracyRingPolygon straight out of the shipped
// module via vm/string-slice (same technique as tests/quest-viewshed.test.js)
// — tests the actual code that ships.
//
// Run: `node tests/here-marker-geometry.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const src = fs.readFileSync(path.join(__dirname, "../frontend/here-marker.js"), "utf8");

function extractFn(startTag) {
  const startIdx = src.indexOf(startTag);
  if (startIdx < 0) throw new Error("could not find " + startTag + " in here-marker.js");
  let depth = 0, i = src.indexOf("{", startIdx);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(startIdx, i + 1);
}

const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  "var R_EARTH = 6371000, D2R = Math.PI / 180;\n"
  + extractFn("function haversineDest(") + "\n"
  + extractFn("function accuracyRingPolygon("),
  ctx
);
const { haversineDest, accuracyRingPolygon } = ctx;

// haversine distance between two [lon,lat] points (independent reference impl)
function havM(a, b) {
  const R = 6371000, d2r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * d2r, dLon = (b[0] - a[0]) * d2r;
  const la1 = a[1] * d2r, la2 = b[1] * d2r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

const center = [-117.081, 51.275]; // Kicking Horse-ish, mid latitude

for (const r of [10, 75, 40]) {
  const f = accuracyRingPolygon(center[0], center[1], r);
  const ring = f.geometry.coordinates[0];

  assert(f.type === "Feature" && f.geometry.type === "Polygon",
    "r=" + r + ": returns a GeoJSON Polygon Feature");
  assert(ring.length === 49,
    "r=" + r + ": 48 segments = 49 vertices, got " + ring.length);
  assert(ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1],
    "r=" + r + ": ring is closed (first === last)");

  let maxErr = 0;
  for (const v of ring) maxErr = Math.max(maxErr, Math.abs(havM(center, v) - r));
  assert(maxErr < 0.5,
    "r=" + r + ": every vertex is r ± 0.5 m from centre, max error " + maxErr.toFixed(4) + " m");
}

// A degenerate 0 m radius still produces a valid closed ring collapsed on the point.
const z = accuracyRingPolygon(center[0], center[1], 0).geometry.coordinates[0];
assert(z.length === 49 && z.every(v => havM(center, v) < 0.01),
  "r=0: valid closed ring collapsed at the centre");

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
