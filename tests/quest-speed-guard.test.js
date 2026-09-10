// Unit tests for Ridge Quest's "eyes up" moving-speed screen guard
// (SpeedGuard in frontend/ridge-quest.html) — the safety lockout that blanks
// the screen while the player is moving and restores it once they've been
// stopped for a few seconds.
//
// Extracts the real SpeedGuard object literal straight out of the shipped
// file via the same regex + `new Function` pattern as
// tests/quest-checkpoint-vertical.test.js. Free variables it closes over in
// the real <script> scope (QUEST_TUNING, QGeo, Quest, IS_SIM_MODE, location,
// URLSearchParams, navigator, document, rqToast) are injected as params;
// _show/_hide/_render are stubbed with counters so no DOM is needed. All
// timing is driven off fix `p.t`, never Date.now / setTimeout.
//
// Run: `node tests/quest-speed-guard.test.js` (or as part of the full
// `node --test tests/` suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");

const qgeoM = html.match(/const QGeo = \{[\s\S]*?\n\};/);
if (!qgeoM) { console.log("FAIL: could not extract QGeo"); process.exit(1); }
const QGeo = eval("(" + qgeoM[0].replace(/^const QGeo = /, "").replace(/;$/, "") + ")");

const tuningM = html.match(/const QUEST_TUNING = \{[\s\S]*?\n\};/);
if (!tuningM) { console.log("FAIL: could not extract QUEST_TUNING"); process.exit(1); }
const QUEST_TUNING = eval("(" + tuningM[0].replace(/^const QUEST_TUNING = /, "").replace(/;$/, "") + ")");

const guardM = html.match(/const SpeedGuard = \{[\s\S]*?\n\};/);
if (!guardM) { console.log("FAIL: could not extract SpeedGuard from ridge-quest.html"); process.exit(1); }
const guardSrc = "return " + guardM[0].replace(/^const SpeedGuard = /, "").replace(/;$/, "");
// eslint-disable-next-line no-new-func
const makeGuardFn = new Function(
  "QUEST_TUNING", "QGeo", "Quest", "IS_SIM_MODE", "location", "URLSearchParams", "navigator", "document", "rqToast",
  guardSrc
);

function extractMethodBody(startTag) {
  const startIdx = html.indexOf(startTag);
  if (startIdx < 0) throw new Error("could not find " + startTag);
  let depth = 0, i = html.indexOf("{", startIdx);
  const bodyStart = i + 1;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(bodyStart, i);
}

const noopDoc = {
  getElementById: () => null,
  createElement: () => ({ setAttribute() {}, classList: { add() {}, remove() {} }, set innerHTML(_) {} }),
  body: { appendChild() {} }
};

// Build a fresh SpeedGuard with instrumented _show/_hide/_render and a
// captured vibrate/toast log.
function mk(opts) {
  opts = opts || {};
  const log = { show: 0, hide: 0, render: 0, vibrate: 0, toasts: [] };
  const g = makeGuardFn(
    QUEST_TUNING, QGeo,
    opts.Quest || { corridors: [] },
    !!opts.IS_SIM_MODE,
    { search: opts.search || "" },
    URLSearchParams,
    { vibrate: () => { log.vibrate++; } },
    noopDoc,
    (m) => { log.toasts.push(m); }
  );
  g._show = function () { log.show++; };
  g._hide = function () { log.hide++; };
  g._render = function () { log.render++; };
  return { g, log };
}

const T0 = 1_700_000_000_000;
function fix(speed, tOffMs, lat, lon) {
  return { speed, t: T0 + (tOffMs || 0), lat: lat == null ? 51.305 : lat, lon: lon == null ? -117.05 : lon };
}
const DWELL = QUEST_TUNING.SPEED_GUARD_CLEAR_DWELL_MS;

/* ---- basic block / clear ---- */

(function testFirstFixZeroDoesNotBlock() {
  const { g, log } = mk();
  g.consider(fix(0, 0));
  assert(!g._blocked && log.show === 0, "first fix at speed 0 does not blank");
})();

(function testSingleFastFixBlocksWithVibrate() {
  const { g, log } = mk();
  g.consider(fix(1.0, 0)); // > BLOCK 0.7
  assert(g._blocked === true, "one fix over BLOCK_MPS blanks immediately");
  assert(log.show === 1, "_show called once, got " + log.show);
  assert(log.vibrate === 1, "vibrate fired once on the transition, got " + log.vibrate);
})();

(function testBetweenThresholdsStaysBlocked() {
  const { g } = mk();
  g.consider(fix(1.0, 0));
  g.consider(fix(0.6, 2000)); // between CLEAR (0.5) and BLOCK (0.7)
  assert(g._blocked === true && g._clearSince === null, "speed between CLEAR and BLOCK holds the blank and doesn't start the dwell");
})();

