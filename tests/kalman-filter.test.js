// Standalone Node test suite for frontend/kalman-filter.js (window.GPSFilter).
// This repo has no test runner/package.json — run directly: `node tests/kalman-filter.test.js`.
// Matches the ad-hoc-Node-script pattern already used this session for
// pipeline-runtime.js's logic.cooldown/stop-network work.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sandbox = { console, window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../frontend/kalman-filter.js"), "utf8"), sandbox);
const GPSFilter = sandbox.window.GPSFilter;
const { f, jacobianF } = GPSFilter._internal;

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log("FAIL:", msg); }
}
function approx(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, msg + " (got " + a + ", expected ~" + b + ", tol " + tol + ")");
}
// Compass bearings wrap at 360 -- 351deg and 0deg are 8.55deg apart, not
// 351deg apart. Naive subtraction breaks near that boundary; always use
// this for heading comparisons.
function approxHeading(a, b, tol, msg) {
  const diff = Math.abs(((a - b + 540) % 360) - 180);
  assert(diff <= tol, msg + " (got " + a + ", expected ~" + b + ", tol " + tol + "deg, circular diff " + diff.toFixed(1) + "deg)");
}

// ---------- geometry helpers for building synthetic fix sequences ----------
const R_LAT = 111320;
function destPoint(lat, lon, bearingDeg, distM) {
  const phi = lat * Math.PI / 180;
  const brg = bearingDeg * Math.PI / 180;
  const dLat = (distM * Math.cos(brg)) / R_LAT;
  const dLon = (distM * Math.sin(brg)) / (R_LAT * Math.cos(phi));
  return [lat + dLat, lon + dLon];
}
function haversineM(a, b) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const la1 = toRad(a[0]), la2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Deterministic pseudo-jitter, NOT Math.random() -- this is a permanent
// regression test (see kalman-filter.js's own comment pointing here), and a
// non-seeded random source would make it flaky/non-reproducible between
// runs. A few mixed sine frequencies gives a varying, non-repeating-looking
// but fully deterministic +/- pattern.
function jitter(i, magM) {
  return magM * (0.6 * Math.sin(i * 1.7 + 0.3) + 0.4 * Math.sin(i * 4.1 + 1.9));
}

function walkFixes(startLat, startLon, headingDeg, speedMps, seconds, accM, jitterM, startT) {
  const fixes = [];
  let lat = startLat, lon = startLon, t = startT || 1700000000000;
  for (let i = 0; i <= seconds; i++) {
    const jLat = lat + jitter(i, jitterM) / R_LAT;
    const jLon = lon + jitter(i + 100, jitterM) / (R_LAT * Math.cos(lat * Math.PI / 180));
    fixes.push({ lat: jLat, lon: jLon, acc: accM, t: t + i * 1000 });
    const next = destPoint(lat, lon, headingDeg, speedMps);
    lat = next[0]; lon = next[1];
  }
  return fixes;
}

// ============================================================
// (a) Jacobian correctness — permanent numerical-vs-analytical cross-check
// ============================================================
(function testJacobian() {
  function numericalF(X, dt, h) {
    h = h || 1e-6;
    const cols = [];
    const f0 = f(X, dt);
    for (let j = 0; j < 4; j++) {
      const Xp = X.slice(); Xp[j] += h;
      const f1 = f(Xp, dt);
      cols.push(f1.map((v, i) => (v - f0[i]) / h));
    }
    const FT = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) FT[i][j] = cols[j][i];
    return FT;
  }
  [0, 51.3, 70].forEach(lat => {
    const X = [lat, -117.0, 3.0, 1.5];
    const A = jacobianF(X, 1.0);
    const N = numericalF(X, 1.0);
    let maxDiff = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) maxDiff = Math.max(maxDiff, Math.abs(A[i][j] - N[i][j]));
    assert(maxDiff < 1e-6, "Jacobian matches finite-difference at lat=" + lat + " (max diff " + maxDiff.toExponential(3) + ")");
  });
})();

// ============================================================
// (b) Steady walking — convergence + noise reduction
// ============================================================
(function testSteadyWalk() {
  GPSFilter.reset();
  const trueLat = 51.3, trueLon = -117.0, heading = 90, speed = 1.4; // walking pace, due east
  const fixes = walkFixes(trueLat, trueLon, heading, speed, 30, 8, 4);
  let lastOut = null;
  const filteredDevs = [], rawDevs = [];
  let simLat = trueLat, simLon = trueLon;
  fixes.forEach((fix, i) => {
    lastOut = GPSFilter.push(fix);
    const truePt = destPoint(trueLat, trueLon, heading, speed * i);
    if (i > 5) { // give it a few fixes to converge before judging
      filteredDevs.push(haversineM([lastOut.lat, lastOut.lon], truePt));
      rawDevs.push(haversineM([fix.lat, fix.lon], truePt));
    }
  });
  const rms = arr => Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / arr.length);
  const filteredRMS = rms(filteredDevs), rawRMS = rms(rawDevs);
  assert(filteredRMS < rawRMS, "filtered RMS deviation (" + filteredRMS.toFixed(2) + "m) is below raw jitter RMS (" + rawRMS.toFixed(2) + "m)");
  approx(lastOut.speed, speed, 0.5, "speed converges to true walking speed");
  approxHeading(lastOut.headingTravel, heading, 15, "headingTravel converges to true bearing (due east = 90deg)");
})();

