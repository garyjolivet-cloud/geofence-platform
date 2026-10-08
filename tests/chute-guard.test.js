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
function makeCorridor(id, { lenM = 400, widthM = 10, runType = "run", activityType = null } = {}) {
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
// 4. "Hard line" requirement (2026-09-19): heading no longer gates whether
// the alarm fires — being geometrically outside the width+buffer is
// sufficient on its own, regardless of heading. `engaged` is still computed
// and reported via onDebug for diagnostic purposes, but no longer decides
// whether onWarn fires.
// ============================================================
(function testHeadingNoLongerGatesAlarm(){
  const ChuteGuard = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  const steps = excursionSteps({ lateralPerSec: 3, driftSeconds: 15 }).map(s => Object.assign({}, s, { headingDeg: null }));
  const events = drive(ChuteGuard, corridor, steps);
  assert(events.warn.length > 0, "headingDeg=null still alerts once geometrically outside — heading is no longer a gate");
  assert(events.debug.some(d => d.engaged===false), "onDebug still correctly reports engaged=false for diagnostics even though it no longer blocks the alarm");

  const ChuteGuard2 = freshChuteGuard();
  const steps2 = excursionSteps({ lateralPerSec: 3, driftSeconds: 15 }).map(s => Object.assign({}, s, { headingDeg: 90 }));
  const events2 = drive(ChuteGuard2, corridor, steps2);
  assert(events2.warn.length > 0, "heading perpendicular to the corridor (90deg off) still alerts — a mere crossing is now treated the same as a real departure, per explicit user request");
})();

// ============================================================
// 5. "Hard line" requirement: per-activity minimum speed no longer gates
// the alarm either — same reasoning as heading above.
// ============================================================
(function testSpeedNoLongerGatesAlarm(){
  const ChuteGuardSki = freshChuteGuard();
  const skiCorridor = makeCorridor("c1", { lenM: 400, widthM: 10, activityType: "ski_chute" });
  const skiEvents = drive(ChuteGuardSki, skiCorridor, excursionSteps({ speedMps: 1.0, lateralPerSec: 2, driftSeconds: 15 }));
  assert(skiEvents.warn.length > 0, "ski_chute-typed corridor now alerts even at 1.0 m/s (below its old 1.5 m/s engage floor) — speed no longer gates the alarm");
})();

// ============================================================
// 6. "Hard line" requirement: coverage no longer gates the alarm on a long
// corridor either — a single geometrically-outside fix is enough regardless
// of how much of the corridor has been traveled so far.
// ============================================================
(function testCoverageNoLongerGatesAlarm(){
  const shortCover = freshChuteGuard();
  const corridor6k = makeCorridor("c1", { lenM: 6000, widthM: 10 });
  const under = drive(shortCover, corridor6k, excursionSteps({ coverM: 100, lateralPerSec: 3, driftSeconds: 15 }));
  assert(under.warn.length > 0, "6km corridor with only 100m covered (< the old 150m engage cap) still alerts now — coverage no longer gates the alarm");
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
  // Constant 8.5m excess (below the 10m distance threshold), held for 13
  // fixes at 1Hz (max msOutside=12000, under the 15s give-up cap tested
  // separately below). Two levels, distance only (2026-09-21): time alone
  // must NEVER escalate -- a level-2 that appeared exactly 5 s after leaving
  // read as random since it said nothing about how far out the player was.
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
  assert(at5s && at5s.level === 1, "still level 1 at ~5s outside: time no longer escalates");
  assert(at12s && at12s.level === 1, "still level 1 at ~12s outside, and there is no level 3");
  assert(events.warn.every(w => w.level === 1), "every alert of a modest (8.5m) excursion stays level 1 however long it lasts");
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

// Level 2 is purely distance: cross the 10 m-past-the-edge line and it rises, and it never depends on time.
(function testLevelTwoIsDistanceOnly(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  const steps = [];
  { let forwardM = 0, t = 0;
    for (let i = 0; i <= 50; i++) { steps.push({ forwardM, lateralM: 0, t }); forwardM += 1.5; t += 1000; }
    // hold 6.5 m past the edge for 3 fixes (level 1), then step out to 11.5 m past it. (A STEADY drift
    // outward is silenced as a deliberate departure after 4 s, so it can't be used to reach 10 m.)
    for (let i = 1; i <= 3; i++) { steps.push({ forwardM, lateralM: 12, t }); forwardM += 1.5; t += 1000; }
    for (let i = 1; i <= 2; i++) { steps.push({ forwardM, lateralM: 17, t }); forwardM += 1.5; t += 1000; }
  }
  const events = drive(cg, corridor, steps);
  const first2 = events.warn.find(w => w.level === 2);
  assert(first2, "an excursion that drifts past 10 m outside reaches level 2");
  assert(first2 && first2.excessM >= 10, "level 2 begins only once the excess is >= 10 m, got " + (first2 && first2.excessM));
  assert(events.warn.filter(w => w.excessM < 10).every(w => w.level === 1), "every alert under 10 m excess is level 1");
})();

// ============================================================
// 10. A single large excursion reaches level 2 (the top level) immediately
// ============================================================
(function testImmediateHighLevel(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  const steps = [];
  { let forwardM = 0, t = 0;
    for (let i = 0; i <= 50; i++) { steps.push({ forwardM, lateralM: 0, t }); forwardM += 1.5; t += 1000; }
    // Jump straight to 39m offset -> excess = 39-5.5 = 33.5m, past ESCALATE_EXCESS_M[1]=10.
    steps.push({ forwardM, lateralM: 39, t: 51000 });
  }
  const events = drive(cg, corridor, steps);
  assert(events.warn.length === 1, "a single large excursion produces exactly one alert so far");
  assert(events.warn[0].level === 2, "a 30m excursion starts at level 2 (the top level) immediately, not easing in (got level " + events.warn[0].level + ")");
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
// 14. "Hard line in space" for a corridor already entered (2026-09-19),
// combined with "no approach ping" (2026-09-20): approaching from outside
// without ever having entered must NOT alert at all (see
// testNeverEnteredCorridorNeverAlerts above) — but the very next real fix
// once you cross in and back out again alerts immediately, purely because
// it's geometrically outside the width+buffer and within maxRelevantM, with
// no extra delay stacked on top now that everInside is satisfied.
// ============================================================
(function testAlertsOnExitAfterFirstEntryButNotBeforeIt(){
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
  // Approach the corridor from outside, without ever having entered it —
  // must NOT alert (no approach ping).
  for (let i = 0; i < 8; i++) tick(20); // excess = 20-5.5 = 14.5m, outside but within maxRelevantM
  assert(events.warn.length === 0, "approaching a corridor from outside, before ever entering it, must not alert");

  // Now actually cross in, then exit — should alert immediately.
  for (let i = 0; i < 5; i++) tick(0);
  for (let i = 0; i < 3; i++) tick(20);
  assert(events.warn.length > 0, "after genuinely entering and re-exiting, alerts fire normally");
})();

// No approach ping (2026-09-20, explicit user requirement, replacing the
// earlier "level-1 approach ping" design tested here previously): a real
// field test found that design still produced a full, sustained alarm well
// before the corridor had ever actually been entered — a false alarm, not a
// helpful heads-up. A corridor never entered must now never alert at all, no
// matter how close or how long it sits within range.
(function testNeverEnteredCorridorNeverAlerts(){
  const cg = freshChuteGuard();
  // Same corridor shape as the original field report: halfW=5m, huge fixed
  // excess (44m, comfortably within maxRelevantM=halfW+0.5+60=65.5m) and a
  // long stationary hold — both ladders would normally justify L3.
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  const events = { warn: [], disengage: [] };
  cg.load([corridor], {
    onWarn: (id, name, info) => events.warn.push(info),
    onDisengage: (id, name, info) => events.disengage.push(info)
  });
  const t0 = 1700000000000;
  for (let i = 0; i < 20; i++) {
    const pos = trackPoint(0, 44);
    cg.tick({ lat: pos[0], lon: pos[1], acc: 5, speed: 0, t: t0 + i * 1000 }, null);
  }
  assert(events.warn.length === 0, "a never-entered corridor must never alert, however large the excess or however long it holds — got " + events.warn.length + " warn(s)");
  assert(events.disengage.length === 0, "nothing was ever active, so there's nothing to disengage from — got " + events.disengage.length);

  // Once genuinely entered, the ladder applies normally again.
  const corridor2 = makeCorridor("c2", { lenM: 400, widthM: 10 });
  const events2 = { warn: [] };
  cg.load([corridor2], { onWarn: (id, name, info) => events2.warn.push(info) });
  let forwardM = 0, t = 0;
  function tick2(lateralM, speed){
    const pos = trackPoint(forwardM, lateralM);
    cg.tick({ lat: pos[0], lon: pos[1], acc: 5, speed, t: t0 + t }, 0);
    forwardM += speed; t += 1000;
  }
  for (let i = 0; i < 5; i++) tick2(0, 1.5);   // actually inside first
  for (let i = 0; i < 3; i++) tick2(44, 1.5);  // then a huge excursion
  assert(events2.warn.length > 0, "after genuinely being inside, drifting outside now alerts");
  assert(events2.warn.some(w => w.level > 1),
    "after genuinely being inside, a large excursion escalates past level 1 normally");
})();

// getActiveAlarm()'s dead-reckoning bridge must not invent an approach ping
// either — only tick()'s own real-fix state (everInside) may ever start an
// alarm for a corridor never actually entered.
(function testNeverEnteredCorridorNoDeadReckonedPing(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  cg.load([corridor], {});
  const t0 = 1700000000000;
  // A real fix well outside, moving fast and parallel to the corridor —
  // exactly the shape that would otherwise let predictNow() extrapolate a
  // further-outside position and light up the DR bridge.
  const pos = trackPoint(0, 44);
  cg.tick({ lat: pos[0], lon: pos[1], acc: 5, speed: 5, t: t0 }, 0);
  const active = cg.getActiveAlarm();
  assert(active === null, "a never-entered corridor's dead-reckoning bridge must not start an alarm either — got " + JSON.stringify(active));
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

// ============================================================
// 16. Field bug: `engaged` flickering false mid-excursion (heading/speed
// noise) while still geometrically outside must NOT silently discard the
// active excursion without a stop signal. Found via a real sim log: a
// disengage tick landed at a still-positive excessM, chute-guard.js reset
// state without calling onClear (since excessM<=0 was false), the host's
// already-started tone was orphaned, and the excursion looked "brand new"
// the next time engaged came back true.
// ============================================================
(function testEngagedFlickerDoesNotOrphanAlarm(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 }); // halfW=5, edge=5.5
  const steps = [];
  let forwardM = 0, t = 0;
  // cover phase, engaged
  for (let i = 0; i <= 50; i++) { steps.push({ forwardM, lateralM: 0, headingDeg: 0, t }); forwardM += 1.5; t += 1000; }
  // exit and alert, engaged
  for (let i = 0; i < 3; i++) { steps.push({ forwardM, lateralM: 14, headingDeg: 0, t }); forwardM += 1.5; t += 1000; }
  // engaged flickers false for a couple ticks WHILE STILL OUTSIDE (still lateralM=14,
  // excess=8.5m, well above 0) — e.g. a momentary heading-noise dropout, not a return inside
  for (let i = 0; i < 2; i++) { steps.push({ forwardM, lateralM: 14, headingDeg: null, t }); forwardM += 1.5; t += 1000; }
  // re-engages, still outside at the same offset
  for (let i = 0; i < 3; i++) { steps.push({ forwardM, lateralM: 14, headingDeg: 0, t }); forwardM += 1.5; t += 1000; }

  const events = drive(cg, corridor, steps);
  assert(events.clear.length === 0, "engaged flicker while still outside never fires onClear (they never returned inside)");
  assert(events.disengage.length === 0, "engaged flicker alone (no real growth trend) never fires onDisengage either");
  const warnsAfterFlicker = events.warn.filter(w => w.t >= 1700000053000);
  assert(warnsAfterFlicker.length > 0, "alerting resumes/continues after the flicker (not silenced)");
  const alertCounts = events.warn.map(w => w.alertCount);
  assert(new Set(alertCounts).size === alertCounts.length,
    "alertCount keeps incrementing straight through the flicker — proves the excursion state was never silently reset (alertCount would restart at 1 if it had been)");
})();

// ============================================================
// 17. Field bug: walking straight past a corridor's END far enough to leave
// maxRelevantM entirely, while still actively alerting but before ever
// satisfying the normal commit-detection thresholds, must still fire
// onDisengage — not a silent reset with no stop signal at all. Found via a
// real Test Mode report: "tone never turned off, had to exit Test Mode to
// kill it" after walking well past a corridor's end.
// ============================================================
(function testFarOutOfRangeStillFiresDisengage(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 }); // halfW=5, edge=5.5, maxRelevantM=65.5
  const steps = [];
  let forwardM = 0, t = 0;
  for (let i = 0; i <= 50; i++) { steps.push({ forwardM, lateralM: 0, t }); forwardM += 1.5; t += 1000; } // cover phase
  steps.push({ forwardM, lateralM: 6, t: t }); forwardM += 1.5; t += 1000;      // excess=0.5m -> first alert, level 1
  steps.push({ forwardM, lateralM: 200, t: t });                                // one big jump straight past maxRelevantM (65.5m) in a single tick
  const events = drive(cg, corridor, steps);
  assert(events.warn.length >= 1, "sanity check: the excursion actually alerted before jumping out of range");
  assert(events.disengage.length === 1, "jumping straight past maxRelevantM while still actively alerting fires onDisengage exactly once");
  assert(events.clear.length === 0, "this is not a genuine return inside, so onClear never fires");
})();

// ============================================================
// 18. getActiveAlarm() — the pull-based, level-triggered query added
// 2026-09-19 to replace event-sourced host alarm-driving entirely. Meant to
// be polled on a host-owned fixed-rate timer and applied unconditionally,
// so it must always answer correctly from CURRENT state alone, with no
// dependency on which events did or didn't fire to get there.
// ============================================================
(function testGetActiveAlarmBasic(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 }); // halfW=5, edge=5.5
  cg.load([corridor], {});
  assert(cg.getActiveAlarm() === null, "no alarm before any tick at all");

  const t0 = 1700000000000;
  let forwardM = 0, t = 0;
  function tick(lateralM){
    const pos = trackPoint(forwardM, lateralM);
    cg.tick({ lat: pos[0], lon: pos[1], acc: 5, speed: 1.5, t: t0 + t }, 0);
    forwardM += 1.5; t += 1000;
  }
  for (let i = 0; i <= 50; i++) tick(0); // cover phase
  assert(cg.getActiveAlarm() === null, "no alarm while still inside");

  tick(14); // excess = 14-5.5 = 8.5m -> first alert
  const active1 = cg.getActiveAlarm();
  assert(active1 && active1.corridorId === "c1" && active1.level >= 1, "getActiveAlarm reports the corridor once outside, with a real level");

  tick(0); // back inside
  assert(cg.getActiveAlarm() === null, "no alarm again immediately after a genuine return inside — no separate onClear needed for this to be correct");
})();

(function testGetActiveAlarmIgnoresCommitted(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  cg.load([corridor], {});
  // steady one-directional growth -> commits (same profile as testCommittedExit above)
  const steps = excursionSteps({ coverM: 70, driftSeconds: 25, lateralPerSec: 1 });
  steps.forEach(s => {
    const pos = trackPoint(s.forwardM, s.lateralM);
    cg.tick({ lat: pos[0], lon: pos[1], acc: s.acc, speed: s.speed, t: 1700000000000 + s.t }, s.headingDeg);
  });
  assert(cg.getActiveAlarm() === null, "getActiveAlarm reports no alarm once the excursion has committed (deliberate departure), even though excessM is still large and positive");
})();

(function testGetActiveAlarmStaleness(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  cg.load([corridor], {});
  let forwardM = 0, t = 0;
  function tick(lateralM){
    const pos = trackPoint(forwardM, lateralM);
    cg.tick({ lat: pos[0], lon: pos[1], acc: 5, speed: 1.5, t: 1700000000000 + t }, 0);
    forwardM += 1.5; t += 1000;
  }
  for (let i = 0; i <= 50; i++) tick(0);
  tick(14); // excess=8.5m -> active alarm
  assert(cg.getActiveAlarm() !== null, "sanity check: alarm is active right after the tick that triggered it");

  // Real automotive-style fail-safe: even a genuinely still-outside, still-
  // active (not committed) excursion must stop reporting an alarm once no
  // fix has landed for STALE_MS of REAL wall-clock time — this is the exact
  // "sim/GPS stalls mid-excursion" scenario that used to require a separate
  // per-host watchdog timer (now removed) to recover from at all.
  const origStale = cg.TUNING.STALE_MS;
  cg.TUNING.STALE_MS = 30; // shrink for a fast, real (not simulated) wait
  const spinUntil = Date.now() + 60;
  while (Date.now() < spinUntil) { /* busy-wait past STALE_MS in real time, no more ticks fed */ }
  assert(cg.getActiveAlarm() === null, "getActiveAlarm reports no alarm once real wall-clock time since the last tick exceeds STALE_MS, regardless of internal excursion state");
  cg.TUNING.STALE_MS = origStale;
})();

// ============================================================
// 19. Field bug found 2026-09-19: "if I exit right and reenter, the tone
// stays on until I exit left." Root cause: near.distM is unsigned, so a
// fast movement (or Test Mode's own random jitter) between two consecutive
// fixes could straddle a narrow corridor entirely — one fix reads "6m right
// of center," the very next reads "6m left of center," and NEITHER fix
// ever lands inside the width band, even though the true continuous path
// between them plainly crossed it. Fixed by checking the SWEPT segment
// between consecutive fixes against the corridor, not just each point in
// isolation.
// ============================================================
(function testSweptCrossingCatchesFastLateralJump(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 4 }); // halfW=2, edge=2.5
  const events = { warn: [], clear: [] };
  cg.load([corridor], {
    onWarn: (id, name, info) => events.warn.push(info),
    onClear: (id, name) => events.clear.push({ id, name })
  });
  const t0 = 1700000000000;
  let forwardM = 0, t = 0;
  function tick(lateralM){
    const pos = trackPoint(forwardM, lateralM);
    cg.tick({ lat: pos[0], lon: pos[1], acc: 5, speed: 1.5, t: t0 + t }, 0);
    forwardM += 1.5; t += 1000;
  }
  for (let i = 0; i <= 5; i++) tick(0); // brief cover phase, centerline
  tick(6); // exit to the RIGHT: excess = 6-2.5 = 3.5m -> first alert
  assert(events.warn.length > 0, "sanity check: exiting right triggers a first alert");

  tick(-6); // one fast tick straight to the LEFT side — the old point-only check would ALSO read this as ~3.5m outside (distance is unsigned), never registering a return
  assert(events.clear.length === 1, "a single-tick jump from one side to the other correctly registers as a genuine return inside via the swept-segment check, not a continuous never-cleared excursion");

  tick(6); // jumping straight back from -6 to +6 is ITSELF another genuine crossing — state is already inactive after the first reset, so there's nothing to clear again, but this tick still shouldn't count as a fresh alert either
  assert(events.warn.filter(w => w.alertCount === 1).length === 1, "the jump-back tick is also a crossing, not yet a fresh excursion (still only one alertCount=1 so far)");
  tick(6); // hold at +6 for a second consecutive tick — now the PREVIOUS fix is also on the right side, so this one is a genuinely fresh excursion, not another crossing
  const freshAlerts = events.warn.filter(w => w.alertCount === 1);
  assert(freshAlerts.length > 1, "once the crossing settles, the next confirming tick on one side starts a brand new excursion (alertCount resets to 1 again)");
})();

