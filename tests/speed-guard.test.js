// Unit tests for the shared "eyes up" moving-speed screen guard,
// frontend/speed-guard.js (window.SpeedGuard) — used by ridge-quest.html,
// geofence-engine.html and field-recorder.html.
//
// Loads the real module the same way tests/kalman-filter.test.js loads
// kalman-filter.js: a vm context with a fake `window` (location / navigator
// / a minimal DOM). All timing is driven off fix `p.t`, never Date.now /
// setTimeout.
//
// Run: `node tests/speed-guard.test.js` (or `node --test "tests/**/*.test.js"`).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const SRC = fs.readFileSync(path.join(__dirname, "../frontend/speed-guard.js"), "utf8");

// ---- minimal fake DOM ----
function fakeNode(tag) {
  const classes = new Set();
  return {
    tagName: tag, id: "", _text: "", _html: "",
    style: {}, children: [],
    setAttribute() {}, getAttribute() { return null; },
    classList: {
      add(c) { classes.add(c); }, remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); }
    },
    appendChild(n) { this.children.push(n); if (n.id) DOC._byId[n.id] = n; return n; },
    querySelector() { return fakeNode("stub"); },
    set textContent(v) { this._text = v; }, get textContent() { return this._text; },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }
  };
}
let DOC;
function freshDoc() {
  DOC = {
    _byId: {},
    head: fakeNode("head"), body: fakeNode("body"), documentElement: fakeNode("html"),
    createElement(tag) { return fakeNode(tag); },
    getElementById(id) { return DOC._byId[id] || null; }
  };
  return DOC;
}

// ---- build a fresh SpeedGuard for each test (fresh module state) ----
function mk(opts) {
  opts = opts || {};
  const log = { vibrate: 0, notices: [] };
  const win = {
    location: { search: opts.search || "" },
    navigator: { vibrate: () => { log.vibrate++; } },
    document: freshDoc()
  };
  const sandbox = { console, window: win, URLSearchParams, setTimeout, clearTimeout };
  win.setTimeout = setTimeout; win.clearTimeout = clearTimeout;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const G = sandbox.window.SpeedGuard;
  G.configure(Object.assign(
    { onNotice: (t) => { log.notices.push(t); } },
    opts.cfg || {}
  ));
  return { G, log, doc: sandbox.window.document };
}

const DWELL = 4000;
function fix(speed, tOffMs, lat, lon) {
  const f = { speed, t: 1_700_000_000_000 + (tOffMs || 0) };
  if (lat != null) { f.lat = lat; f.lon = lon; }
  return f;
}
function overlayShown(doc) {
  const d = doc.getElementById("sgOverlay");
  return !!(d && d.classList.contains("show"));
}

/* ---- module shape ---- */
(function testExportShape() {
  const { G } = mk();
  for (const k of ["configure", "setExemptFn", "consider", "reset", "noteStarted", "blocked", "_internal"]) {
    assert(k in G, "SpeedGuard exposes " + k);
  }
  for (const k of ["speedOf", "haversineM", "CFG"]) assert(k in G._internal, "_internal exposes " + k);
})();

/* ---- basic block / clear ---- */
(function testFirstFixZeroNoBlock() {
  const { G, doc } = mk();
  G.consider(fix(0, 0));
  assert(!G.blocked() && !overlayShown(doc), "first fix at speed 0 does not blank");
})();

(function testSingleFastFixBlocks() {
  const { G, log, doc } = mk();
  G.consider(fix(1.0, 0));
  assert(G.blocked() === true && overlayShown(doc), "one fix over blockMps blanks immediately");
  assert(log.vibrate === 1, "one vibrate on the block transition, got " + log.vibrate);
})();

(function testBetweenThresholdsHolds() {
  const { G } = mk();
  G.consider(fix(1.0, 0));
  G.consider(fix(0.6, 2000)); // between clearMps (0.5) and blockMps (0.7)
  assert(G.blocked() === true, "speed between clear and block holds the blank");
})();

