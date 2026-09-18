// Standalone Node test suite for frontend/chute-guard.js (window.ChuteGuard).
// This repo has no test runner/package.json — run directly: `node tests/chute-guard.test.js`.
// Follows the same ad-hoc-Node-script + vm-sandbox pattern as
// tests/kalman-filter.test.js — load the real shipped module, drive it with
// synthetic GPS fixes, assert on the callbacks it fires.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function freshChuteGuard(){
  const sandbox = { console, window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../frontend/chute-guard.js"), "utf8"), sandbox);
  return sandbox.window.ChuteGuard;
}

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log("FAIL:", msg); }
}

// ---------- geometry helpers for building synthetic corridors/tracks ----------
const R_LAT = 111320;
function destPoint(p, bearingDeg, distM) {
  const [lat, lon] = p;
  const phi = lat * Math.PI / 180;
  const brg = bearingDeg * Math.PI / 180;
  const dLat = (distM * Math.cos(brg)) / R_LAT;
  const dLon = (distM * Math.sin(brg)) / (R_LAT * Math.cos(phi));
  return [lat + dLat, lon + dLon];
}

const START = [51.3, -117.0];

// A straight corridor running due north (bearing 0) for lenM, sampled every
// 20m — chute-guard.js resamples internally anyway, this is just enough
// resolution for nearestOnPath() to behave like a real straight line.
function makeCorridor(id, { lenM = 400, widthM = 10, runType = "chute", activityType = null } = {}) {
  const path = [START];
  const steps = Math.ceil(lenM / 20);
  for (let i = 1; i <= steps; i++) path.push(destPoint(START, 0, Math.min(i * 20, lenM)));
  return { id, name: "Test " + id, runType, activityType,
    layers: [{ geometry: { type: "corridor", path, widthM } }] };
}

// One point at `forwardM` along the corridor (north) then `lateralM` east
// of that point (positive = outside on the east side).
function trackPoint(forwardM, lateralM) {
  return destPoint(destPoint(START, 0, forwardM), 90, lateralM);
}

// Drives one or more corridors through a sequence of steps and collects
// every callback firing. Each step: {forwardM, lateralM, speed, acc, headingDeg, t}.
function drive(ChuteGuard, corridors, steps, startT) {
  const events = { warn: [], clear: [], disengage: [], debug: [] };
  ChuteGuard.load(Array.isArray(corridors) ? corridors : [corridors], {
    onWarn: (id, name, info) => events.warn.push(Object.assign({ id, name }, info)),
    onClear: (id, name) => events.clear.push({ id, name }),
    onDisengage: (id, name, info) => events.disengage.push(Object.assign({ id, name }, info)),
    onDebug: (id, name, info) => events.debug.push(Object.assign({ id, name }, info))
  });
  const t0 = startT || 1700000000000;
  steps.forEach(s => {
    const pos = trackPoint(s.forwardM, s.lateralM);
    ChuteGuard.tick(
      { lat: pos[0], lon: pos[1], acc: s.acc != null ? s.acc : 5, speed: s.speed != null ? s.speed : 1.5, t: t0 + (s.t != null ? s.t : 0) },
      s.headingDeg !== undefined ? s.headingDeg : 0
    );
  });
  return events;
}

// Builds a step sequence: `coverM` of forward-only travel at offset 0 (to
// satisfy the engage-coverage gate), then a drift phase where lateral offset
// grows by `lateralPerSec` every second while forward progress continues at
// `speedMps` (approximating cos(smallAngle)~1, adequate for these tests).
function excursionSteps({ speedMps = 1.5, coverM = 70, driftSeconds = 25, lateralPerSec = 1, acc = 5, headingDeg = 0 } = {}) {
  const steps = [];
  const coverSeconds = Math.ceil(coverM / speedMps);
  let forwardM = 0, t = 0;
  for (let i = 0; i <= coverSeconds; i++) {
    steps.push({ forwardM, lateralM: 0, speed: speedMps, acc, headingDeg, t });
    forwardM += speedMps; t += 1000;
  }
  for (let i = 1; i <= driftSeconds; i++) {
    steps.push({ forwardM, lateralM: i * lateralPerSec, speed: speedMps, acc, headingDeg, t });
    forwardM += speedMps; t += 1000;
  }
  return steps;
}