// ============================================================
// 20. The swept-segment check must not regress the normal, small-step case
// (typical GPS/sim ticks a meter or so apart) — same-side movement across
// several ordinary steps should behave exactly as before.
// ============================================================
(function testSweptCrossingMatchesPointCheckForOrdinaryMovement(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 }); // halfW=5, edge=5.5
  const events = drive(cg, corridor, excursionSteps({ coverM: 70, driftSeconds: 15, lateralPerSec: 1 }));
  assert(events.warn.length > 0, "ordinary small-step drift still alerts normally with the swept-segment check in place");
})();

// ============================================================
// 21. Field bug found 2026-09-19: "I hear two tones, a low and higher
// pitch, at times" — a DIFFERENT, distant, unrelated corridor's tone
// briefly stealing the alarm slot. Root cause: sweptOppositeSideCrossing()
// measured against a segment's INFINITE line with no bound tight enough to
// exclude a corridor sitting continuously 30-65m away (well within the old
// maxRelevantM pad) — a coincidental line-crossing far from that corridor's
// actual location could falsely un-commit it and let it re-fire a fresh,
// often high-level alert. Fixed with a tighter MAX_CROSSING_JUMP_M bound.
// ============================================================
(function testDistantCorridorNotFalselyCrossedByJump(){
  const cg = freshChuteGuard();
  const near = makeCorridor("near", { lenM: 400, widthM: 10 }); // halfW=5, edge=5.5
  // A second, unrelated corridor running parallel to "near" but shifted 50m
  // east — the player never comes anywhere near its actual location, but
  // it's well within the OLD maxRelevantM bound (~65.5m) the whole time.
  const distantOffset = 50;
  const distantStart = destPoint(START, 90, distantOffset);
  const distantPath = [distantStart];
  for (let i = 1; i <= 20; i++) distantPath.push(destPoint(distantStart, 0, i * 20));
  const distant = { id: "distant", name: "Distant", runType: "run", activityType: null,
    layers: [{ geometry: { type: "corridor", path: distantPath, widthM: 10 } }] }; // halfW=5, edge=5.5

  const events = { warn: [], disengage: [] };
  cg.load([near, distant], {
    onWarn: (id, name, info) => events.warn.push(Object.assign({ id }, info)),
    onDisengage: (id) => events.disengage.push(id)
  });

  const t0 = 1700000000000;
  let t = 0;
  // No approach ping (2026-09-20): "distant" must actually be entered once
  // before it can ever alert/commit — walk its own centerline briefly first.
  for (let i = 0; i < 2; i++) {
    const pos = trackPoint(0, distantOffset); // on distant's own axis, distM=0
    cg.tick({ lat: pos[0], lon: pos[1], acc: 5, speed: 1.5, t: t0 + t }, 0);
    t += 1000;
  }
  // Get "distant" committed: hold at a fixed point ~8m outside its edge
  // (well within ITS OWN engage/relevance) for 15+ seconds so the
  // unconditional MAX_ALERT_DURATION_MS cap commits it.
  for (let i = 0; i <= 16; i++) {
    const pos = trackPoint(0, distantOffset - 8); // ~8m from distant's axis, well outside its 5.5m edge
    cg.tick({ lat: pos[0], lon: pos[1], acc: 5, speed: 1.5, t: t0 + t }, 0);
    t += 1000;
  }
  assert(events.disengage.includes("distant"), "sanity check: 'distant' corridor commits (silences itself) after holding outside it for 15s+");
  const distantWarnsBeforeJump = events.warn.filter(w => w.id === "distant").length;

  // A huge, fast lateral jump on the far side of "near" — both endpoints
  // land beyond MAX_CROSSING_JUMP_M past distant's own edge (40m out on
  // each side, well past its ~35.5m bound), on opposite sides of distant's
  // axis. This must NOT be treated as a crossing of "distant" — the player
  // never came anywhere near its actual location.
  const before = trackPoint(0, distantOffset - 40);
  cg.tick({ lat: before[0], lon: before[1], acc: 5, speed: 1.5, t: t0 + t }, 0); t += 1000;
  const after = trackPoint(1.5, distantOffset + 40);
  cg.tick({ lat: after[0], lon: after[1], acc: 5, speed: 30, t: t0 + t }, 0);

  const distantWarnsAfterJump = events.warn.filter(w => w.id === "distant").length;
  assert(distantWarnsAfterJump === distantWarnsBeforeJump,
    "a huge, fast lateral jump on the far side of a DIFFERENT, distant, already-committed corridor does not falsely re-trigger a fresh alert for it");
})();