(function testDwellNotYet() {
  const { G, doc } = mk();
  G.consider(fix(1.0, 0));
  G.consider(fix(0.2, 1000));
  G.consider(fix(0.2, 1000 + DWELL - 1));
  assert(G.blocked() === true && overlayShown(doc), "still blocked before the dwell elapses");
})();

(function testDwellElapsedClears() {
  const { G, doc } = mk();
  G.consider(fix(1.0, 0));
  G.consider(fix(0.2, 1000));
  G.consider(fix(0.2, 1000 + DWELL));
  assert(G.blocked() === false && !overlayShown(doc), "restores after dwell continuously under clearMps");
})();

(function testDwellResetByFastFix() {
  const { G } = mk();
  G.consider(fix(1.0, 0));
  G.consider(fix(0.2, 1000));
  G.consider(fix(0.2, 4000));
  G.consider(fix(0.6, 4500));   // resets
  G.consider(fix(0.2, 5000));
  G.consider(fix(0.2, 5000 + DWELL - 1));
  assert(G.blocked() === true, "a mid-dwell fast fix restarts the dwell");
  G.consider(fix(0.2, 5000 + DWELL));
  assert(G.blocked() === false, "clears once the restarted dwell completes");
})();

(function testFailSafeNoFixes() {
  const { G } = mk();
  G.consider(fix(1.0, 0));
  assert(G.blocked() === true, "with no fresh fixes the blank stays up");
})();

(function testVibrateOncePerBlock() {
  const { G, log } = mk();
  G.consider(fix(1.0, 0));
  G.consider(fix(2.0, 1000));
  G.consider(fix(3.0, 2000));
  assert(log.vibrate === 1, "vibrate only on the block transition, got " + log.vibrate);
})();

/* ---- fix-gap discontinuity ---- */
(function testFixGapResetsDwell() {
  const { G } = mk();
  G.consider(fix(1.0, 0));
  G.consider(fix(0.2, 1000));
  G.consider(fix(0.2, 1000 + 15000 + 1)); // gap > maxFixGapMs
  assert(G.blocked() === true, "a fix gap over maxFixGapMs resets the dwell");
  G.consider(fix(0.2, 1000 + 15001 + DWELL));
  assert(G.blocked() === false, "clears after a fresh full dwell post-gap");
})();

/* ---- ?guard + suppressed ---- */
(function testGuardZeroDisables() {
  const { G, doc } = mk({ search: "?guard=0" });
  G.consider(fix(5, 0));
  assert(!G.blocked() && !overlayShown(doc), "?guard=0 disables the guard");
})();

(function testSuppressedInert() {
  const { G } = mk({ cfg: { suppressed: true } });
  G.consider(fix(5, 0));
  assert(!G.blocked(), "suppressed:true keeps the guard inert");
})();

(function testSuppressedOverriddenByGuardOne() {
  const { G } = mk({ search: "?guard=1", cfg: { suppressed: true } });
  G.consider(fix(5, 0));
  assert(G.blocked() === true, "?guard=1 forces the guard on even when suppressed");
})();

(function testEnabledFalseKillSwitch() {
  const { G } = mk({ cfg: { enabled: false } });
  G.consider(fix(5, 0));
  assert(!G.blocked(), "configure({enabled:false}) is a hard kill switch");
})();

/* ---- one-time notice ---- */
(function testNoticeViaOnNoticeOnce() {
  const { G, log } = mk();
  G.noteStarted();
  G.consider(fix(1.0, 0));            // block also calls _maybeNotice
  G.consider(fix(0.2, 1000));
  G.consider(fix(0.2, 1000 + DWELL)); // unblock
  G.consider(fix(1.0, 20000));        // block again
  assert(log.notices.length === 1 && /hides the screen while you're moving/.test(log.notices[0]),
    "the one-time notice fires exactly once via onNotice, got " + JSON.stringify(log.notices));
})();