(function testDwellNotYetElapsed() {
  const { g, log } = mk();
  g.consider(fix(1.0, 0));
  g.consider(fix(0.2, 1000));
  g.consider(fix(0.2, 1000 + DWELL - 1)); // just under the dwell
  assert(g._blocked === true && log.hide === 0, "still blocked before the clear-dwell fully elapses");
})();

(function testDwellElapsedUnblocks() {
  const { g, log } = mk();
  g.consider(fix(1.0, 0));
  g.consider(fix(0.2, 1000));
  g.consider(fix(0.2, 1000 + DWELL)); // dwell satisfied
  assert(g._blocked === false && log.hide === 1, "screen restores after DWELL continuously under CLEAR, got blocked=" + g._blocked + " hide=" + log.hide);
})();

(function testDwellResetByAFastFix() {
  const { g } = mk();
  g.consider(fix(1.0, 0));
  g.consider(fix(0.2, 1000));
  g.consider(fix(0.2, 1000 + 3000));  // 3s of stillness
  g.consider(fix(0.6, 1000 + 3500));  // one qualifying fix -> resets
  g.consider(fix(0.2, 1000 + 4000));  // dwell restarts here
  g.consider(fix(0.2, 1000 + 4000 + DWELL - 1));
  assert(g._blocked === true, "a mid-dwell fast fix resets the clear-dwell — needs a fresh full DWELL");
  g.consider(fix(0.2, 1000 + 4000 + DWELL));
  assert(g._blocked === false, "clears once the restarted dwell completes");
})();

(function testFailSafeNoFixesStaysBlocked() {
  const { g, log } = mk();
  g.consider(fix(1.0, 0));
  // ...no further consider() calls...
  assert(g._blocked === true && log.hide === 0, "with no fresh fixes the blank stays up (fail-safe)");
})();

(function testVibrateOnlyOncePerBlock() {
  const { g, log } = mk();
  g.consider(fix(1.0, 0));
  g.consider(fix(2.0, 1000));
  g.consider(fix(3.0, 2000));
  assert(log.vibrate === 1, "vibrate only fires on the block transition, not every fast fix, got " + log.vibrate);
})();

/* ---- fix-gap discontinuity ---- */

(function testFixGapResetsDwell() {
  const { g } = mk();
  g.consider(fix(1.0, 0));
  g.consider(fix(0.2, 1000)); // dwell starts
  // huge gap (backgrounded tab): next slow fix must NOT instantly satisfy the dwell
  g.consider(fix(0.2, 1000 + QUEST_TUNING.SPEED_GUARD_MAX_FIX_GAP_MS + 1));
  assert(g._blocked === true, "a fix gap over MAX_FIX_GAP_MS resets the dwell instead of instantly clearing");
  g.consider(fix(0.2, 1000 + QUEST_TUNING.SPEED_GUARD_MAX_FIX_GAP_MS + 1 + DWELL));
  assert(g._blocked === false, "clears after a fresh full DWELL of continuous fixes post-gap");
})();

/* ---- sim-mode gating ---- */

(function testSimModeInertWithoutGuardParam() {
  const { g, log } = mk({ IS_SIM_MODE: true, search: "?sim=1" });
  g.consider(fix(5, 0));
  assert(!g._blocked && log.show === 0, "?sim=1 without &guard=1 keeps the guard inert (sim-walk verification stays usable)");
})();

(function testSimModeActiveWithGuardParam() {
  const { g } = mk({ IS_SIM_MODE: true, search: "?sim=1&guard=1" });
  g.consider(fix(5, 0));
  assert(g._blocked === true, "?sim=1&guard=1 exercises the guard");
})();

(function testRealUserAlwaysGuarded() {
  const { g } = mk({ IS_SIM_MODE: false, search: "" });
  g.consider(fix(1.0, 0));
  assert(g._blocked === true, "a real user (no ?sim) is always guarded");
})();

(function testGuardZeroOptOut() {
  const { g, log } = mk({ IS_SIM_MODE: false, search: "?guard=0" });
  g.consider(fix(5, 0));
  assert(!g._blocked && log.show === 0, "?guard=0 disables the guard (escape hatch)");
})();

(function testMasterKillSwitchRespected() {
  // enabled() reads QUEST_TUNING.SPEED_GUARD_ENABLED — assert the shipped
  // default is true and that the check exists (source), not toggling the
  // shared object here.
  assert(QUEST_TUNING.SPEED_GUARD_ENABLED === true, "SPEED_GUARD_ENABLED defaults to true");
  assert(/SPEED_GUARD_ENABLED\s*===\s*false/.test(guardM[0]), "enabled() honours the SPEED_GUARD_ENABLED kill switch");
})();

/* ---- one-time toast ---- */

(function testOneTimeToast() {
  const { g, log } = mk();
  g.noteTrackingStarted();
  g.consider(fix(1.0, 0));            // block -> _maybeToast again
  g.consider(fix(0.2, 1000));
  g.consider(fix(0.2, 1000 + DWELL)); // unblock
  g.consider(fix(1.0, 20000));        // block again
  assert(log.toasts.length === 1, "the 'screen hides while moving' toast shows at most once per session, got " + log.toasts.length);
})();

