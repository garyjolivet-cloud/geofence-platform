// Unit tests for the segment-vs-cylinder crossing test (item A, paraglider/
// drone stops, 2026-08-14) and the capped-cylinder SDF combination that
// folds a circle zone's vertical extent (altM/altToleranceM) directly into
// its signed distance, instead of the old independent altOk() AND-gate.
//
// Extracts Geo.segCylinderCross straight out of the real shipped file
// (geofence-engine.html) via vm, so this tests the actual code that ships,
// not a reimplementation — same technique used elsewhere this session to
// verify the BLE LNS/NUS parsers before wiring them up. The state-machine-
// level scenario tests reimplement just the relevant out/pending/in
// transition slice locally (geofence-engine.html/geofence-sim.html need a
// real browser DOM for BUNDLE/MapView/audio — same reasoning
// gpsfilter-trigger-comparison.test.js already documents for why it
// reimplements the old EMA smoother locally instead of extracting it).
//
// Run: `node --test tests/cylinder-segment-cross.test.js` (or as part of
// the full `node --test tests/` suite).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

// ---- extract Geo.segCylinderCross from the real shipped file ----
const html = fs.readFileSync(path.join(__dirname, "../frontend/geofence-engine.html"), "utf8");
const m = html.match(/segCylinderCross\(prevLL, curLL, prevAlt, curAlt, center, R, bottom, top\)\{[\s\S]*?\n  \}/);
if (!m) { console.log("FAIL: could not extract Geo.segCylinderCross from geofence-engine.html"); process.exit(1); }
const Geo = {
  mPerDegLat: 111320,
  mPerDegLon(lat) { return 111320 * Math.cos(lat * Math.PI / 180); },
  toXY(p, ref) { return { x: (p[1] - ref[1]) * this.mPerDegLon(ref[0]), y: (p[0] - ref[0]) * this.mPerDegLat }; },
};
// eslint-disable-next-line no-eval
eval("Geo.segCylinderCross = function(prevLL, curLL, prevAlt, curAlt, center, R, bottom, top){" +
  m[0].slice(m[0].indexOf("{") + 1, -1) + "}");

const center = [51.30, -117.05];
const eastDeg = (m2) => m2 / Geo.mPerDegLon(51.30);

// ---- Geo.segCylinderCross ----

(function testStraightThroughCenter() {
  const prev = [51.30, -117.05 - eastDeg(60)], cur = [51.30, -117.05 + eastDeg(60)];
  const r = Geo.segCylinderCross(prev, cur, 100, 100, center, 20, 90, 110);
  assert(r.crossed, "straight through center, constant in-band altitude: crosses");
  assert(Math.abs(r.tEnter - 1 / 3) < 1e-6 && Math.abs(r.tExit - 2 / 3) < 1e-6,
    "crossing window is symmetric around the midpoint for a straight center pass (got tEnter=" + r.tEnter + " tExit=" + r.tExit + ")");
})();

(function testOutsideRadius() {
  const prev = [51.30, -117.05 - eastDeg(260)], cur = [51.30, -117.05 - eastDeg(140)];
  assert(!Geo.segCylinderCross(prev, cur, 100, 100, center, 20, 90, 110).crossed,
    "segment entirely outside the radius does not cross");
})();

(function testInRadiusButAltitudeAlwaysAboveBand() {
  const prev = [51.30, -117.05 - eastDeg(60)], cur = [51.30, -117.05 + eastDeg(60)];
  assert(!Geo.segCylinderCross(prev, cur, 150, 150, center, 20, 90, 110).crossed,
    "horizontally crosses but altitude stays above the band the whole time: does not cross");
})();

(function testClimbingThroughBandWhileCrossing() {
  const prev = [51.30, -117.05 - eastDeg(60)], cur = [51.30, -117.05 + eastDeg(60)];
  const r = Geo.segCylinderCross(prev, cur, 80, 120, center, 20, 90, 110);
  assert(r.crossed, "climbing through the altitude band while also crossing the radius: crosses");
})();

(function testWindowsDoNotOverlapInTime() {
  // Radius-inside window only near the end of the segment (t~0.8-1.0);
  // altitude-inside window only in the middle (climb 80->120 crosses
  // [90,110] around t=0.25-0.75). The two windows must NOT overlap.
  const prev = [51.30, -117.05 - eastDeg(260)], cur = [51.30, -117.05 + eastDeg(7.5)];
  assert(!Geo.segCylinderCross(prev, cur, 80, 120, center, 20, 90, 110).crossed,
    "radius-inside window and altitude-inside window don't overlap in time: does not cross");
})();

(function testEndpointLiterallyInside() {
  const prev = [51.30, -117.05 - eastDeg(60)];
  const r = Geo.segCylinderCross(prev, center, 150, 100, center, 20, 90, 110);
  assert(r.crossed && Math.abs(r.tExit - 1) < 1e-9,
    "current endpoint literally inside the cylinder: crosses, tExit=1 (got tExit=" + (r && r.tExit) + ")");
})();