// ============================================================
// (c) Sudden real 90-degree turn — heading should track, not be NIS-rejected
// ============================================================
(function testTurn() {
  GPSFilter.reset();
  const leg1 = walkFixes(51.3, -117.0, 0, 2.0, 15, 6, 3); // heading north for 15s
  let lat = leg1[leg1.length - 1].lat, lon = leg1[leg1.length - 1].lon;
  const leg2 = walkFixes(lat, lon, 90, 2.0, 15, 6, 3, leg1[leg1.length - 1].t + 1000); // then east for 15s
  let out;
  leg1.forEach(fix => { out = GPSFilter.push(fix); });
  approxHeading(out.headingTravel, 0, 20, "heading matches leg1 (north)");
  let sawHeadingSwitch = false;
  leg2.forEach((fix, i) => {
    out = GPSFilter.push(fix);
    if (i >= 8 && Math.abs(((out.headingTravel - 90 + 540) % 360) - 180) < 25) sawHeadingSwitch = true;
  });
  approxHeading(out.headingTravel, 90, 25, "heading tracks leg2's real 90deg turn (east) within the walked window");
  assert(sawHeadingSwitch || Math.abs(((out.headingTravel - 90 + 540) % 360) - 180) < 25, "the turn was tracked, not permanently rejected as an outlier");
})();

// ============================================================
// (d) Injected single bad/outlier fix — gated (R inflated), recovers fast
// ============================================================
(function testOutlier() {
  GPSFilter.reset();
  const fixes = walkFixes(51.3, -117.0, 90, 1.4, 20, 8, 3);
  // Teleport fix #10 about 200m off the true path
  const bad = destPoint(fixes[10].lat, fixes[10].lon, 0, 200);
  fixes[10] = { lat: bad[0], lon: bad[1], acc: 8, t: fixes[10].t };

  let outAtBad = null, outAfter = [];
  fixes.forEach((fix, i) => {
    const out = GPSFilter.push(fix);
    if (i === 10) outAtBad = out;
    if (i > 10 && i <= 12) outAfter.push(out);
  });
  const truePtAtBad = destPoint(51.3, -117.0, 90, 1.4 * 10);
  const devAtBad = haversineM([outAtBad.lat, outAtBad.lon], truePtAtBad);
  assert(devAtBad < 100, "outlier's influence on the filtered position is well below the raw 200m jump (dev=" + devAtBad.toFixed(1) + "m)");
  const truePtAfter = destPoint(51.3, -117.0, 90, 1.4 * 12);
  const devAfter = haversineM([outAfter[1].lat, outAfter[1].lon], truePtAfter);
  assert(devAfter < 30, "recovers close to the true path within 2 fixes after the outlier (dev=" + devAfter.toFixed(1) + "m)");
})();

// ============================================================
// (e) Long gap (dropped signal) — P grows, next real fix isn't spuriously gated
// ============================================================
(function testGap() {
  GPSFilter.reset();
  const fixes = walkFixes(51.3, -117.0, 90, 1.4, 10, 8, 3);
  fixes.forEach(fix => GPSFilter.push(fix));
  const lastFix = fixes[fixes.length - 1];
  // 30-second gap, then resume walking from where the true path would be
  const gapPt = destPoint(51.3, -117.0, 90, 1.4 * 40);
  const afterGap = { lat: gapPt[0], lon: gapPt[1], acc: 8, t: lastFix.t + 30000 };
  const out = GPSFilter.push(afterGap);
  const dev = haversineM([out.lat, out.lon], gapPt);
  assert(dev < 20, "post-gap fix pulls the state close to the true (jumped) position, not gated out as an outlier (dev=" + dev.toFixed(1) + "m)");
})();

// ============================================================
// (f) Reset behavior — first-fix-is-exact seeding
// ============================================================
(function testReset() {
  GPSFilter.reset();
  const fix = { lat: 51.3, lon: -117.0, acc: 8, t: 1700000000000 };
  const out = GPSFilter.push(fix);
  approx(out.lat, fix.lat, 1e-9, "reset+first push: lat seeded exactly to first fix");
  approx(out.lon, fix.lon, 1e-9, "reset+first push: lon seeded exactly to first fix");
  assert(out.speed === 0, "reset+first push: speed is 0 (no prior fix to derive velocity from)");
  assert(out.headingTravel === null, "reset+first push: headingTravel is null (no velocity yet)");
})();

// ============================================================
// (g) Cross-latitude sanity — same steady-walk scenario at 3 latitudes
// ============================================================
(function testCrossLatitude() {
  [0, 51.3, 70].forEach(lat => {
    GPSFilter.reset();
    const fixes = walkFixes(lat, -117.0, 90, 1.4, 20, 8, 3);
    let out;
    fixes.forEach(fix => { out = GPSFilter.push(fix); });
    approx(out.speed, 1.4, 0.6, "speed converges at lat=" + lat);
    approxHeading(out.headingTravel, 90, 20, "heading converges at lat=" + lat);
  });
})();

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