// ============================================================
// 1. Scope: every run_type loads and can alert, except "lift"
// ============================================================
(function testScopeFilter(){
  ["run", "hike", "chute", undefined].forEach(rt => {
    const ChuteGuard = freshChuteGuard();
    const corridor = makeCorridor("c1", { runType: rt, lenM: 400, widthM: 10 });
    const events = drive(ChuteGuard, corridor, excursionSteps({ lateralPerSec: 2, driftSeconds: 10 }));
    assert(events.warn.length > 0, "runType=" + rt + " corridor is evaluated and can alert");
  });
  const ChuteGuard = freshChuteGuard();
  const lift = makeCorridor("c1", { runType: "lift", lenM: 400, widthM: 10 });
  const events = drive(ChuteGuard, lift, excursionSteps({ lateralPerSec: 2, driftSeconds: 10 }));
  assert(events.warn.length === 0, "runType=lift is excluded — never alerts");
})();

// ============================================================
// 2. Structural filters + width coercion
// ============================================================
(function testStructuralFilters(){
  const ChuteGuard = freshChuteGuard();
  const noLayer = { id: "n1", name: "no layer", runType: "run", layers: [] };
  const shortPath = { id: "n2", name: "1 point", runType: "run",
    layers: [{ geometry: { type: "corridor", path: [START], widthM: 10 } }] };
  const events = drive(ChuteGuard, [noLayer, shortPath], excursionSteps({ lateralPerSec: 3, driftSeconds: 10 }));
  assert(events.warn.length === 0, "corridor with no layer / <2 path points never alerts, and load() doesn't throw");

  // widthM coercion: "12" (string) -> 12 (halfW=6, edge=6+BUF=6.5m);
  // 0/NaN -> fallback 10 (halfW=5, edge=5+BUF=5.5m). A constant 6.0m offset
  // is inside the width="12" edge (excess -0.5m, never alerts) but outside
  // the fallback-width edge (excess +0.5m) — with the immediate-trigger
  // design (no distance/accuracy delay stacked on the edge), a single
  // outside fix is enough to tell the two apart.
  function edgeCheckAtOffset(widthMValue) {
    const cg = freshChuteGuard();
    const corridor = { id: "w1", name: "w", runType: "run", activityType: null,
      layers: [{ geometry: { type: "corridor", path: makeCorridor("x").layers[0].geometry.path, widthM: widthMValue } }] };
    const steps = [];
    let forwardM = 0;
    for (let i = 0; i <= 50; i++) { steps.push({ forwardM, lateralM: 0, t: i * 1000 }); forwardM += 1.5; }
    steps.push({ forwardM, lateralM: 6.0, t: 51000 });
    const events = drive(cg, corridor, steps);
    return events.warn.length > 0;
  }
  assert(edgeCheckAtOffset("12") === false, "widthM='12' (string) coerced to 12 -> edge 6.5m -> 6.0m offset stays inside (no alert)");
  assert(edgeCheckAtOffset(0) === true, "widthM=0 falls back to 10 -> edge 5.5m -> 6.0m offset is outside -> alerts on the very next fix");
  assert(edgeCheckAtOffset(NaN) === true, "widthM=NaN falls back to 10 -> edge 5.5m -> 6.0m offset is outside -> alerts on the very next fix");
})();