// ============================================================
// 22. onDebug's "crossing" marker (added 2026-09-19 per a user request to
// verify exit/entry use the same distance-from-center threshold): must
// fire exactly on the tick outsideNow flips, bypassing the normal 500ms
// throttle, for BOTH the exit and the entry transition — not just one of
// them (a first version only caught entry, since the reset branch wiped
// the tracking on every tick spent inside).
// ============================================================
(function testCrossingMarkerFiresForBothExitAndEntry(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 }); // halfW=5, edge=5.5
  const events = drive(cg, corridor, [
    ...Array.from({ length: 8 }, (_, i) => ({ forwardM: i * 1.5, lateralM: 0, t: i * 1000 })), // cover phase, inside
    { forwardM: 12, lateralM: 6, t: 8000 },   // exit: excess = 0.5m
    { forwardM: 13.5, lateralM: 6, t: 9000 }, // hold outside (not a crossing tick)
    { forwardM: 15, lateralM: 0, t: 10000 },  // entry: back on centerline
    { forwardM: 16.5, lateralM: 0, t: 11000 } // hold inside (not a crossing tick)
  ]);
  const crossings = events.debug.filter(d => d.crossing);
  assert(crossings.length === 2, "exactly two crossing-marked debug lines fire — one exit, one entry (got " + crossings.length + ")");
  if (crossings.length === 2) {
    assert(crossings[0].excessM > 0, "the exit crossing is marked on a tick with positive excess (just went outside)");
    assert(crossings[1].excessM <= 0, "the entry crossing is marked on a tick with non-positive excess (just came back inside)");
  }
})();

