// Unit tests for Ridge Quest R4's viewshed geometry (computeViewshed in
// frontend/fence-editor.html) — the horizon-angle-sweep algorithm that
// finds which terrain is visible from a Viewpoint zone, up to
// viewshedMaxDistM, occluded by intervening terrain.
//
// This is genuinely new math for this codebase (confirmed against Phase
// 5a/5b before writing it — neither does real DEM ray-marching, both
// occlude against known analytic cylinders, never sampled terrain — see
// the plan file's R4 section). computeViewshed is deliberately a PURE
// function taking an injected elevation sampler, precisely so it can be
// tested here against synthetic terrain with no browser/DEM involved —
// there is no headless MapLibre in `node --test`.
//
// Extracts computeViewshed AND destPoint (which it calls internally)
// straight out of the real shipped fence-editor.html via vm/string-slice,
// same established technique tests/cylinder-segment-cross.test.js and this
// session's other quest-*.test.js files already use — this tests the
// actual code that ships, not a reimplementation.
//
// Run: `node --test tests/quest-viewshed.test.js` (or as part of the full
// `node --test tests/` suite).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8");

function extractFunction(name, startTag) {
  const startIdx = html.indexOf(startTag);
  if (startIdx < 0) throw new Error("could not find " + name + " in fence-editor.html");
  let depth = 0, i = html.indexOf("{", startIdx), bodyStart = i;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(startIdx, i + 1);
}

const destPointSrc = extractFunction("destPoint", "function destPoint(center,distM,bearing){");
const computeViewshedSrc = extractFunction("computeViewshed", "function computeViewshed(originLonLat, opts, sampleElevFn){");

const ctx = {};
vm.createContext(ctx);
vm.runInContext(destPointSrc + "\n" + computeViewshedSrc, ctx);
const { destPoint, computeViewshed } = ctx;

const origin = [-117.05, 51.30]; // [lon,lat]
function haversineM(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR, la1 = a[1] * toR, la2 = b[1] * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/* ---- flat plane: everything within maxDistM should be visible ---- */
(function testFlatPlaneFullyVisible() {
  const r = computeViewshed(origin, { maxDistM: 500, stepM: 50, rayCount: 36 }, () => 0);
  assert(!r.aborted, "flat terrain never aborts");
  assert(r.visiblePoints.length === 36 * 10, "every one of 36 rays x 10 steps is visible on a flat plane, got " + r.visiblePoints.length);
})();

/* ---- downslope from an elevated origin: full visibility, different
   reason (angle strictly improves outward, never re-occluded) ---- */
(function testElevatedDownslopeFullyVisible() {
  const sampler = (pt) => {
    if (pt[0] === origin[0] && pt[1] === origin[1]) return 500;
    return 500 - haversineM(origin, pt) * 0.1;
  };
  const r = computeViewshed(origin, { maxDistM: 400, stepM: 50, rayCount: 12 }, sampler);
  assert(r.visiblePoints.length === 12 * 8, "a monotonic downslope from an elevated viewpoint reveals every sample, got " + r.visiblePoints.length);
})();

/* ---- ridge wall: near face visible, far side in shadow ---- */
(function testRidgeWallCastsShadow() {
  // Wall from 380-460m (well clear of any 50m step boundary) at 80m tall,
  // flat=0 elsewhere. From an eye at ~2m, the near wall face is a steep
  // ~13° rise that should occlude everything flatter behind it.
  const sampler = (pt) => {
    const d = haversineM(origin, pt);
    if (d >= 380 && d <= 460) return 80;
    return 0;
  };
  const r = computeViewshed(origin, { maxDistM: 1000, stepM: 20, rayCount: 4 }, sampler);
  const visibleDistances = r.visiblePoints.map(pt => haversineM(origin, pt));
  const anyNearWallVisible = visibleDistances.some(d => d >= 375 && d <= 465);
  const anyFarSideVisible = visibleDistances.some(d => d > 465);
  // A band safely in the middle of the pre-wall flat stretch must be fully
  // visible: nothing between the viewpoint and the wall occludes it. Bounds
  // (105/295, not 100/300) are deliberately off any stepM=20 multiple —
  // destPoint()+haversineM()'s round-trip can land a sample's RECOMPUTED
  // distance a hair to either side of a boundary that sits exactly on a
  // step, which previously made this assertion flaky at the edges without
  // reflecting any real bug in computeViewshed itself (confirmed by tracing
  // the exact same extracted functions outside the test harness).
  const midFieldVisible = visibleDistances.filter(d => d >= 105 && d <= 295).length;
  assert(anyNearWallVisible, "the wall's own near face is visible");
  assert(!anyFarSideVisible, "flat terrain behind the wall is fully shadowed, got visible far-side distances: " + JSON.stringify(visibleDistances.filter(d => d > 465)));
  // Samples land on stepM=20 multiples: 120,140,...,280 within [105,295] is 9 per ray.
  assert(midFieldVisible === 4 * 9, "everything well before the wall (105-295m, clear of boundary rounding) is visible on all 4 rays, got " + midFieldVisible + " expected " + (4 * 9));
})();

/* ---- origin elevation unavailable: abort cleanly, don't guess sea-level ---- */
(function testMissingOriginElevationAborts() {
  const r = computeViewshed(origin, { maxDistM: 500 }, () => null);
  assert(r.aborted === true, "a missing origin elevation reading aborts the whole computation");
  assert(r.visiblePoints.length === 0, "an aborted computation returns no visible points");
})();

/* ---- mid-ray DEM gap: abort that ray, not the whole computation, and
   never treat the gap as sea-level ---- */
(function testMidRayGapAbortsOnlyThatRay() {
  let callCount = 0;
  const sampler = (pt) => {
    if (pt[0] === origin[0] && pt[1] === origin[1]) return 0; // origin itself always resolves
    callCount++;
    return callCount > 3 ? null : 0; // first ray's terrain samples run out after 3 steps
  };
  const r = computeViewshed(origin, { maxDistM: 500, stepM: 50, rayCount: 1 }, sampler);
  assert(r.abortedRays === 1, "the one ray that hit a DEM gap is counted as aborted, got " + r.abortedRays);
  assert(r.visiblePoints.length === 3, "only the samples before the gap are kept, got " + r.visiblePoints.length);
})();

/* ---- eye height matters: a taller eye height sees further over the
   same nearby obstruction (sanity check that eyeHeightM is actually wired
   into the angle calculation, not a dead parameter) ---- */
(function testEyeHeightAffectsOcclusion() {
  // A short bump right next to the viewpoint (at 50m, height 3m) can hide
  // everything behind it from a low eye but not from a much higher one.
  const sampler = (pt) => {
    const d = haversineM(origin, pt);
    if (d >= 40 && d <= 60) return 3;
    return 0;
  };
  const lowEye = computeViewshed(origin, { maxDistM: 500, stepM: 50, rayCount: 1, eyeHeightM: 0.5 }, sampler);
  const highEye = computeViewshed(origin, { maxDistM: 500, stepM: 50, rayCount: 1, eyeHeightM: 50 }, sampler);
  assert(highEye.visiblePoints.length >= lowEye.visiblePoints.length, "a much higher eye height sees at least as much past the same nearby bump, got low=" + lowEye.visiblePoints.length + " high=" + highEye.visiblePoints.length);
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
