// Unit tests for the smart-follow / recenter-button behavior in
// frontend/here-marker.js — the shared "you are here" avatar used by Ridge
// Quest "My map", the Walk tour player (/engine), and Field Recorder.
//
// Root cause fixed here (2026-09-17): the old logic re-centered the map on
// the GPS dot whenever a fix landed >2s after the user's last pan/zoom
// gesture ended. Outdoor GPS fixes can legitimately be 15-20s apart, so a
// user scanning terrain for something far from their own position (e.g. a
// new ski chute) got the map yanked back mid-exploration. Replaced with the
// standard mapping-app pattern: the first manual gesture turns follow off
// PERMANENTLY (not just for a cooldown), and a page-supplied "recenter on
// me" control (driven by opts.onFollowChange) calls the returned recenter()
// to jump back and resume following.
//
// Loads the real here-marker.js into a sandboxed `window`/`document`/
// `maplibregl` (same fake-map-object technique as tests/terrain-3d.test.js)
// so this exercises the actual shipped attach()/update()/recenter() code,
// not a re-implementation of it.
//
// Run: `node tests/here-marker-follow.test.js` (or the full `node --test tests/`).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

// ---- a minimal fake DOM element (className/classList/style/children) ----
function fakeElement() {
  const classes = new Set();
  return {
    _classes: classes,
    className: "",
    style: { setProperty() {} },
    appendChild() {},
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); }
    }
  };
}

