// End-to-end trigger-timing comparison: old EMA Smoother (reimplemented here
// exactly as it existed before this rewrite -- it's been deleted from the
// real files) vs the new GPSFilter, feeding the same enter/exit hysteresis
// logic Geofencer uses (EXIT_BUFFER_M hysteresis, ENTER_DWELL_S persistence).
// This is the exact mechanism CLAUDE.md documents as historically
// lag-sensitive at bike/ski speed (16-35m lag against a fixed-tau filter,
// which motivated the original 2026-07-23 speed-adaptive-tau fix).
//
// geofence-sim.html itself needs a real browser DOM to run (map rendering,
// on-page log), so this reimplements just the trigger-timing-relevant slice
// directly, using the exact TUNING values (EXIT_BUFFER_M=20,
// ENTER_DWELL_S=3) confirmed identical across all three engine copies.
// Run: `node tests/gpsfilter-trigger-comparison.test.js`.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sandbox = { console, window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../frontend/kalman-filter.js"), "utf8"), sandbox);
const GPSFilter = sandbox.window.GPSFilter;

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

function hav(a, b) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b[0]-a[0]), dLon = toRad(b[1]-a[1]);
  const la1 = toRad(a[0]), la2 = toRad(b[0]);
  const x = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}

// ---- old EMA Smoother, reimplemented exactly as it existed before this rewrite ----
function makeOldSmoother() {
  const TUNING = { SPEED_TAU_S: 2.3, SMOOTH_TAU_MAX_S: 2.3, SMOOTH_TAU_MIN_S: 0.6, SMOOTH_SPEED_LO_MPS: 2.0, SMOOTH_SPEED_HI_MPS: 8.0 };
  return {
    s: null, rawPrev: null, spd: 0,
    push(fix) {
      if (!this.s) { this.s = { lat: fix.lat, lon: fix.lon }; this.rawPrev = null; this.spd = 0; }
      let dt = null;
      if (this.rawPrev) {
        dt = (fix.t - this.rawPrev.t) / 1000;
        let inst = this.spd;
        if (dt >= 0.4) { inst = hav([this.rawPrev.lat, this.rawPrev.lon], [fix.lat, fix.lon]) / dt; if (inst > 25) inst = this.spd; }
        const spdA = dt > 0 ? 1 - Math.exp(-dt / TUNING.SPEED_TAU_S) : 0.35;
        this.spd = this.spd + spdA * (inst - this.spd);
      }
      this.rawPrev = { lat: fix.lat, lon: fix.lon, t: fix.t };
      const lo = TUNING.SMOOTH_SPEED_LO_MPS, hi = TUNING.SMOOTH_SPEED_HI_MPS;
      const f = hi > lo ? Math.max(0, Math.min(1, (this.spd - lo) / (hi - lo))) : 0;
      const tau = TUNING.SMOOTH_TAU_MAX_S + f * (TUNING.SMOOTH_TAU_MIN_S - TUNING.SMOOTH_TAU_MAX_S);
      const a = (dt != null && dt > 0) ? 1 - Math.exp(-dt / tau) : 0.35;
      this.s = { lat: this.s.lat + a * (fix.lat - this.s.lat), lon: this.s.lon + a * (fix.lon - this.s.lon) };
      return { lat: this.s.lat, lon: this.s.lon, acc: fix.acc, t: fix.t, speed: this.spd };
    }
  };
}

// ---- minimal enter/exit hysteresis, matching Geofencer's real semantics ----
const EXIT_BUFFER_M = 20, ENTER_DWELL_S = 3;
function makeZoneTracker(centerLL, radiusM) {
  let phase = "out", pendingSince = null;
  const events = [];
  return {
    update(p, t) {
      const d = hav([p.lat, p.lon], centerLL);
      if (phase === "out") { if (d <= radiusM) { phase = "pending"; pendingSince = t; } }
      else if (phase === "pending") {
        if (d > radiusM) { phase = "out"; pendingSince = null; }
        else if ((t - pendingSince) / 1000 >= ENTER_DWELL_S) { phase = "in"; events.push({ kind: "enter", t }); }
      } else if (phase === "in") {
        if (d > radiusM + EXIT_BUFFER_M) { phase = "out"; events.push({ kind: "exit", t }); }
      }
      return phase;
    },
    events
  };
}

// ---- synthetic ground-truth path generator ----
const R_LAT = 111320;
function destPoint(lat, lon, brgDeg, d) {
  const phi = lat * Math.PI / 180, brg = brgDeg * Math.PI / 180;
  const dLat = (d * Math.cos(brg)) / R_LAT, dLon = (d * Math.sin(brg)) / (R_LAT * Math.cos(phi));
  return [lat + dLat, lon + dLon];
}
// Deterministic (not Math.random()) jitter -- see kalman-filter.test.js for why.
function jitter(i, magM) { return magM * (0.6 * Math.sin(i * 1.7 + 0.3) + 0.4 * Math.sin(i * 4.1 + 1.9)); }