(function testMissingAltitudeNeverBlocks() {
  const prev = [51.30, -117.05 - eastDeg(60)], cur = [51.30, -117.05 + eastDeg(60)];
  assert(!Geo.segCylinderCross(prev, cur, null, 100, center, 20, 90, 110).crossed,
    "missing prevAlt: returns not-crossed (never throws, never blocks on missing data)");
  assert(!Geo.segCylinderCross(prev, cur, 100, null, center, 20, 90, 110).crossed,
    "missing curAlt: returns not-crossed");
})();

(function testStationaryHorizontallyInsideRadius() {
  // a≈0 branch — segment doesn't move horizontally at all, sits inside the radius the whole time
  const r = Geo.segCylinderCross(center, center, 95, 105, center, 20, 90, 110);
  assert(r.crossed, "horizontally stationary, inside radius, altitude climbs through band: crosses");
})();

(function testStationaryHorizontallyOutsideRadius() {
  const far = [51.30, -117.05 + eastDeg(500)];
  assert(!Geo.segCylinderCross(far, far, 95, 105, center, 20, 90, 110).crossed,
    "horizontally stationary, outside radius: never crosses regardless of altitude");
})();

// ---- capped-cylinder SDF combination (Geofencer.sd()'s d3 formula) ----
// Same formula as shipped, re-derived here directly rather than extracted
// (it's a 3-line expression inline in sd(), not its own named function) —
// verifies the union-of-two-signed-distances math independently of the
// segment-crossing test above.
function d3(dr, dz) {
  return Math.min(Math.max(dr, dz), 0) + Math.hypot(Math.max(dr, 0), Math.max(dz, 0));
}
(function testSdfCombination() {
  assert(d3(-5, -3) < 0, "inside both radius and altitude band: negative (inside)");
  assert(d3(5, -3) > 0, "outside radius but inside altitude band: positive (outside)");
  assert(d3(-5, 3) > 0, "inside radius but outside altitude band: positive (outside)");
  assert(d3(5, 3) > 0, "outside both: positive (outside)");
  assert(Math.abs(d3(0, -3) - 0) < 1e-9, "exactly on the radius boundary, inside altitude band: ~0");
})();

// ---- state-machine-level scenario: fast flyby vs. sustained visit ----
// Minimal local reimplementation of the out/pending/in transition slice
// relevant to the crossing check (see file header for why this isn't
// extracted from geofence-engine.html directly).
function makeMiniFencer() {
  const state = {};
  const events = [];
  const EXIT_BUFFER_M = 20;
  return {
    events,
    tick(zone, layer, prev, p, now) {
      const k = zone.id + ":" + layer.kind;
      const st = state[k] || (state[k] = { phase: "out", t0: 0 });
      // Planar distance to center, matching Geo.toXY-based sdCircle closely enough for this synthetic test
      const dx = (p.lon - zone.center[1]) * Geo.mPerDegLon(zone.center[0]);
      const dy = (p.lat - zone.center[0]) * Geo.mPerDegLat;
      const drNow = Math.hypot(dx, dy) - layer.radiusM;
      const dz = p.alt == null ? -Infinity : Math.abs(p.alt - zone.altM) - zone.altToleranceM;
      const d = d3(drNow, dz);
      // "pending"-phase rescue (fast movers only): without this, a fast
      // mover whose single fix happens to land inside (d<0, phase goes
      // out->pending) but whose very next fix is already back outside gets
      // silently eaten by the ordinary pending->out "single-fix blip"
      // debounce below — zero events, even though two real fixes (one
      // inside, one outside) are strong crossing evidence. Gated to fast
      // movement so an ordinary slow walker's GPS jitter at the cylinder's
      // edge still goes through the normal debounce untouched.
      const fastEnoughToRescue = prev && Math.hypot(
        (p.lon - prev.lon) * Geo.mPerDegLon(prev.lat),
        (p.lat - prev.lat) * Geo.mPerDegLat
      ) > EXIT_BUFFER_M;
      if ((st.phase === "out" || (st.phase === "pending" && fastEnoughToRescue)) && d >= 0 && prev && prev.alt != null && p.alt != null) {
        const bottom = zone.altM - zone.altToleranceM, top = zone.altM + zone.altToleranceM;
        const cross = Geo.segCylinderCross([prev.lat, prev.lon], [p.lat, p.lon], prev.alt, p.alt, zone.center, layer.radiusM, bottom, top);
        if (cross.crossed) {
          st.phase = "in"; st.t0 = now;
          events.push({ kind: "enter", t: now });
          if (d > EXIT_BUFFER_M) {
            events.push({ kind: "exit", t: now, dur: 0, flick: true });
            st.phase = "out";
          }
          return;
        }
      }
      if (st.phase === "out") { if (d < 0) st.phase = "pending"; }
      else if (st.phase === "pending") {
        if (d >= 0) st.phase = "out";
        else { st.phase = "in"; st.t0 = now; events.push({ kind: "enter", t: now }); }
      } else if (st.phase === "in") {
        if (d > EXIT_BUFFER_M) { events.push({ kind: "exit", t: now, dur: (now - st.t0) / 1000 }); st.phase = "out"; }
      }
    },
  };
}