// ============================================================
// 23. Dead reckoning (2026-09-19): between real GPS fixes, getActiveAlarm()
// extrapolates position from the last real fix's speed+heading to react
// sooner than the real fix rate alone would allow — symmetric, per explicit
// user decision (predicts both silencing early on re-entry AND alerting
// early on exit). Uses real wall-clock busy-waits (same technique as
// testGetActiveAlarmStaleness) since predictNow() reads Date.now() directly.
// ============================================================
(function testDeadReckoningSilencesAlarmEarlyOnPredictedReentry(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 }); // halfW=5, edge=5.5
  cg.load([corridor], {});
  // No approach ping (2026-09-20): must actually enter once before this
  // corridor can alert at all.
  const entry = trackPoint(48, 0);
  cg.tick({ lat: entry[0], lon: entry[1], acc: 5, speed: 1.5, t: 1699999999000 }, 0);
  const pos1 = trackPoint(50, 8); // excess = 2.5m, genuinely outside
  cg.tick({ lat: pos1[0], lon: pos1[1], acc: 5, speed: 8, t: 1700000000000 }, 270); // heading due "west" — straight back toward centerline
  assert(cg.getActiveAlarm() !== null, "sanity check: real fix alone reports an active alarm");
  // No further real tick — real wall-clock time passes with the player
  // (per the last real fix) heading straight back in at 8 m/s. After ~0.9s
  // real time (comfortably inside the 1.5s DR ceiling): predicted lateral
  // roughly 8 - 8*0.9 = 0.8m -> excess = 0.8 - 5.5 = -4.7m, well past
  // DR_CONFIRM_MARGIN_M (1.0m) so this isn't just noise grazing zero.
  const spinUntil = Date.now() + 900;
  while (Date.now() < spinUntil) { /* real busy-wait, no more ticks fed */ }
  assert(cg.getActiveAlarm() === null, "dead reckoning silences the alarm early once the predicted (not yet confirmed) position is clearly back inside");
})();

(function testDeadReckoningStartsAlarmEarlyOnPredictedExit(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 }); // halfW=5, edge=5.5
  cg.load([corridor], {});
  const pos1 = trackPoint(50, 3); // excess = -2.5m, genuinely inside, no alarm yet
  cg.tick({ lat: pos1[0], lon: pos1[1], acc: 5, speed: 8, t: 1700000000000 }, 90); // heading due "east" — straight out toward/past the edge
  assert(cg.getActiveAlarm() === null, "sanity check: real fix alone reports no alarm while inside");
  // After ~0.9s real time heading east at 8 m/s: predicted lateral roughly
  // 3 + 8*0.9 = 10.2m -> excess = 4.7m, well past DR_CONFIRM_MARGIN_M (1.0m).
  const spinUntil = Date.now() + 900;
  while (Date.now() < spinUntil) { /* real busy-wait, no more ticks fed */ }
  const alarm = cg.getActiveAlarm();
  assert(alarm !== null, "dead reckoning starts the alarm early once the predicted (not yet confirmed) position is clearly past the edge");
  if (alarm) assert(alarm.level === 1, "a DR-only alert (no real excursion history yet) starts at level 1, never a fabricated higher severity");
})();

// Real Test Mode log, 2026-09-20: with NO new real fix arriving (avatar not
// being dragged, not a real GPS gap), DR kept extrapolating the last fix's
// speed+heading as if the player were still moving — a stale straight-line
// "coast" that phantom-drifted through a narrow corridor and back out the
// other side, flipping the tone off then on with zero real movement
// (STOP_TONE and the next START_TONE both fired with no chuteGuard debug
// line, i.e. no real tick, anywhere between them). A borderline prediction
// that only grazes the edge — the exact shape a stale/coasting velocity
// guess produces — must NOT be trusted enough to flip the real state.
(function testDeadReckoningIgnoresBorderlinePredictionsNearTheEdge(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 }); // halfW=5, edge=5.5
  cg.load([corridor], {});
  // No approach ping (2026-09-20): must actually enter once before this
  // corridor can alert at all.
  const entry = trackPoint(48, 0);
  cg.tick({ lat: entry[0], lon: entry[1], acc: 5, speed: 1.5, t: 1699999999000 }, 0);
  const pos1 = trackPoint(50, 6); // excess = 0.5m — just barely outside, real alarm active
  cg.tick({ lat: pos1[0], lon: pos1[1], acc: 5, speed: 1, t: 1700000000000 }, 270); // slow drift back toward centerline
  assert(cg.getActiveAlarm() !== null, "sanity check: real fix alone reports an active alarm");
  // After ~0.6s at 1 m/s: predicted lateral roughly 6 - 0.6 = 5.4m -> excess
  // = -0.1m — technically "predicted inside," but only by 0.1m, nowhere
  // near DR_CONFIRM_MARGIN_M (1.0m). Must stay audible; this is exactly the
  // kind of marginal guess a stopped-but-stale fix produces.
  const spinUntil = Date.now() + 600;
  while (Date.now() < spinUntil) { /* real busy-wait, no more ticks fed */ }
  assert(cg.getActiveAlarm() !== null, "a borderline dead-reckoned prediction that only barely grazes the edge does not override the real (still-outside) state");
})();

(function testDeadReckoningIgnoresStationaryOrStaleFixes(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  cg.load([corridor], {});
  // No approach ping (2026-09-20): must actually enter once before this
  // corridor can alert at all.
  const entry = trackPoint(48, 0);
  cg.tick({ lat: entry[0], lon: entry[1], acc: 5, speed: 1.5, t: 1699999999000 }, 0);
  const posOutside = trackPoint(50, 8); // excess = 2.5m
  // Stationary (speed 0): heading is meaningless noise at zero speed, so DR
  // must not extrapolate away from what the real fix itself said.
  cg.tick({ lat: posOutside[0], lon: posOutside[1], acc: 5, speed: 0, t: 1700000000000 }, 270);
  const spinUntil1 = Date.now() + 120;
  while (Date.now() < spinUntil1) { /* real busy-wait */ }
  assert(cg.getActiveAlarm() !== null, "a stationary fix's alarm is never silenced by DR (no meaningful heading to extrapolate)");

  // Stale: heading toward the corridor but old enough that DR gives up
  // rather than guessing arbitrarily far into the future.
  cg.TUNING.DR_MAX_S = 0.05; // shrink so a short real wait is already "too stale" to trust
  const posOutside2 = trackPoint(60, 8);
  cg.tick({ lat: posOutside2[0], lon: posOutside2[1], acc: 5, speed: 5, t: 1700000001000 }, 270); // 1s after the first tick's fix.t — well under NEVER_ENTERED_MAX_ALERT_MS, so the commit timer doesn't confound this DR-staleness check
  const spinUntil2 = Date.now() + 120;
  while (Date.now() < spinUntil2) { /* real busy-wait past the shrunk DR_MAX_S */ }
  assert(cg.getActiveAlarm() !== null, "DR gives up (falls back to the last real fix) once its own prediction window has elapsed, rather than guessing indefinitely far ahead");
})();

// ============================================================
// Lift suppression (2026-09-20 gondola false-alarm fix): the guard's
// distance check has no altitude axis, so a lift line recorded along/near a
// chute must suppress that chute's alerting entirely while it's being
// ridden — see chute-guard.js's nearAnyLift()/tick() lift gate.
// ============================================================

(function testLiftClearsAnAlreadyActiveAlarm(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 }); // halfW=5, edge=5.5
  const events = { clear: [] };
  const cb = { onClear: (id, name) => events.clear.push({ id, name }) };
  cg.load([corridor], cb);

  // Enter, then drift outside to trigger a real alarm — same shape as the
  // "no approach ping" tests above.
  const entry = trackPoint(48, 0);
  cg.tick({ lat: entry[0], lon: entry[1], acc: 5, speed: 1.5, t: 1700000000000 }, 0);
  const outside = trackPoint(50, 8); // excess = 2.5m, genuinely outside
  cg.tick({ lat: outside[0], lon: outside[1], acc: 5, speed: 1.5, t: 1700000001000 }, 90);
  assert(cg.getActiveAlarm() !== null, "sanity check: alarm is active before boarding the lift");

  // "Board a gondola" recorded right along the same line (common at a
  // resort) — reload with the lift zone added; the chute's live state
  // (level>0) is preserved across the reload since its own sig is unchanged.
  const lift = makeCorridor("lift1", { lenM: 400, widthM: 10, runType: "lift" });
  cg.load([corridor, lift], cb);

  // Same position as before (still "outside" the chute's band on paper) —
  // but now also on the lift line, so the guard must clear rather than keep
  // sounding.
  cg.tick({ lat: outside[0], lon: outside[1], acc: 5, speed: 4, t: 1700000002000 }, 90);
  assert(events.clear.length === 1 && events.clear[0].id === "c1", "boarding a co-located lift line clears an already-sounding chute alarm via onClear");
  assert(cg.getActiveAlarm() === null, "no audible alarm while on a lift line, even though the chute corridor is still geometrically outside");
})();