(function testNoticeSelfRenderWhenNoOnNotice() {
  // no onNotice configured -> module renders its own #sgNotice
  const log = { vibrate: 0 };
  const win = { location: { search: "" }, navigator: { vibrate: () => { log.vibrate++; } }, document: freshDoc(), setTimeout, clearTimeout };
  const sandbox = { console, window: win, URLSearchParams, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const G = sandbox.window.SpeedGuard;
  G.noteStarted();
  const n = sandbox.window.document.getElementById("sgNotice");
  assert(n && n.classList.contains("show"), "with no onNotice, noteStarted() renders the module's own #sgNotice");
})();

/* ---- reset ---- */
(function testReset() {
  const { G, doc } = mk();
  G.consider(fix(1.0, 0));
  G.reset();
  assert(G.blocked() === false && !overlayShown(doc), "reset() clears state and hides the overlay");
})();

/* ---- bad input ---- */
(function testBadInputNoThrow() {
  const { G } = mk();
  let threw = false;
  try {
    G.consider(undefined);
    G.consider({ t: 1 });          // no speed, no lat/lon -> speedOf null -> hold
    G.consider({ speed: NaN, t: 1 });
    G.consider({ speed: 1 });      // no t -> ignored
  } catch (e) { threw = true; }
  assert(!threw && !G.blocked(), "malformed fixes are ignored without throwing");
})();

/* ---- exemption predicate ---- */
(function testExemptFnSuppressesBlock() {
  const { G } = mk();
  G.setExemptFn((p) => p.speed >= 2 && p.lat === 51.31); // "on the lift" stand-in
  G.consider(fix(3.0, 0, 51.31, -117.05));
  assert(!G.blocked(), "an exempt fix does not blank");
  G.consider(fix(3.0, 1000, 51.20, -117.05)); // same speed, not exempt
  assert(G.blocked() === true, "the same speed off the exemption still blanks");
})();

(function testExemptFnFeedsClearDwellWhenAlreadyBlocked() {
  const { G } = mk();
  G.setExemptFn((p) => p.lat === 51.31);
  G.consider(fix(2.0, 0, 51.20, -117.05));           // blocked (not exempt)
  assert(G.blocked() === true, "blocked on the non-exempt approach");
  G.consider(fix(3.0, 1000, 51.31, -117.05));        // now exempt -> treated as "slow" for clearing
  G.consider(fix(3.0, 1000 + DWELL, 51.31, -117.05));
  assert(G.blocked() === false, "an exempt fix stream feeds the clear-dwell and restores");
})();

/* ---- speed fallback (no p.speed) ---- */
(function testSpeedOfHaversineFallback() {
  const { G } = mk();
  const so = G._internal.speedOf;
  // first call with lat/lon primes _lastLL via consider()
  G.consider({ t: 0, lat: 51.30, lon: -117.05 });        // speedOf null (no prev) -> hold, primes _lastLL
  // ~111 m north in 10 s ≈ 11.1 m/s
  const sp = so({ t: 10000, lat: 51.301, lon: -117.05 });
  assert(sp != null && sp > 8 && sp < 14, "speedOf derives ~11 m/s by haversine from the previous fix, got " + sp);
})();

(function testFallbackSpeedCanBlockAndClear() {
  const { G } = mk();
  G.consider({ t: 0, lat: 51.300, lon: -117.05 });               // prime
  G.consider({ t: 2000, lat: 51.3002, lon: -117.05 });           // ~22 m / 2 s ≈ 11 m/s -> block
  assert(G.blocked() === true, "a fix stream with no p.speed still blocks via the haversine fallback");
  G.consider({ t: 4000, lat: 51.3002, lon: -117.05 });           // no movement -> 0 m/s
  G.consider({ t: 4000 + DWELL, lat: 51.3002, lon: -117.05 });
  assert(G.blocked() === false, "and clears when the derived speed drops");
})();

/* ---- configure overrides behaviour ---- */
(function testConfigureThreshold() {
  const { G } = mk({ cfg: { blockMps: 5 } });
  G.consider(fix(3.0, 0));
  assert(!G.blocked(), "3 m/s does not blank when blockMps is raised to 5");
  G.consider(fix(6.0, 1000));
  assert(G.blocked() === true, "6 m/s blanks at the raised threshold");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