// ============================================================
// 3. load() idempotence / state preservation across a same-corridor reload
// ============================================================
(function testLoadIdempotence(){
  const ChuteGuard = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  const events = { warn: [] };
  const cbs = { onWarn: (id, name, info) => events.warn.push(info) };
  ChuteGuard.load([corridor], cbs);

  const t0 = 1700000000000;
  let forwardM = 0, t = 0;
  function tick(lateralM){
    const pos = trackPoint(forwardM, lateralM);
    ChuteGuard.tick({ lat: pos[0], lon: pos[1], acc: 5, speed: 1.5, t: t0 + t }, 0);
    forwardM += 1.5; t += 1000;
  }
  for (let i = 0; i <= 50; i++) tick(0); // cover phase
  // Hold at a CONSTANT excess (no growth) so this test isolates reload
  // behavior from the committed-exit detector (decision 5, covered
  // separately below) — a plateauing drift alerts repeatedly without ever
  // committing.
  for (let i = 0; i < 10; i++) tick(14); // excess = 14-5.5 = 8.5m
  const alertCountBeforeReload = events.warn.length;
  assert(alertCountBeforeReload > 0, "excursion produced alerts before reload (sanity check)");
  ChuteGuard.load([corridor], cbs); // same corridor reloaded mid-excursion
  for (let i = 0; i < 10; i++) tick(14);
  assert(events.warn.length > alertCountBeforeReload, "alerting continues seamlessly after a same-corridor reload (state preserved, not reset)");
  const alertCounts = events.warn.map(w => w.alertCount);
  assert(new Set(alertCounts).size === alertCounts.length, "alertCount keeps incrementing across the reload, never resets back to 1");

  // Reload with a DIFFERENT widthM -> different sig -> state resets.
  const changedCorridor = makeCorridor("c1", { lenM: 400, widthM: 20 }); // edge = 10+0.5 = 10.5
  ChuteGuard.load([changedCorridor], cbs);
  const before = events.warn.length;
  for (let i = 0; i <= 50; i++) tick(0); // cover phase again (fresh state, fresh coverage)
  for (let i = 0; i < 5; i++) tick(20); // excess = 20-14 = 6m, above the 3.75m requirement -> fires immediately
  const firstNewAlert = events.warn.slice(before)[0];
  assert(firstNewAlert && firstNewAlert.alertCount === 1, "changing widthM invalidates the corridor's signature and resets excursion state");
})();

// ============================================================
// 4. Engage gate — heading
// ============================================================
(function testEngageHeading(){
  const ChuteGuard = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  const steps = excursionSteps({ lateralPerSec: 3, driftSeconds: 15 }).map(s => Object.assign({}, s, { headingDeg: null }));
  const events = drive(ChuteGuard, corridor, steps);
  assert(events.warn.length === 0, "headingDeg=null never engages -> never alerts, even far outside");

  const ChuteGuard2 = freshChuteGuard();
  const steps2 = excursionSteps({ lateralPerSec: 3, driftSeconds: 15 }).map(s => Object.assign({}, s, { headingDeg: 90 }));
  const events2 = drive(ChuteGuard2, corridor, steps2);
  assert(events2.warn.length === 0, "heading perpendicular to the corridor (90deg off) never engages -> never alerts");
})();

// ============================================================
// 5. Engage gate — per-activity minimum speed
// ============================================================
(function testEngageSpeedByActivity(){
  const ChuteGuardHike = freshChuteGuard();
  const hikeCorridor = makeCorridor("c1", { lenM: 400, widthM: 10, activityType: "hike" });
  const hikeEvents = drive(ChuteGuardHike, hikeCorridor, excursionSteps({ speedMps: 1.0, lateralPerSec: 2, driftSeconds: 15 }));
  assert(hikeEvents.warn.length > 0, "hike-typed corridor engages at 1.0 m/s (below the old fixed 1.5 m/s floor)");

  const ChuteGuardSki = freshChuteGuard();
  const skiCorridor = makeCorridor("c1", { lenM: 400, widthM: 10, activityType: "ski_chute" });
  const skiEvents = drive(ChuteGuardSki, skiCorridor, excursionSteps({ speedMps: 1.0, lateralPerSec: 2, driftSeconds: 15 }));
  assert(skiEvents.warn.length === 0, "ski_chute-typed corridor does NOT engage at 1.0 m/s (its floor is 1.5 m/s)");
})();

// ============================================================
// 6. Engage gate — coverage cap on a long corridor
// ============================================================
(function testCoverageCap(){
  // 6km corridor: 15% would be 900m, but the 150m cap should let it arm
  // after ~150-160m of travel instead.
  const shortCover = freshChuteGuard();
  const corridor6k = makeCorridor("c1", { lenM: 6000, widthM: 10 });
  const under = drive(shortCover, corridor6k, excursionSteps({ coverM: 100, lateralPerSec: 3, driftSeconds: 15 }));
  assert(under.warn.length === 0, "6km corridor with only 100m covered (< 150m cap) never engages -> no alert");

  const overCover = freshChuteGuard();
  const over = drive(overCover, corridor6k, excursionSteps({ coverM: 160, lateralPerSec: 3, driftSeconds: 15 }));
  assert(over.warn.length > 0, "6km corridor with 160m covered (> 150m cap) engages and alerts, without needing 900m (15%)");
})();