(function testLiftPreventsANewAlarmFromStarting(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 });
  const lift = makeCorridor("lift1", { lenM: 400, widthM: 10, runType: "lift" }); // co-located with the chute
  const events = { warn: [] };
  cg.load([corridor, lift], { onWarn: (id, name, info) => events.warn.push(Object.assign({ id, name }, info)) });

  // Well outside the chute's band the whole time, but riding the co-located
  // lift throughout — must never alert, this is the actual gondola bug.
  const outside = trackPoint(50, 8);
  cg.tick({ lat: outside[0], lon: outside[1], acc: 5, speed: 4, t: 1700000000000 }, 0);
  assert(events.warn.length === 0, "no warn fires for a corridor approached only while riding a co-located lift");
  assert(cg.getActiveAlarm() === null, "no audible alarm either");
})();

(function testNormalAlertingResumesAfterLeavingTheLift(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 10 }); // halfW=5, edge=5.5
  const lift = makeCorridor("lift1", { lenM: 400, widthM: 10, runType: "lift" }); // co-located with the chute
  const events = { warn: [] };
  const cb = { onWarn: (id, name, info) => events.warn.push(Object.assign({ id, name }, info)) };
  cg.load([corridor, lift], cb);

  const entry = trackPoint(48, 0);
  const outside = trackPoint(50, 8); // excess = 2.5m
  cg.tick({ lat: entry[0], lon: entry[1], acc: 5, speed: 1.5, t: 1700000000000 }, 0); // on the lift -> suppressed
  cg.tick({ lat: outside[0], lon: outside[1], acc: 5, speed: 1.5, t: 1700000001000 }, 90); // still on the lift -> suppressed
  assert(events.warn.length === 0, "still suppressed the whole time co-located with the lift");

  // Step off the lift (reload without it) and repeat the same positions —
  // normal alerting must resume immediately.
  cg.load([corridor], cb);
  cg.tick({ lat: entry[0], lon: entry[1], acc: 5, speed: 1.5, t: 1700000002000 }, 0);
  cg.tick({ lat: outside[0], lon: outside[1], acc: 5, speed: 1.5, t: 1700000003000 }, 90);
  assert(events.warn.length > 0, "normal alerting resumes once off the lift");
})();

// Test Mode log 2026-10-03: part-way down Torpedo Alley, onto the gondola line (suppressed),
// then off the lift 54 m outside the chute -> full-level tone for 10 s. A lift ride now means
// the rider has left every chute: no alarm until they've been back inside it.
(function testLeavingALiftDoesNotResumeAnOldChuteAlarm(){
  const cg = freshChuteGuard();
  const corridor = makeCorridor("c1", { lenM: 400, widthM: 40 });        // halfW 20, edge 20.5
  const liftPath = []; for (let f = 0; f <= 400; f += 20) liftPath.push(trackPoint(f, 60));  // parallel lift 60 m east
  const lift = { id: "lift1", name: "Gondola", runType: "lift", layers: [{ geometry: { type: "corridor", path: liftPath, widthM: 10 } }] };
  const events = { warn: [] };
  cg.load([corridor, lift], { onWarn: (id, name, info) => events.warn.push(Object.assign({ id, name }, info)) });
  let t = 1700000000000;
  const at = (f, lat) => { const p = trackPoint(f, lat); cg.tick({ lat: p[0], lon: p[1], acc: 5, speed: 5, t: (t += 1000) }, 0); };
  for (let f = 0; f <= 100; f += 10) at(f, 0);                 // skiing inside the chute
  assert(cg.getActiveAlarm() === null && events.warn.length === 0, "sanity: inside the chute, quiet");
  for (let f = 110; f <= 150; f += 10) at(f, 60);              // on the lift line
  assert(cg.isOnLift() === true, "sanity: on the lift");
  for (let f = 160; f <= 220; f += 10) at(f, 25);              // off the lift, 4.5 m outside the chute's edge
  assert(events.warn.length === 0 && cg.getActiveAlarm() === null, "leaving the lift does not resume the chute's alarm, got " + events.warn.length + " warns");
  for (let f = 230; f <= 270; f += 10) at(f, 0);               // back inside the chute
  for (let f = 280; f <= 300; f += 10) at(f, 25);              // then off its edge again
  assert(events.warn.length > 0, "after being back inside, drifting out alarms as normal");
})();

// ============================================================
// isOnLift() (Battery Saver support): must work even for a project with NO
// alertable corridors at all (e.g. a summer sightseeing gondola with no ski
// chutes authored) — tick()'s corridors.length===0 early return must not
// prevent lift detection from updating, since a host reads this signal
// independent of whether ChuteGuard has anything else to guard.
// ============================================================

(function testIsOnLiftWorksWithNoAlertableCorridors(){
  const cg = freshChuteGuard();
  const lift = makeCorridor("lift1", { lenM: 400, widthM: 10, runType: "lift" });
  cg.load([lift], {}); // no chute/run/hike corridors at all — corridors (alertable) is empty

  assert(cg.isOnLift() === false, "isOnLift() starts false before any tick");

  const onLine = trackPoint(50, 0); // dead center of the lift's own line
  cg.tick({ lat: onLine[0], lon: onLine[1], acc: 5, speed: 4, t: 1700000000000 }, 0);
  assert(cg.isOnLift() === true, "isOnLift() reflects lift proximity even with zero alertable corridors loaded");

  const farAway = trackPoint(50, 500); // 500m east — well outside LIFT_SUPPRESS_PAD_M
  cg.tick({ lat: farAway[0], lon: farAway[1], acc: 5, speed: 4, t: 1700000001000 }, 0);
  assert(cg.isOnLift() === false, "isOnLift() clears once away from the lift line");
})();

(function testIsOnLiftResetsOnUnload(){
  const cg = freshChuteGuard();
  const lift = makeCorridor("lift1", { lenM: 400, widthM: 10, runType: "lift" });
  cg.load([lift], {});
  const onLine = trackPoint(50, 0);
  cg.tick({ lat: onLine[0], lon: onLine[1], acc: 5, speed: 4, t: 1700000000000 }, 0);
  assert(cg.isOnLift() === true, "sanity check: on the lift before unload");
  cg.unload();
  assert(cg.isOnLift() === false, "unload() resets isOnLift() to false");
})();

// ============================================================
// 24. getActiveAlarm(isEligible) — additive optional filter (2026-09-20),
// added for "press and hold a chute on the map to arm/disarm just that
// one" (Corridor Guard per-chute selection). Must be applied INSIDE the
// scan across corridors, not as a post-hoc check on the single already-
// selected `best` — this function only ever returns the one loudest
// currently-alerting corridor, so a post-hoc filter would wrongly report
// "no alarm" whenever an ELIGIBLE corridor is alerting alongside a louder
// INELIGIBLE one. Omitting the argument entirely must behave exactly as
// before (every corridor eligible) — proven by every one of the 98 other
// tests in this file, none of which pass an argument, still passing.
// ============================================================
(function testGetActiveAlarmEligibilityFilter(){
  const cg = freshChuteGuard();
  // Both corridors share the exact same centerline (makeCorridor always
  // starts at the same START heading north) but different widths, so a
  // single drifted-lateral position is simultaneously outside both, at
  // different excess/level — "louder" (narrower) always outranks "quieter"
  // (wider) when nothing is filtered.
  const louder = makeCorridor("louder", { lenM: 400, widthM: 10 });  // halfW=5,  edge=5.5
  const quieter = makeCorridor("quieter", { lenM: 400, widthM: 40 }); // halfW=20, edge=20.5
  cg.load([louder, quieter], {});

  const t0 = 1700000000000;
  let forwardM = 0, t = 0;
  function tick(lateralM){
    const pos = trackPoint(forwardM, lateralM);
    cg.tick({ lat: pos[0], lon: pos[1], acc: 5, speed: 1.5, t: t0 + t }, 0);
    forwardM += 1.5; t += 1000;
  }
  for (let i = 0; i <= 50; i++) tick(0); // cover phase — both corridors share this centerline, so both get everInside=true

  tick(25); // excess: louder=19.5 (ladder -> level 2), quieter=4.5 (ladder -> level 1)
  const unfiltered = cg.getActiveAlarm();
  assert(unfiltered && unfiltered.corridorId === "louder", "sanity check: with no filter, the louder (higher-level) corridor wins");

  const eligibleQuieterOnly = cg.getActiveAlarm(id => id === "quieter");
  assert(eligibleQuieterOnly !== null, "an eligible corridor that IS alerting must still be reported even though a louder INELIGIBLE one is also alerting");
  assert(eligibleQuieterOnly && eligibleQuieterOnly.corridorId === "quieter", "the filtered call reports the eligible corridor, not the excluded louder one");

  const eligibleLouderOnly = cg.getActiveAlarm(id => id === "louder");
  assert(eligibleLouderOnly && eligibleLouderOnly.corridorId === "louder", "filtering to just the louder corridor still reports it normally");

  assert(cg.getActiveAlarm(id => id === "nonexistent") === null, "no alarm when the filter matches no currently-alerting corridor");
  assert(cg.getActiveAlarm(() => false) === null, "a filter that excludes everything reports no alarm at all");
})();