/* ---- reset() ---- */

(function testResetClearsEverything() {
  const { g, log } = mk();
  g.consider(fix(1.0, 0));
  g.reset();
  assert(g._blocked === false && g._clearSince === null && g._lastT === null, "reset() clears all state");
  assert(log.hide === 1, "reset() hides the overlay");
})();

/* ---- bad input ---- */

(function testBadInputNoThrow() {
  const { g } = mk();
  let threw = false;
  try {
    g.consider(undefined);
    g.consider({ t: 1 });
    g.consider({ speed: NaN, t: 1 });
    g.consider({ speed: 1 });      // no t
  } catch (e) { threw = true; }
  assert(!threw && !g._blocked, "malformed fixes are ignored without throwing or changing state");
})();

/* ---- lift exemption ---- */

const liftCorridor = {
  runType: "lift", widthM: 20,
  path: [[51.310, -117.05], [51.300, -117.05]],
  ref: [51.305, -117.05]
};

(function testOnLiftAtSpeedNotBlocked() {
  const { g, log } = mk({ Quest: { corridors: [liftCorridor] } });
  g.consider(fix(3.0, 0, 51.305, -117.05)); // on the lift centreline, lift-cruise speed
  assert(!g._blocked && log.show === 0, "moving at lift speed ON a runType:'lift' corridor does not blank");
})();

(function testSameSpeedOffLiftBlocks() {
  const { g } = mk({ Quest: { corridors: [liftCorridor] } });
  g.consider(fix(3.0, 0, 51.305, -117.045)); // ~350 m east of the lift line
  assert(g._blocked === true, "the same speed away from any lift line still blanks");
})();

(function testWalkerOnLiftLineStillWarned() {
  const { g } = mk({ Quest: { corridors: [liftCorridor] } });
  g.consider(fix(1.0, 0, 51.305, -117.05)); // on the line but below LIFT_MIN_MPS (1.8)
  assert(g._blocked === true, "someone walking the lift line (below LIFT_MIN_MPS) is still warned");
})();

(function testBlockedThenBoardLiftClears() {
  const { g, log } = mk({ Quest: { corridors: [liftCorridor] } });
  g.consider(fix(2.0, 0, 51.305, -117.045));   // skiing into the load area -> blocked
  assert(g._blocked === true, "blocked on approach");
  g.consider(fix(3.0, 1000, 51.305, -117.05)); // now on the lift at cruise speed
  g.consider(fix(3.0, 1000 + DWELL, 51.305, -117.05));
  assert(g._blocked === false && log.hide >= 1, "riding the lift feeds the clear-dwell and restores the map");
})();

/* ---- source-shape assertions (over the shipped html) ---- */

(function testOnFixCallsGuardBeforeOffsite() {
  const body = extractMethodBody("_onFix(pos){");
  const iGuard = body.indexOf("SpeedGuard.consider");
  const iOff = body.search(/if\s*\(\s*Quest\._offsite\s*\)/); // the early-return guard, not the earlier comment
  assert(iGuard > -1, "_onFix calls SpeedGuard.consider");
  assert(iOff > -1 && iGuard < iOff, "_onFix calls SpeedGuard.consider BEFORE the if(Quest._offsite) early return");
})();

(function testStartStopHooks() {
  assert(/SpeedGuard\.noteTrackingStarted\(\)/.test(html), "Quest.start() calls SpeedGuard.noteTrackingStarted()");
  const stop = extractMethodBody("stop(){");
  assert(/SpeedGuard\.reset\(\)/.test(stop), "Quest.stop() calls SpeedGuard.reset()");
})();

(function testRenderFogMapOwnWatch() {
  const body = extractMethodBody("function renderFogMap(){");
  assert(/navigator\.geolocation\.watchPosition/.test(body), "renderFogMap starts its own watchPosition");
  assert(/SpeedGuard\.consider/.test(body), "renderFogMap's own watch feeds SpeedGuard");
  assert(/!Quest\.active\(\)/.test(body), "the map-only watch is guarded on !Quest.active()");
  assert(/clearWatch\(guardWatchId\)/.test(body), "the #fogBack teardown clears guardWatchId");
  assert(/SpeedGuard\.reset\(\)/.test(body), "the #fogBack teardown calls SpeedGuard.reset()");
})();

(function testTuningKeysPresent() {
  for (const k of ["SPEED_GUARD_ENABLED", "SPEED_GUARD_BLOCK_MPS", "SPEED_GUARD_CLEAR_MPS",
    "SPEED_GUARD_CLEAR_DWELL_MS", "SPEED_GUARD_MAX_FIX_GAP_MS", "SPEED_GUARD_LIFT_MIN_MPS"]) {
    assert(k in QUEST_TUNING, "QUEST_TUNING has " + k);
  }
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