// ============================================================
// 7. First-alert distance is roughly speed-independent (core decision-4 check)
// ============================================================
(function testFirstAlertDistanceIndependentOfSpeed(){
  // Same departure angle (lateral velocity = speed*sin(20deg)) at two very
  // different overall speeds — walking vs. driving. Under a fixed
  // wall-clock debounce, the fast case would drift much farther before its
  // first alert (proportional to speed); under the new distance-based
  // trigger, both should fire at roughly the same excess distance.
  function firstAlertExcess(speedMps){
    const cg = freshChuteGuard();
    const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
    const angleRad = 20 * Math.PI / 180;
    const lateralV = speedMps * Math.sin(angleRad), forwardV = speedMps * Math.cos(angleRad);
    const steps = [];
    let forwardM = 0, t = 0;
    const coverSeconds = Math.ceil(70 / speedMps);
    for (let i = 0; i <= coverSeconds; i++) { steps.push({ forwardM, lateralM: 0, speed: speedMps, t }); forwardM += forwardV; t += 1000; }
    for (let i = 1; i <= 30; i++) { steps.push({ forwardM, lateralM: i * lateralV, speed: speedMps, t }); forwardM += forwardV; t += 1000; }
    const events = drive(cg, corridor, steps);
    assert(events.warn.length > 0, "speed=" + speedMps + "m/s excursion produced at least one alert");
    return events.warn[0].excessM;
  }
  const walkExcess = firstAlertExcess(1.5);
  const driveExcess = firstAlertExcess(15);
  assert(Math.abs(walkExcess - driveExcess) < 8,
    "first-alert excess distance is close between walking (" + walkExcess.toFixed(1) + "m) and driving (" + driveExcess.toFixed(1) +
    "m) speeds — old time-based debounce would have let the faster case drift ~10x farther");
})();

// ============================================================
// 8. Reaction is immediate regardless of GPS accuracy (below the cap)
// ============================================================
(function testAccuracyDoesNotDelayReaction(){
  // There is no accuracy-scaled "how far past the edge" requirement any
  // more (removed per the "start as soon as GPS is outside corridor"
  // fix) — a fix's own accuracy no longer changes how many meters of
  // excess are needed before the first alert. Confirm tight vs. loose
  // (but still-under-the-cap) accuracy both fire on the very first
  // outside fix, for the same small excess.
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  function buildConstSteps(acc){
    const steps = [];
    let forwardM = 0, t = 0;
    for (let i = 0; i <= 50; i++) { steps.push({ forwardM, lateralM: 0, acc, t }); forwardM += 1.5; t += 1000; }
    for (let i = 1; i <= 5; i++) { steps.push({ forwardM, lateralM: 9, acc, t }); forwardM += 1.5; t += 1000; } // excess = 9-7 = 2m
    return steps;
  }
  const tight = drive(freshChuteGuard(), corridor, buildConstSteps(5));
  assert(tight.warn.length === 5, "tight accuracy (5m): fires on every one of the 5 outside fixes, starting with the first");

  const loose = drive(freshChuteGuard(), corridor, buildConstSteps(25));
  assert(loose.warn.length === 5, "loose accuracy (25m, still under the cap): fires on every outside fix too — no longer delayed by accuracy");
  assert(loose.warn[0].alertCount === 1 && tight.warn[0].alertCount === 1, "both fire on the very first outside fix (alertCount 1), regardless of accuracy");

  // Fixes worse than the accuracy cap (30m) are still ignored entirely.
  const capped = drive(freshChuteGuard(), corridor, buildConstSteps(31));
  assert(capped.warn.length === 0 && capped.debug.length === 0, "fixes with accuracy worse than the 30m cap are ignored entirely (no warn, no debug)");
})();

// ============================================================
// 9. Per-fix signaling + escalation ladder (time-based)
// ============================================================
(function testEscalationLadder(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  // Constant 5m excess (below both distance-ladder thresholds of 10m/25m),
  // held for 13 fixes at 1Hz (max msOutside=12000, under the 15s give-up
  // cap tested separately below) -> escalation must come purely from the
  // time ladder.
  const steps = [];
  { let forwardM = 0, t = 0;
    for (let i = 0; i <= 50; i++) { steps.push({ forwardM, lateralM: 0, t }); forwardM += 1.5; t += 1000; }
    for (let i = 1; i <= 13; i++) { steps.push({ forwardM, lateralM: 14, t }); forwardM += 1.5; t += 1000; }
  }
  const events = drive(cg, corridor, steps);
  assert(events.warn.length === 13, "onWarn fires on every one of the 13 outside fixes, not throttled to a cooldown");
  let levelsNonDecreasing = true;
  for (let i = 1; i < events.warn.length; i++) if (events.warn[i].level < events.warn[i-1].level) levelsNonDecreasing = false;
  assert(levelsNonDecreasing, "level never decreases within a single excursion");
  const byMsOutside = ms => events.warn.find(w => w.msOutside >= ms);
  const at5s = byMsOutside(5000), at12s = byMsOutside(12000);
  assert(at5s && at5s.level >= 2, "reaches level 2 by ~5s outside");
  assert(at12s && at12s.level >= 3, "reaches level 3 by ~12s outside");
  const alertCounts = events.warn.map(w => w.alertCount);
  assert(alertCounts.every((v, i) => i === 0 || v === alertCounts[i-1] + 1), "alertCount increments by exactly 1 on every alert");
})();