// ---- a minimal fake MapLibre map, screen-projection controllable per test ----
function fakeMap() {
  return {
    _sources: {}, _handlers: {}, _eases: [], _pitch: 0,
    _projectPoint: { x: 200, y: 200 }, // default: dead centre of a 400x400 view (inside the 60% inset)
    isStyleLoaded() { return true; },
    once() {},
    on(ev, fn) { (this._handlers[ev] || (this._handlers[ev] = [])).push(fn); },
    off(ev, fn) {
      const list = this._handlers[ev];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    fire(ev) { (this._handlers[ev] || []).forEach(fn => fn()); },
    easeTo(opts) { this._eases.push(opts); },
    getZoom() { return 14; },
    getCenter() { return { lng: 0, lat: 0 }; },
    getContainer() { return { clientWidth: 400, clientHeight: 400 }; },
    project() { return this._projectPoint; },
    getSource(id) { return this._sources[id]; },
    addSource(id, spec) {
      this._sources[id] = Object.assign({}, spec, { setData(d) { this.data = d; } });
    },
    removeSource(id) { delete this._sources[id]; },
    getLayer() { return null; },
    addLayer() {},
    removeLayer() {}
  };
}

// ---- load here-marker.js into a sandbox with stub document/maplibregl ----
const src = fs.readFileSync(path.join(__dirname, "..", "frontend", "here-marker.js"), "utf8");
const sandbox = {
  window: {},
  document: {
    createElement() { return fakeElement(); },
    head: { appendChild() {} }
  },
  maplibregl: {
    Marker: function (opts) {
      this._el = opts.element;
      this.setLngLat = function () { return this; };
      this.addTo = function () { return this; };
      this.remove = function () {};
      this.getElement = function () { return this._el; };
    }
  },
  performance: { now: () => Date.now() }
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const HereMarker = sandbox.window.HereMarker;

// point the fake map's projection outside the 60% inset (top-left corner of
// a 400x400 view -> definitely outside), so maybeFollow's edge check fires
function setDotOffscreen(map) { map._projectPoint = { x: 0, y: 0 }; }
function setDotCentred(map) { map._projectPoint = { x: 200, y: 200 }; }

/* ================================ tests ================================ */

(function testApiShape() {
  assert(HereMarker && typeof HereMarker.attach === "function", "window.HereMarker.attach exists");
})();

(function testDefaultFollowCentersFirstFix() {
  const map = fakeMap();
  const h = HereMarker.attach(map, { follow: true });
  h.update({ lon: 1, lat: 2 });
  assert(map._eases.length === 1, "first fix eases the camera exactly once");
  assert(map._eases[0].center[0] === 1 && map._eases[0].center[1] === 2, "first-fix ease centers on the fix");
})();

(function testEdgeModeSkipsFirstFixButFollowsAfter() {
  const map = fakeMap();
  const h = HereMarker.attach(map, { follow: "edge" });
  h.update({ lon: 1, lat: 2 }); // first fix — edge mode skips this
  assert(map._eases.length === 0, "'edge' mode does not move the camera on the first fix");
  setDotOffscreen(map);
  h.update({ lon: 3, lat: 4 }); // second fix, dot drifted near the edge
  assert(map._eases.length === 1, "'edge' mode still follows on a later off-centre fix");
})();

(function testManualPanTurnsFollowOffPermanently() {
  const map = fakeMap();
  const seen = [];
  const h = HereMarker.attach(map, { follow: true, onFollowChange: on => seen.push(on) });
  h.update({ lon: 0, lat: 0 }); // first-fix centre (follow still on)
  const easesBeforeDrag = map._eases.length;

  map.fire("dragstart"); // the user manually pans
  assert(seen.length === 1 && seen[0] === false, "onFollowChange(false) fires exactly once on the first gesture");

  // Repeated gestures while already off must NOT re-fire onFollowChange —
  // this is the "no matter how long you keep looking around" contract.
  map.fire("zoomstart");
  map.fire("rotatestart");
  assert(seen.length === 1, "further gestures while already off don't re-fire onFollowChange");

  // The old bug: a fix arriving well after a >2s cooldown snapped the
  // camera back. Simulate exactly that — dot off-screen, long after the
  // gesture — and confirm the camera now stays put indefinitely.
  setDotOffscreen(map);
  h.update({ lon: 50, lat: 50 });
  h.update({ lon: 51, lat: 51 });
  assert(map._eases.length === easesBeforeDrag, "no auto-recenter happens after a manual pan, regardless of fix drift");
})();

(function testRecenterJumpsBackAndResumesFollowing() {
  const map = fakeMap();
  const seen = [];
  const h = HereMarker.attach(map, { follow: true, onFollowChange: on => seen.push(on) });
  h.update({ lon: 10, lat: 20 }); // first fix — this is now the "last known fix"
  map.fire("dragstart"); // follow off
  assert(seen[seen.length - 1] === false, "follow is off after the pan");

  const easesBeforeRecenter = map._eases.length;
  h.recenter();
  assert(map._eases.length === easesBeforeRecenter + 1, "recenter() eases the camera exactly once");
  const last = map._eases[map._eases.length - 1];
  assert(last.center[0] === 10 && last.center[1] === 20, "recenter() targets the last known on-site fix, not a stale/no-op center");
  assert(seen[seen.length - 1] === true, "recenter() re-fires onFollowChange(true)");

  // Following resumed -> a later off-centre fix should auto-follow again.
  const easesAfterRecenter = map._eases.length;
  setDotOffscreen(map);
  h.update({ lon: 11, lat: 21 });
  assert(map._eases.length === easesAfterRecenter + 1, "auto-follow resumes on the next fix after recenter()");
})();

(function testFollowFalseNeverToggles() {
  const map = fakeMap();
  const seen = [];
  const h = HereMarker.attach(map, { follow: false, onFollowChange: on => seen.push(on) });
  h.update({ lon: 0, lat: 0 });
  setDotOffscreen(map);
  h.update({ lon: 5, lat: 5 });
  map.fire("dragstart");
  assert(map._eases.length === 0, "follow:false never moves the camera");
  assert(seen.length === 0, "follow:false never fires onFollowChange (there's nothing to toggle)");

  h.recenter();
  assert(map._eases.length === 0, "recenter() is a no-op under follow:false");
})();

(function testInsetHitSuppressesRedundantEase() {
  const map = fakeMap();
  const h = HereMarker.attach(map, { follow: true });
  h.update({ lon: 0, lat: 0 }); // first fix
  const before = map._eases.length;
  setDotCentred(map); // still well inside the 60% inset box
  h.update({ lon: 0.0001, lat: 0.0001 });
  assert(map._eases.length === before, "a fix that's still near-centre doesn't trigger a redundant ease");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