(function testFastFlybyFiresImmediateEnterExit() {
  // A single fast GPS-tick gap (120m in one interval — e.g. a drone, or a
  // brief signal gap) straight through a small (20m radius, ±10m)
  // cylinder: BOTH the previous and current fix are outside the 20m
  // radius (60m either side of center), but the segment between them
  // passes straight through it — exactly the skip-through case
  // segCylinderCross exists to catch.
  const zone = { id: "z1", center, altM: 100, altToleranceM: 10 };
  const layer = { kind: "target", radiusM: 20 };
  const fencer = makeMiniFencer();
  const prevFix = { lat: 51.30, lon: -117.05 - eastDeg(60), alt: 100, t: 0 };
  const curFix = { lat: 51.30, lon: -117.05 + eastDeg(60), alt: 100, t: 1000 };
  fencer.tick(zone, layer, null, prevFix, prevFix.t);       // first tick: nothing to compare against yet
  fencer.tick(zone, layer, prevFix, curFix, curFix.t);      // second tick: the actual skip-through
  assert(fencer.events.some((e) => e.kind === "enter"), "fast flyby fires an enter event (" + JSON.stringify(fencer.events) + ")");
  assert(fencer.events.some((e) => e.kind === "exit" && e.flick), "fast flyby fires an immediate flyby exit in the same tick, not left hanging 'in'");
})();

(function testCrossingIntoSustainedVisitIsNotAFlyby() {
  // Same fast skip-in as the flyby test above, but the current fix lands
  // genuinely INSIDE the cylinder (d<0), which fails the crossing block's
  // own d>=0 gate — so this test actually exercises the *ordinary*
  // out->pending->in debounce path (fix2 lands inside at slow closing
  // speed relative to fix3, so no rescue fires either), not segCylinderCross
  // itself. What it verifies: a fast qualifying first leg doesn't get
  // mistaken for a flyby once the visitor actually settles inside — exactly
  // one enter, and it must not carry the flyby "exit" flag.
  // Then a further tick still inside must not re-fire a second enter.
  const zone = { id: "z2", center, altM: 100, altToleranceM: 10 };
  const layer = { kind: "target", radiusM: 20 };
  const fencer = makeMiniFencer();
  const fix1 = { lat: 51.30, lon: -117.05 - eastDeg(60), alt: 100, t: 0 };     // outside (60m > 20m radius)
  const fix2 = { lat: 51.30, lon: -117.05 + eastDeg(5), alt: 100, t: 1000 };   // inside (5m < 20m radius)
  const fix3 = { lat: 51.30, lon: -117.05 + eastDeg(10), alt: 100, t: 2000 }; // still inside
  fencer.tick(zone, layer, null, fix1, fix1.t);
  fencer.tick(zone, layer, fix1, fix2, fix2.t);
  fencer.tick(zone, layer, fix2, fix3, fix3.t);
  const enters = fencer.events.filter((e) => e.kind === "enter").length;
  const flybyExits = fencer.events.filter((e) => e.kind === "exit" && e.flick).length;
  assert(enters === 1, "exactly one enter event, not repeated re-entries on subsequent inside ticks (" + enters + ")");
  assert(flybyExits === 0, "no flyby exit fired — this was a genuine entry that stayed inside, not a skip-through (" + JSON.stringify(fencer.events) + ")");
})();

(function testPendingPhaseRescueForFastMover() {
  // The bug this rescue exists to fix: a fast mover's single fix lands
  // inside the cylinder (phase out->pending, no crossing-block eligible
  // since d<0 there), then the very next fix is already back outside at
  // high speed. Without the pending-phase rescue, the ordinary
  // pending->out transition reads this as a "single-fix blip" and
  // discards it silently — zero events for a real fast pass. With the
  // rescue, the fast (>20m) closing leg from an inside fix to an outside
  // one is itself treated as crossing evidence.
  const zone = { id: "z3", center, altM: 100, altToleranceM: 10 };
  const layer = { kind: "target", radiusM: 20 };
  const fencer = makeMiniFencer();
  const fix1 = { lat: 51.30, lon: -117.05 - eastDeg(60), alt: 100, t: 0 };     // outside
  const fix2 = { lat: 51.30, lon: -117.05 + eastDeg(5), alt: 100, t: 1000 };   // single fix inside (65m fast leg in)
  const fix3 = { lat: 51.30, lon: -117.05 + eastDeg(60), alt: 100, t: 2000 };  // back outside (55m fast leg out)
  fencer.tick(zone, layer, null, fix1, fix1.t);
  fencer.tick(zone, layer, fix1, fix2, fix2.t);
  fencer.tick(zone, layer, fix2, fix3, fix3.t);
  const enters = fencer.events.filter((e) => e.kind === "enter").length;
  const flybyExits = fencer.events.filter((e) => e.kind === "exit" && e.flick).length;
  assert(enters === 1, "fast mover swallowed by the pending debounce is rescued: exactly one enter fires (" + JSON.stringify(fencer.events) + ")");
  assert(flybyExits === 1, "the rescued visit closes out as a flyby exit, not left hanging 'in' (" + JSON.stringify(fencer.events) + ")");
})();

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