// ============================================================
// 9b. Unconditional 15s give-up cap — fires regardless of pattern
// ============================================================
(function testMaxAlertDuration(){
  // Held at a perfectly constant excess (no growth, no correction) for 20s
  // straight — the growth-based commit detector alone would never fire
  // here, but the alarm still must not nag forever: past
  // MAX_ALERT_DURATION_MS (15s) with no return inside, chute-guard.js gives
  // up and fires onDisengage, same as a genuine committed departure.
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  const steps = [];
  { let forwardM = 0, t = 0;
    for (let i = 0; i <= 50; i++) { steps.push({ forwardM, lateralM: 0, t }); forwardM += 1.5; t += 1000; }
    for (let i = 1; i <= 20; i++) { steps.push({ forwardM, lateralM: 14, t }); forwardM += 1.5; t += 1000; } // constant excess = 5m
  }
  const events = drive(cg, corridor, steps);
  assert(events.disengage.length === 1, "a held-constant excursion past 15s fires onDisengage exactly once, purely from the time cap");
  const disengageT = events.disengage[0].t;
  assert(events.warn.every(w => w.t < disengageT), "no onWarn calls after the 15s cap fires");
  assert(events.warn.length >= 14 && events.warn.length <= 16, "roughly 15 warns fired before the cap cut it off (t=0..~14000ms at 1Hz)");
})();

// ============================================================
// 10. A single large excursion reaches level 3 immediately
// ============================================================
(function testImmediateHighLevel(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  const steps = [];
  { let forwardM = 0, t = 0;
    for (let i = 0; i <= 50; i++) { steps.push({ forwardM, lateralM: 0, t }); forwardM += 1.5; t += 1000; }
    // Jump straight to 39m offset -> excess = 39-5.5 = 33.5m, past ESCALATE_EXCESS_M[2]=25.
    steps.push({ forwardM, lateralM: 39, t: 51000 });
  }
  const events = drive(cg, corridor, steps);
  assert(events.warn.length === 1, "a single large excursion produces exactly one alert so far");
  assert(events.warn[0].level === 3, "a 30m excursion starts at level 3 immediately, not easing in through 1->2->3 (got level " + events.warn[0].level + ")");
})();

// ============================================================
// 11. Return inside resets state and fires onClear exactly once
// ============================================================
(function testReturnInsideResets(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  const steps = [];
  { let forwardM = 0, t = 0;
    for (let i = 0; i <= 50; i++) { steps.push({ forwardM, lateralM: 0, t }); forwardM += 1.5; t += 1000; }
    for (let i = 1; i <= 5; i++) { steps.push({ forwardM, lateralM: 14, t: 51000 + i*1000 }); forwardM += 1.5; } // outside
    steps.push({ forwardM, lateralM: 0, t: 57000 }); // back inside
    for (let i = 1; i <= 5; i++) { steps.push({ forwardM, lateralM: 14, t: 58000 + i*1000 }); forwardM += 1.5; } // outside again, immediately
  }
  const events = drive(cg, corridor, steps);
  assert(events.clear.length === 1, "onClear fires exactly once, on the fix where the player returns inside");
  const secondExcursionAlerts = events.warn.filter(w => w.t >= 1700000058000);
  assert(secondExcursionAlerts.length > 0 && secondExcursionAlerts[0].alertCount === 1 && secondExcursionAlerts[0].level === 1,
    "re-exiting immediately after returning inside re-alerts at level 1, alertCount 1 (the old 20s cooldown is gone)");
})();