// ---------------------------------------------------------------------------
// 24. Responsive (fused) path, 2026-09-21 ("2s is not acceptable"). When the
// host passes fix.velE/velN (the phone's Doppler velocity) with a RAW
// position, the guard fuses them, looks ahead RESP_LEAD_S, and decides the
// tone from the predicted position -- so it reacts BETWEEN 1 Hz fixes. A
// controllable clock replaces the busy-waits used elsewhere in this file.
// ---------------------------------------------------------------------------
function freshChuteGuardClock() {
  let clock = 1700000000000;
  const sandbox = { console, window: {}, Date: { now: () => clock } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../frontend/chute-guard.js"), "utf8"), sandbox);
  return { cg: sandbox.window.ChuteGuard, advance: ms => { clock += ms; }, now: () => clock };
}
// a 4 m wide north-south corridor (edge = 2.0 + 0.5 = 2.5 m from the centreline)
function respSetup() {
  const { cg, advance, now } = freshChuteGuardClock();
  cg.load([makeCorridor("r1", { lenM: 400, widthM: 4 })], {});
  const tickAt = (fwd, lat, velE, velN, extra) => {
    const p = trackPoint(fwd, lat);
    cg.tick(Object.assign({ lat: p[0], lon: p[1], acc: 5, speed: Math.hypot(velE, velN), t: now(), velE, velN }, extra || {}), 0);
  };
  return { cg, advance, tickAt };
}

(function testResponsiveAlarmStartsBetweenFixes() {
  const { cg, advance, tickAt } = respSetup();
  // walking north along the centreline at 1.5 m/s: establish "been inside"
  for (let i = 0; i < 5; i++) { tickAt(20 + i * 1.5, 0, 0, 1.5); advance(1000); }
  assert(cg.getActiveAlarm() === null, "responsive: inside the corridor, no alarm");
  // a fix at 2.0 m east, now moving east at 2 m/s (stepping out). The fusion pulls a fix only
  // halfway (K=0.5) against where the estimate was 0.3 s ago: fused = 0 + 0.5*(2.0 - (0 - 2*0.3)) = 1.3 m.
  tickAt(28, 2.0, 2, 0);
  assert(cg.getActiveAlarm() === null, "responsive: fused 1.3 m + 0.4 s look-ahead (predicts 2.1 m) is not yet past the 2.5 m edge");
  // ...but 300 ms later, with NO new fix, the prediction (1.3 + 2*(0.3+0.4) = 2.7 m) is past it
  advance(300);
  const a = cg.getActiveAlarm();
  assert(a && a.corridorId === "r1", "responsive: the alarm starts BETWEEN fixes once the look-ahead position crosses the edge, without waiting for the next 1 Hz fix");
})();

(function testResponsiveAlarmStopsBetweenFixes() {
  const { cg, advance, tickAt } = respSetup();
  for (let i = 0; i < 5; i++) { tickAt(20 + i * 1.5, 0, 0, 1.5); advance(1000); }
  tickAt(28, 4, 2, 0); advance(1000); tickAt(29.5, 4.5, 2, 0);   // clearly out, moving away
  assert(cg.getActiveAlarm() !== null, "sanity: alarm on while outside and moving away");
  tickAt(31, 3.5, -2, 0);                                        // a fix 3.5 m out, now heading back at 2 m/s
  assert(cg.getActiveAlarm() !== null, "responsive: 3.5 m out returning at 2 m/s (predicts 2.7 m) is still past the edge");
  advance(300);                                                   // 3.5 - 2*(0.3+0.4) = 2.1 m -> back inside
  assert(cg.getActiveAlarm() === null, "responsive: the alarm STOPS between fixes as soon as the look-ahead position is back inside (the old path took 2-4 s)");
})();

(function testResponsiveNeverAlarmsBeforeEverInside() {
  const { cg, advance, tickAt } = respSetup();
  // approaching from outside and never having been inside: no approach ping, even predicted
  tickAt(20, 6, -3, 0); advance(300);
  assert(cg.getActiveAlarm() === null, "responsive: still no approach ping for a corridor never entered");
})();

(function testResponsiveFusionSmoothsANoisyFix() {
  const { cg, advance, tickAt } = respSetup();
  const seen = [];
  cg.load([makeCorridor("r1", { lenM: 400, widthM: 4 })], { onDebug: (id, name, d) => seen.push(d) });
  for (let i = 0; i < 4; i++) { tickAt(20 + i * 1.5, 0, 0, 1.5); advance(1000); }
  tickAt(26, 5, 0, 1.5);                                          // a single 5 m GPS outlier while truly still on the line
  const last = seen[seen.length - 1];
  const fusedLatOffsetM = Math.abs(last.distM);
  assert(last.responsive === true, "debug reports the responsive path");
  assert(fusedLatOffsetM < 4, "an isolated 5 m outlier is pulled roughly halfway back by the fusion gain, not swallowed whole, got " + fusedLatOffsetM.toFixed(2));
})();

(function testNoVelocityMeansExactlyTheOldBehaviour() {
  const { cg, advance } = freshChuteGuardClock();
  cg.load([makeCorridor("r2", { lenM: 400, widthM: 4 })], {});
  const p0 = trackPoint(20, 0), p1 = trackPoint(21, 3.2);
  cg.tick({ lat: p0[0], lon: p0[1], acc: 5, speed: 1.5, t: 1 }, 0); advance(1000);
  cg.tick({ lat: p1[0], lon: p1[1], acc: 5, speed: 1.5, t: 1001 }, 0);
  const a = cg.getActiveAlarm();
  assert(a && a.corridorId === "r2", "no fix.velE/velN -> the fix is used exactly as given (3.2 m out is outside the 2.5 m edge)");
})();



// ---------------------------------------------------------------------------
// 25. Offset cancelling (2026-09-21, 4 m bike path). While moving and clearly
// on the corridor, the guard learns the slowly-varying lateral offset between
// GPS and the authored centreline and subtracts it, so only a departure
// RELATIVE to that baseline alarms. Responsive (velocity-supplying) path only.
// ---------------------------------------------------------------------------
function biasSetup() {
  const { cg, advance, now } = freshChuteGuardClock();
  const dbg = [];
  cg.load([makeCorridor("b1", { lenM: 900, widthM: 4 })], { onDebug: (id, n, d) => dbg.push(d) });
  let fwd = 20;
  // one 1 Hz fix riding north at `speed`, GPS reading `lateral` m east of the centreline, moving east at velE
  const rideAt = (lateral, speed, velE) => {
    const p = trackPoint(fwd, lateral);
    cg.tick({ lat: p[0], lon: p[1], acc: 5, speed, t: now(), velE: velE || 0, velN: speed }, 0);
    fwd += speed; advance(1000);
  };
  return { cg, dbg, rideAt, advance };
}

(function testConstantGpsOffsetIsLearnedAndStopsAlarming() {
  const { cg, dbg, rideAt } = biasSetup();
  rideAt(0, 5); rideAt(0, 5); rideAt(0, 5);                   // genuinely on the line first (everInside)
  for (let i = 0; i < 3; i++) rideAt(3.4, 5);                  // GPS now reads a constant 3.4 m off: past the 2.5 m edge
  assert(cg.getActiveAlarm() !== null, "before it has learned anything, a constant 3.4 m reading is past the 2.5 m edge and alarms");
  for (let i = 0; i < 150; i++) rideAt(3.4, 5);                // 2.5 minutes of riding with that same offset
  assert(cg.getActiveAlarm() === null, "after riding with a constant offset it is learned and no longer alarms");
  const last = dbg[dbg.length - 1];
  assert(Math.abs(last.biasM) > 2.5 && Math.abs(last.biasM) <= 3.0001, "the learned offset approaches (and never exceeds) the 3 m cap, got " + last.biasM.toFixed(2));
})();

(function testRealDepartureStillAlarmsFromTheLearnedBaseline() {
  const { cg, rideAt } = biasSetup();
  rideAt(0, 5); rideAt(0, 5); rideAt(0, 5);
  for (let i = 0; i < 150; i++) rideAt(3.4, 5);
  assert(cg.getActiveAlarm() === null, "sanity: offset learned, quiet");
  rideAt(7.0, 5, 2); rideAt(7.4, 5, 2);                        // steps a further ~4 m sideways, still moving east
  assert(cg.getActiveAlarm() !== null, "a real ~4 m departure from the learned baseline alarms within two fixes");
})();

(function testNeverLearnsWhileClearlyOutside() {
  const { cg, dbg, rideAt } = biasSetup();
  rideAt(0, 5); rideAt(0, 5); rideAt(0, 5);
  for (let i = 0; i < 4; i++) rideAt(5.0, 5);                  // 5 m off: outside the learning gate
  assert(cg.getActiveAlarm() !== null, "a 5 m offset alarms (it is not absorbed)");
  for (let i = 0; i < 40; i++) rideAt(5.0, 5);                 // (the guard later goes quiet on a held offset by its own deliberate-departure rule)
  assert(Math.abs(dbg[dbg.length - 1].biasM) < 0.3, "an offset beyond the learning gate is never absorbed (only the brief fusion ramp-up is), got " + dbg[dbg.length - 1].biasM);
})();

(function testNoLearningWhileStationary() {
  const { dbg, rideAt } = biasSetup();
  rideAt(0, 5); rideAt(0, 5); rideAt(0, 5);
  for (let i = 0; i < 90; i++) rideAt(2.0, 0.2);               // standing near the edge
  assert(dbg[dbg.length - 1].biasM === 0, "standing still near the edge never shifts the baseline, got " + dbg[dbg.length - 1].biasM);
})();

(function testOffsetCancellingIsInertWithoutVelocity() {
  const { cg, advance, now } = freshChuteGuardClock();
  cg.load([makeCorridor("b2", { lenM: 900, widthM: 4 })], {});
  let fwd = 20;
  const plain = lat => { const p = trackPoint(fwd, lat); cg.tick({ lat: p[0], lon: p[1], acc: 5, speed: 5, t: now() }, 0); fwd += 5; advance(1000); };
  plain(0); plain(0); plain(0);
  for (let i = 0; i < 8; i++) plain(3.4);
  assert(cg.getActiveAlarm() !== null, "without fix.velE/velN nothing is learned or cancelled: a constant 3.4 m offset keeps alarming, exactly as before");
})();

// ============================================================
// Drop-in gate (2026-10-07, user: "guard tone ... only after 10 % of the runs vertical from top
// has been skied. crossing a chute midway should not sound the guard tone"). Chutes only.
// The fixture chute runs north from START (its top) for 400 m: top zone = first 40 m, 10 % = 40 m.
// ============================================================
(function testChuteDropInGate() {
  const down = (from, to, lat = 0, t0 = 0) => { const st = []; for (let f = from, i = 0; f <= to; f += 5, i++) st.push({ forwardM: f, lateralM: lat, speed: 5, t: t0 + i * 1000 }); return st; };
  const out = (fwd, t0) => [8, 12, 16].map((lat, i) => ({ forwardM: fwd + i * 5, lateralM: lat, speed: 5, t: t0 + i * 1000 }));
  const chute = o => makeCorridor("d1", Object.assign({ runType: "chute", lenM: 400, widthM: 10 }, o));
  const T = freshChuteGuard().TUNING;
  assert(T.DROPIN_PCT === 0.10 && T.DROPIN_RUN_TYPES.length === 1 && T.DROPIN_RUN_TYPES[0] === "chute", "drop-in gate: 10 %, chutes only");

  let cg = freshChuteGuard();
  let ev = drive(cg, chute(), down(0, 60).concat(out(65, 13000)));
  assert(ev.warn.length > 0, "dropped in at the top and skied past 10 %: leaving the chute sounds the tone");

  cg = freshChuteGuard();
  ev = drive(cg, chute(), down(0, 30).concat(out(35, 7000)));
  assert(ev.warn.length === 0, "left before 10 % from the top: no tone");

  cg = freshChuteGuard();
  const cross = [-30, -20, -10, 0, 10, 20, 30].map((lat, i) => ({ forwardM: 200, lateralM: lat, speed: 5, headingDeg: 90, t: i * 1000 }));
  ev = drive(cg, chute(), cross);
  assert(ev.warn.length === 0 && cg.getActiveAlarm() === null, "crossing a chute midway: no tone");
  assert(ev.debug.some(d => d.everInside && d.dropIn === "no"), "the debug line shows why (dropIn: no)");

  cg = freshChuteGuard();
  ev = drive(cg, chute(), down(200, 300).concat(out(305, 21000)));
  assert(ev.warn.length === 0, "joining a chute midway and skiing down it: still no tone on that pass");

  cg = freshChuteGuard();
  ev = drive(cg, makeCorridor("r1", { runType: "run", lenM: 400, widthM: 10 }), cross);
  assert(ev.warn.length > 0, "a run crossed midway alerts as before in a host that doesn't ask (walking / biking corridors)");

  // Ridge Quest asks for runs too (2026-10-07, user: "do runs also"): load(..., { dropInRuns:true })
  const driveRuns = (corridor, steps) => {
    const g = freshChuteGuard(), warn = [];
    g.load([corridor], { onWarn: (id) => warn.push(id) }, { dropInRuns: true });
    steps.forEach(s => { const p = trackPoint(s.forwardM, s.lateralM);
      g.tick({ lat: p[0], lon: p[1], acc: 5, speed: s.speed, t: 1700000000000 + s.t }, s.headingDeg !== undefined ? s.headingDeg : 0); });
    return { warn, alarm: g.getActiveAlarm() };
  };
  const run = () => makeCorridor("r2", { runType: "run", lenM: 400, widthM: 10 });
  let rr = driveRuns(run(), cross);
  assert(rr.warn.length === 0 && rr.alarm === null, "Ridge Quest: a run crossed midway is silent too");
  rr = driveRuns(run(), down(0, 60).concat(out(65, 13000)));
  assert(rr.warn.length > 0, "Ridge Quest: a run skied from the top past 10 % alerts when left");
  rr = driveRuns(makeCorridor("h1", { runType: "hike", lenM: 400, widthM: 10 }), cross);
  assert(rr.warn.length > 0, "Ridge Quest: a boot pack is not gated");
  const rqSrc = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");
  const feSrc = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8");
  assert(/ChuteGuard\.load\(chuteGuardZonesFor\(Quest\.corridors\), chuteGuardCallbacks\(\), \{ dropInRuns:true \}\)/.test(rqSrc), "ridge-quest.html asks for runs too");
  assert((feSrc.match(/ChuteGuard\.load\(simBundle\.zones, chuteGuardCallbacks\(\), \{ dropInRuns:_questOn \}\)/g) || []).length === 3
    && !/ChuteGuard\.load\(simBundle\.zones, chuteGuardCallbacks\(\)\)/.test(feSrc), "Test Mode asks for runs too in a Ridge Quest workspace (all 3 load sites)");

  // drawn bottom-to-top: the top is the END of the line (forward 400)
  const up = () => { const c = chute(); Object.assign(c.layers[0].geometry, { climbM: 300, descentM: 0 }); return c; };
  const desc = (from, to) => { const st = []; for (let f = from, i = 0; f >= to; f -= 5, i++) st.push({ forwardM: f, lateralM: 0, speed: 5, headingDeg: 180, t: i * 1000 }); return st; };
  cg = freshChuteGuard();
  ev = drive(cg, up(), desc(400, 340).concat(out(330, 13000)));
  assert(ev.warn.length > 0, "chute drawn bottom-to-top: dropping in at its high end arms the tone");
  cg = freshChuteGuard();
  ev = drive(cg, up(), down(0, 60).concat(out(65, 13000)));
  assert(ev.warn.length === 0, "...and its low end does not");

  // going away resets it: the next pass must drop in again
  cg = freshChuteGuard();
  const away = [{ forwardM: 100, lateralM: 300, speed: 5, t: 20000 }];
  ev = drive(cg, chute(), down(0, 60).concat(away, cross.map(s => Object.assign({}, s, { t: s.t + 30000 }))));
  assert(ev.warn.length === 0, "after leaving the area, a later midway crossing is silent again");
})();

// ============================================================
// Riding a lift vs skiing under it (2026-10-07, user: "runs under lifts have to have voice and
// guards. the lift is canceling out voice"). A lift whose uphill direction is known only counts
// while the rider is carried UP it. The fixture lift lies on the chute's own line and is drawn
// top-to-bottom (descentM > climbM), so up the lift = toward START = forwardM falling.
// ============================================================
(function testRidingALiftVsSkiingUnderIt() {
  const liftOver = () => { const l = makeCorridor("lift1", { lenM: 400, widthM: 10, runType: "lift" });
    Object.assign(l.layers[0].geometry, { climbM: 0, descentM: 300 }); return l; };
  const setup = () => { const g = freshChuteGuard(), warn = [];
    g.load([makeCorridor("c1", { runType: "chute", lenM: 400, widthM: 10 }), liftOver()], { onWarn: id => warn.push(id) });
    let t = 1700000000000;
    const go = (fwd, lat, speed, dtS) => { const p = trackPoint(fwd, lat); t += (dtS || 1) * 1000; g.tick({ lat: p[0], lon: p[1], acc: 5, speed, t }, 0); return g.isOnLift(); };
    return { g, warn, go }; };

  // skiing the chute under the lift, top to bottom, then leaving it sideways
  let s = setup(), everOn = false;
  for (let f = 0; f <= 200; f += 8) everOn = s.go(f, 0, 8) || everOn;
  assert(!everOn, "skiing down under a lift is not a lift ride");
  [8, 14, 20].forEach((lat, i) => s.go(208 + i * 8, lat, 8));
  assert(s.warn.length > 0 && s.g.getActiveAlarm() !== null, "a chute under a lift keeps its guard tone");

  // riding up the lift over the chute
  s = setup(); let onAt = null;
  for (let f = 300; f >= 100; f -= 5) { if (s.go(f, 0, 5) && onAt == null) onAt = 300 - f; }
  assert(onAt !== null && onAt >= 30 && onAt <= 40, "carried up the lift: on the lift after ~30 m, got " + onAt);
  assert(s.warn.length === 0 && s.g.getActiveAlarm() === null, "riding the lift over a chute: no tone");
  // ...the lift stops for a minute: still on it
  assert(s.go(100, 0, 0, 60) === true, "a stopped lift is still a lift ride");
  // ...then skiing back down under it ends the ride after 30 m
  let offAt = null;
  for (let f = 105; f <= 160; f += 5) { if (!s.go(f, 0, 5) && offAt == null) offAt = f - 100; }
  assert(offAt >= 30 && offAt <= 35, "~30 m back down the line ends the ride, got " + offAt);

  // leaving the lift's band ends the ride at once
  s = setup();
  for (let f = 300; f >= 200; f -= 5) s.go(f, 0, 5);
  assert(s.g.isOnLift() === true && s.go(195, 80, 5) === false, "leaving the lift line ends the ride");

  // walking up beside the lift (a boot pack pace) is not a ride
  s = setup(); everOn = false;
  for (let f = 300; f >= 200; f -= 1) everOn = s.go(f, 0, 1) || everOn;
  assert(!everOn, "climbing at walking pace under a lift is not a lift ride");

  // a lift with no elevation in the bundle keeps the old rule: near it = on it
  const g = freshChuteGuard();
  g.load([makeCorridor("c1", { lenM: 400 }), makeCorridor("lift1", { lenM: 400, runType: "lift" })], {});
  const p = trackPoint(100, 0); g.tick({ lat: p[0], lon: p[1], acc: 5, speed: 8, t: 1700000000000 }, 0);
  assert(g.isOnLift() === true, "lift with unknown direction: near = on (unchanged)");

  // a reload mid-ride (Ridge Quest reloads on every Home render) keeps the ride
  s = setup();
  for (let f = 300; f >= 200; f -= 5) s.go(f, 0, 5);
  s.g.load([makeCorridor("c1", { runType: "chute", lenM: 400, widthM: 10 }), liftOver()], {});
  assert(s.go(195, 0, 5) === true, "load() mid-ride keeps the ride");
})();

// ============================================================
// Finished at 80 % (2026-10-08, user: "when a skier has completed from top to bottom 80% of a chute
// or run sound a victory chime and stop the guard warning for that chute allowing skier to exit
// chute with no warning"). The fixture runs north from START (its top) for 400 m: 80 % = 320 m.
// ============================================================
(function testFinishedAt80PctChimesAndStopsTheGuard() {
  const T = freshChuteGuard().TUNING;
  assert(T.FINISH_PCT === 0.80, "finished = 80 % down from the top");
  const setup = (runType, opts) => { const g = freshChuteGuard(), warn = [], done = [], dbg = [];
    g.load([makeCorridor("f1", { runType, lenM: 400, widthM: 10 })],
      { onWarn: id => warn.push(id), onComplete: (id, name, info) => done.push(Object.assign({ id, name }, info)), onDebug: (id, n, d) => dbg.push(d) }, opts);
    let t = 1700000000000;
    const go = (fwd, lat) => { const p = trackPoint(fwd, lat || 0); t += 1000; g.tick({ lat: p[0], lon: p[1], acc: 5, speed: 5, t }, 0); };
    const down = (from, to) => { for (let f = from; f <= to; f += 5) go(f, 0); };
    const exit = fwd => [8, 12, 16, 20].forEach((lat, i) => go(fwd + i * 5, lat));
    return { g, warn, done, dbg, go, down, exit }; };

  // top to 80 %: one chime, then leaving sideways is silent
  let s = setup("chute");
  s.down(0, 315);
  assert(s.done.length === 0, "no chime at 79 %");
  s.down(320, 330);
  assert(s.done.length === 1 && s.done[0].id === "f1" && s.done[0].pct === 0.80, "one chime on reaching 80 %, got " + s.done.length);
  s.exit(335);
  assert(s.warn.length === 0 && s.g.getActiveAlarm() === null, "finished: leaving the chute sounds no tone");
  assert(s.dbg.some(d => d.dropIn === "done"), "the debug line says done");
  s.go(360, 0); s.go(380, 0); s.exit(385);
  assert(s.done.length === 1 && s.warn.length === 0, "back in and out again on the same pass: still one chime, still silent");

  // leaving before 80 % still warns
  s = setup("chute");
  s.down(0, 300); s.exit(305);
  assert(s.done.length === 0 && s.warn.length > 0 && s.g.getActiveAlarm() !== null, "left at 75 %: tone as before, no chime");
  // ...and coming back in to finish it still earns the chime and ends the tone
  s.down(320, 325);
  assert(s.done.length === 1 && s.g.getActiveAlarm() === null, "back inside past 80 %: chime, tone over");

  // not skied from the top: no chime
  s = setup("chute");
  s.down(200, 380);
  assert(s.done.length === 0, "joined midway and skied to the bottom: not a top-to-bottom pass, no chime");
  s = setup("chute");
  [-30, -20, -10, 0, 10, 20, 30].forEach(lat => s.go(350, lat));
  assert(s.done.length === 0, "crossing the bottom of a chute: no chime");

  // the next lap is guarded again
  s = setup("chute");
  s.down(0, 330); s.go(330, 300);            // away (out of relevant range)
  s.down(0, 100); s.exit(105);
  assert(s.done.length === 1 && s.warn.length > 0, "after leaving the area the next pass is guarded again");

  // runs: Ridge Quest only (same opt-in as the drop-in gate); other hosts unchanged; boot packs never
  s = setup("run", { dropInRuns: true });
  s.down(0, 330); s.exit(335);
  assert(s.done.length === 1 && s.warn.length === 0, "Ridge Quest: a run finishes the same way");
  s = setup("run");
  s.down(0, 330); s.exit(335);
  assert(s.done.length === 0 && s.warn.length > 0, "a run in a host that didn't ask: no chime, guard to the end");
  s = setup("hike", { dropInRuns: true });
  s.down(0, 330); s.exit(335);
  assert(s.done.length === 0 && s.warn.length > 0, "a boot pack never finishes this way");

  // the chime: four rising notes on the host's context, none on a warning-tone pitch
  const notes = [];
  const ctx = { currentTime: 0, destination: {},
    createOscillator: () => { const o = { frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; notes.push(o); return o; },
    createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }) };
  const cg = freshChuteGuard();
  assert(cg.playChime(ctx, ctx.destination, 0.5) === true && notes.length === 4, "chime = 4 notes");
  const f = notes.map(n => n.frequency.value);
  assert(f.every((x, i) => i === 0 || x > f[i - 1]) && !f.includes(740) && !f.includes(1046), "rising, and not the warning pitches: " + f.join(","));
  assert(cg.playChime(null) === false, "no audio context: no throw");

  // both hosts play it, only for a guarded chute/run
  const rq = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");
  const fe = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8");
  assert(/onComplete\(corridorId, name, info\)\{\s*if\(!Quest\.isGuarded\(corridorId\)\) return;[\s\S]{0,400}playCgChime\(\);/.test(rq), "ridge-quest.html: chime for a guarded chute/run");
  assert(/ChuteGuard\.playChime\(_cgAc, _cgMaster\|\|_cgAc\.destination/.test(rq), "ridge-quest.html plays the shared chime on the primed context");
  assert(/onComplete\(corridorId,name,info\)\{\s*if\(!_cgTestGuarded\(corridorId\)\) return;[\s\S]{0,200}ChuteGuard\.playChime\(SimVoice\.ctx/.test(fe), "Test Mode plays the same chime");
})();

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