function buildScenario(speedMps, radiusM, zoneDistM, numFixes) {
  const startLat = 51.3, startLon = -117.0, heading = 90;
  const zoneCenter = destPoint(startLat, startLon, heading, zoneDistM);
  const fixes = [], truth = [];
  let lat = startLat, lon = startLon, t = 1700000000000;
  for (let i = 0; i < numFixes; i++) {
    truth.push({ lat, lon, t });
    const jLat = lat + jitter(i, 6) / R_LAT;
    const jLon = lon + jitter(i + 50, 6) / (R_LAT * Math.cos(lat * Math.PI / 180));
    fixes.push({ lat: jLat, lon: jLon, acc: 8, t });
    const next = destPoint(lat, lon, heading, speedMps);
    lat = next[0]; lon = next[1]; t += 1000;
  }
  return { fixes, truth, zoneCenter };
}

function trueCrossingIndices(truth, zoneCenter, radiusM) {
  let enterIdx = null, exitIdx = null;
  truth.forEach((p, i) => {
    const d = hav([p.lat, p.lon], zoneCenter);
    if (enterIdx === null && d <= radiusM) enterIdx = i;
    if (enterIdx !== null && exitIdx === null && d > radiusM + EXIT_BUFFER_M) exitIdx = i;
  });
  return { enterIdx, exitIdx };
}

function runScenario(label, speedMps, radiusM, zoneDistM, numFixes) {
  const { fixes, truth, zoneCenter } = buildScenario(speedMps, radiusM, zoneDistM, numFixes);
  const { exitIdx: trueExit } = trueCrossingIndices(truth, zoneCenter, radiusM);

  const oldSm = makeOldSmoother();
  const oldTracker = makeZoneTracker(zoneCenter, radiusM);
  fixes.forEach(fix => oldTracker.update(oldSm.push(fix), fix.t));

  GPSFilter.reset();
  const newTracker = makeZoneTracker(zoneCenter, radiusM);
  fixes.forEach(fix => newTracker.update(GPSFilter.push(fix), fix.t));

  const idxOf = t => t == null ? null : Math.round((t - fixes[0].t) / 1000);
  const oldExitIdx = idxOf((oldTracker.events.find(e => e.kind === "exit") || {}).t);
  const newExitIdx = idxOf((newTracker.events.find(e => e.kind === "exit") || {}).t);

  assert(oldTracker.events.length === 2, label + ": old filter produces exactly one clean enter+exit pair (no flicker) — got " + oldTracker.events.length + " events");
  assert(newTracker.events.length === 2, label + ": new filter produces exactly one clean enter+exit pair (no flicker) — got " + newTracker.events.length + " events");

  const oldLag = Math.abs(oldExitIdx - trueExit), newLag = Math.abs(newExitIdx - trueExit);
  assert(newLag <= oldLag, label + ": new filter's exit-buffer lag (" + newLag + " fixes) matches or improves on the old filter's (" + oldLag + " fixes)");
  console.log(label + ": true exit@fix" + trueExit + "  old exit@fix" + oldExitIdx + " (lag " + oldLag + ")  new exit@fix" + newExitIdx + " (lag " + newLag + ")");
}

// radius=25m so a straight-through pass at 10 m/s gives ~5s of true dwell
// time (comfortably over ENTER_DWELL_S=3s) — too tight a radius at this
// speed wouldn't leave enough time-in-zone to ever confirm ENTER regardless
// of which filter is used, which would test the scenario, not the filter.
runScenario("Bike/ski speed (10 m/s, the historically lag-sensitive range)", 10, 25, 30, 20);
runScenario("Walking speed (1.4 m/s, the already field-validated baseline)", 1.4, 12, 15, 60);

// Direct regression check for this week's actual reported bug: the old
// filter's hardcoded >25 m/s spike-reject clamp permanently stuck the
// reported speed at 0 for any sustained speed above 90 km/h. The new
// filter's NIS-based gate has no such hardcoded ceiling.
(function testNoStuckSpeedBug() {
  GPSFilter.reset();
  let lat = 51.3, lon = -117.0;
  const speedMps = 107 / 3.6; // the exact figure from this week's bug report
  let out;
  for (let i = 0; i <= 12; i++) {
    out = GPSFilter.push({ lat, lon, acc: 8, t: 1700000000000 + i * 1000 });
    const next = destPoint(lat, lon, 90, speedMps);
    lat = next[0]; lon = next[1];
  }
  assert(out.speed * 3.6 > 90, "sustained 107 km/h travel converges above 90 km/h, not stuck at 0 (got " + (out.speed*3.6).toFixed(1) + " km/h)");
})();

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