// ============================================================
// 12. Committed-exit detector (decision 5)
// ============================================================
(function testCommittedExit(){
  // Steady one-directional growth, no correction -> onDisengage fires once,
  // and no further onWarn calls afterward even while still in range.
  const growing = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  const growSteps = excursionSteps({ coverM: 70, driftSeconds: 25, lateralPerSec: 1 }); // steady 1m/s lateral growth
  const growEvents = drive(growing, corridor, growSteps);
  assert(growEvents.disengage.length === 1, "steady one-directional growth fires onDisengage exactly once");
  const disengageT = growEvents.disengage[0].t;
  const warnsAfterDisengage = growEvents.warn.filter(w => w.t > disengageT);
  assert(warnsAfterDisengage.length === 0, "no further onWarn calls after onDisengage, even while still within range");

  // Grows for a couple fixes then narrows back down (a real correction
  // attempt) -> never disengages via the growth detector, keeps alerting
  // normally. Kept under the 15s give-up cap (tested separately) so this
  // isolates the growth/correction logic specifically.
  const correcting = freshChuteGuard();
  const correctSteps = [];
  { let forwardM = 0, t = 0;
    for (let i = 0; i <= 50; i++) { correctSteps.push({ forwardM, lateralM: 0, t }); forwardM += 1.5; t += 1000; }
    const offsets = [14, 15, 16, 15, 13, 11, 9.5, 14, 15, 16]; // grow-then-correct, never fully resolves or fully commits (10s total, under the cap)
    offsets.forEach((off, i) => { correctSteps.push({ forwardM, lateralM: off, t: 51000 + i * 1000 }); forwardM += 1.5; });
  }
  const correctEvents = drive(correcting, corridor, correctSteps);
  assert(correctEvents.disengage.length === 0, "an oscillating correction attempt (grow then narrow, repeated), kept under 15s, never fires onDisengage");
  assert(correctEvents.warn.length > 0, "the oscillating/correcting track keeps alerting normally");

  // Pure GPS jitter near the edge (no clear trend) — also never disengages
  // via the growth detector. Kept under the 15s cap for the same reason as
  // the correcting case above (the unconditional cap is tested separately).
  const jittering = freshChuteGuard();
  const jitterSteps = [];
  { let forwardM = 0, t = 0;
    for (let i = 0; i <= 50; i++) { jitterSteps.push({ forwardM, lateralM: 0, t }); forwardM += 1.5; t += 1000; }
    for (let i = 0; i < 10; i++) { jitterSteps.push({ forwardM, lateralM: 14 + (i % 2 === 0 ? 0.2 : -0.2), t: 51000 + i * 1000 }); forwardM += 1.5; }
  }
  const jitterEvents = drive(jittering, corridor, jitterSteps);
  assert(jitterEvents.disengage.length === 0, "GPS jitter with no real trend, kept under 15s, never fires onDisengage via the growth detector");
})();

// ============================================================
// 13. Back-compat: a 2-arity onWarn with no onClear/onDisengage doesn't throw
// ============================================================
(function testBackCompatCallbacks(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  let warnCalls = 0;
  let threw = false;
  cg.load([corridor], { onWarn(id, name){ warnCalls++; } }); // old 2-arity signature, no onClear/onDisengage
  try {
    const steps = excursionSteps({ coverM: 70, driftSeconds: 15, lateralPerSec: 2 });
    steps.push({ forwardM: steps[steps.length-1].forwardM + 1.5, lateralM: 0, t: (steps[steps.length-1].t||0) + 1000 }); // return inside at the end
    steps.forEach(s => {
      const pos = trackPoint(s.forwardM, s.lateralM);
      cg.tick({ lat: pos[0], lon: pos[1], acc: 5, speed: 1.5, t: 1700000000000 + s.t }, 0);
    });
  } catch (e) { threw = true; console.log(e); }
  assert(!threw, "a callbacks object with only a 2-arity onWarn and no onClear/onDisengage runs a full excursion without throwing");
  assert(warnCalls > 0, "onWarn was actually invoked during the back-compat run");
})();

// ============================================================
// 14. Field bug: no alert while approaching a corridor before ever
// entering it THIS pass, even when coverage/heading/speed already carry
// over from an earlier lap in the same session
// ============================================================
(function testNoAlertBeforeFirstEntry(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 }); // halfW=5, edge=halfW+0.5=5.5
  const events = { warn: [] };
  cg.load([corridor], { onWarn: (id, name, info) => events.warn.push(info) });
  const t0 = 1700000000000;
  let forwardM = 0, t = 0;
  function tick(lateralM){
    const pos = trackPoint(forwardM, lateralM);
    cg.tick({ lat: pos[0], lon: pos[1], acc: 5, speed: 1.5, t: t0 + t }, 0);
    forwardM += 1.5; t += 1000;
  }
  // Pass 1: walk the corridor's centerline far enough to build coverage
  // (60m clears the 150m-cap-of-15% gate for a 400m corridor) and to have
  // genuinely been inside, then walk far enough away (well beyond
  // maxRelevantM = edge5.5+60=65.5m) to fully leave its relevant range.
  for (let i = 0; i <= 60; i++) tick(0);
  for (let i = 0; i < 10; i++) tick(200);
  const warnsAfterPass1 = events.warn.length;
  assert(warnsAfterPass1 === 0, "walking the corridor once, then leaving, produces no false alert on its own");

  // Pass 2: approach the SAME corridor again from outside — coverage,
  // heading, and speed are all already satisfied from pass 1, so the field
  // bug this test guards against would fire here purely from "currently
  // outside," before ever having entered THIS pass.
  for (let i = 0; i < 8; i++) tick(20); // excess = 20-5.5 = 14.5m, well outside but still within maxRelevantM
  assert(events.warn.length === warnsAfterPass1,
    "approaching a previously-walked corridor a second time, before re-entering it, produces no alert even though coverage/heading/speed already carry over");

  // Now actually cross in, then exit — should alert normally.
  for (let i = 0; i < 5; i++) tick(0);
  for (let i = 0; i < 3; i++) tick(20);
  assert(events.warn.length > warnsAfterPass1, "after genuinely entering this pass, exiting alerts normally");
})();

// ============================================================
// 15. Field bug: committed-exit timing must be wall-clock consistent
// regardless of fix rate (Test Mode's simulated walk ticks several times
// per real second; a real phone's GPS ticks roughly once per second) —
// found via a real Test Mode log showing the guard silencing itself within
// ~1s of real time during sim playback.
// ============================================================
(function testCommitTimingIsTickRateIndependent(){
  function msToCommit(hz){
    const cg = freshChuteGuard();
    const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
    let firstAlertT = null, disengageT = null;
    cg.load([corridor], {
      onWarn: (id, name, info) => { if (firstAlertT == null) firstAlertT = info.t; },
      onDisengage: (id, name, info) => { if (disengageT == null) disengageT = info.t; }
    });
    const dtMs = 1000 / hz, speedMps = 1.5, lateralPerRealSecond = 8; // fast departure, matching the real log's sharp-turn-away pattern
    let forwardM = 0, t = 0;
    const coverTicks = Math.round(50 * hz); // 50 real seconds of travel, regardless of hz
    for (let i = 0; i <= coverTicks; i++) {
      const pos = trackPoint(forwardM, 0);
      cg.tick({ lat: pos[0], lon: pos[1], acc: 5, speed: speedMps, t: 1700000000000 + t }, 0);
      forwardM += speedMps * (dtMs / 1000); t += dtMs;
    }
    const driftTicks = Math.round(6 * hz); // up to 6 real seconds of drift
    for (let i = 1; i <= driftTicks && disengageT == null; i++) {
      const lateralM = i * (dtMs / 1000) * lateralPerRealSecond;
      const pos = trackPoint(forwardM, lateralM);
      cg.tick({ lat: pos[0], lon: pos[1], acc: 5, speed: speedMps, t: 1700000000000 + t }, 0);
      forwardM += speedMps * (dtMs / 1000); t += dtMs;
    }
    return (firstAlertT != null && disengageT != null) ? (disengageT - firstAlertT) : null;
  }
  const fast = msToCommit(10); // ~10 ticks/sec, like an accelerated Test Mode walk
  const slow = msToCommit(1);  // ~1 tick/sec, like real GPS
  assert(fast != null && slow != null, "both a fast-ticking and a slow-ticking track eventually commit");
  assert(Math.abs(fast - slow) < 1500,
    "time-to-commit (real elapsed ms outside) is consistent regardless of fix rate (fast=" + fast + "ms, slow=" + slow +
    "ms) — a fix-count-based detector would have committed roughly 10x faster in wall-clock time at 10Hz than at 1Hz");
})();

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
