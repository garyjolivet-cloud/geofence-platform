// Unit tests for frontend/terrain-3d.js (window.Terrain3D) — the shared 3D
// DEM-terrain wiring Ridge Quest's "My map" now uses.
//
// terrain-3d.js is a browser IIFE (assigns window.Terrain3D); it's loaded
// here into a stub `window` with a fake MapLibre map, same approach the
// other DOM-free-ish modules are tested with. If the DEM source spec
// changes, backend/worker.js's sampleElevation() must change with it — the
// last test guards that.
//
// Run: `node tests/terrain-3d.test.js` (or the full `node --test tests/`).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

// ---- load terrain-3d.js into a sandbox with a stub window ----
const src = fs.readFileSync(path.join(__dirname, "..", "frontend", "terrain-3d.js"), "utf8");
let mqReduce = false;
const sandbox = { window: { matchMedia: () => ({ get matches() { return mqReduce; } }) } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const T = sandbox.window.Terrain3D;

// ---- a minimal fake MapLibre map ----
function fakeMap(initialPitch) {
  return {
    _sources: {}, _terrain: undefined, _sky: undefined, _pitch: initialPitch || 0,
    _eases: [], _layers: {}, _paint: {}, _images: {},
    getSource(id) { return this._sources[id]; },
    addSource(id, spec) { this._sources[id] = spec; },
    removeSource(id) { delete this._sources[id]; },
    setTerrain(t) { this._terrain = t; },
    setSky(s) { this._sky = s; },
    getPitch() { return this._pitch; },
    easeTo(opts) { this._eases.push(opts); if (opts.pitch != null) this._pitch = opts.pitch; },
    getLayer(id) { return this._layers[id]; },
    addLayer(layer, beforeId) { this._layers[layer.id] = layer; layer.__before = beforeId; },
    removeLayer(id) { delete this._layers[id]; },
    setPaintProperty(layerId, prop, val) { (this._paint[layerId] || (this._paint[layerId] = {}))[prop] = val; },
    hasImage(id) { return !!this._images[id]; },
    addImage(id, img, opts) { this._images[id] = { img: img, opts: opts }; },
    removeImage(id) { delete this._images[id]; }
  };
}
// a fakeMap that already has the "base" raster layer, like renderFogMap's style
function fakeMapWithBase(pitch) {
  const m = fakeMap(pitch);
  m._layers["base"] = { id: "base", type: "raster", source: "base" };
  return m;
}

/* ================================ tests ================================ */

(function testApiShape() {
  assert(T && typeof T === "object", "window.Terrain3D is defined");
  assert(T.DEM_ID === "terrain-dem", "DEM_ID is 'terrain-dem' (matches the 6 existing copies), got " + T.DEM_ID);
  ["ensureSource", "setEnabled", "toggleTilt", "applyWinter", "clearWinter"].forEach(fn =>
    assert(typeof T[fn] === "function", "Terrain3D." + fn + " is a function"));
})();

(function testEnsureSourceAddsOnce() {
  const m = fakeMap();
  T.ensureSource(m);
  const s = m.getSource("terrain-dem");
  assert(!!s, "ensureSource adds the DEM source");
  assert(s.type === "raster-dem", "source type is raster-dem");
  assert(s.encoding === "terrarium", "encoding is terrarium");
  assert(s.tileSize === 256, "tileSize is 256");
  assert(s.maxzoom === 15, "maxzoom is 15");
  assert(Array.isArray(s.tiles) && /elevation-tiles-prod\/terrarium\/\{z\}\/\{x\}\/\{y\}\.png$/.test(s.tiles[0]),
    "tile URL is the Terrarium template, got " + (s.tiles && s.tiles[0]));
  const before = s;
  T.ensureSource(m);
  assert(m.getSource("terrain-dem") === before, "a second ensureSource call doesn't re-add / replace the source");
})();

(function testSetEnabledOn() {
  const m = fakeMap();
  T.setEnabled(m, true, { sky: true });
  assert(m._terrain && m._terrain.source === "terrain-dem" && m._terrain.exaggeration === 1,
    "setEnabled(true) sets terrain to the DEM source at exaggeration 1");
  assert(m._sky && typeof m._sky === "object", "sky:true applies a sky spec");
})();

(function testSetEnabledOnNoSky() {
  const m = fakeMap();
  T.setEnabled(m, true, {});
  assert(m._terrain && m._terrain.source === "terrain-dem", "terrain still set without sky");
  assert(m._sky === undefined, "no sky spec when sky is omitted");
})();

(function testSetEnabledOff() {
  const m = fakeMap(60);
  T.setEnabled(m, true, { sky: true });
  T.setEnabled(m, false);
  assert(m._terrain === null, "setEnabled(false) clears terrain");
  assert(m._sky === undefined, "setEnabled(false) clears the sky");
  assert(m._pitch === 0, "setEnabled(false) flattens the camera to pitch 0");
})();

(function testToggleTilt() {
  const flat = fakeMap(0);
  T.toggleTilt(flat);
  assert(flat._pitch === 60, "toggleTilt from flat -> 60, got " + flat._pitch);
  const pitched = fakeMap(60);
  T.toggleTilt(pitched);
  assert(pitched._pitch === 0, "toggleTilt from 60 -> 0, got " + pitched._pitch);
  const barely = fakeMap(8); // <= 10 threshold still counts as "flat"
  T.toggleTilt(barely);
  assert(barely._pitch === 60, "pitch 8 (<=10) toggles up to 60, got " + barely._pitch);
  const custom = fakeMap(0);
  T.toggleTilt(custom, 45);
  assert(custom._pitch === 45, "toggleTilt honours a custom high angle, got " + custom._pitch);
})();

(function testReducedMotionZeroDuration() {
  mqReduce = true;
  const m = fakeMap(0);
  T.toggleTilt(m);
  assert(m._eases[m._eases.length - 1].duration === 0, "prefers-reduced-motion -> easeTo duration 0");
  mqReduce = false;
  const m2 = fakeMap(0);
  T.toggleTilt(m2);
  assert(m2._eases[m2._eases.length - 1].duration === 400, "normal motion -> easeTo duration 400");
})();

(function testDemUrlMatchesServer() {
  const worker = fs.readFileSync(path.join(__dirname, "..", "backend", "worker.js"), "utf8");
  assert(worker.includes("elevation-tiles-prod/terrarium/"),
    "worker.js still fetches the same Terrarium DEM host (sampleElevation) — client & server must not drift");
})();

(function testWorkerInjectsThreeDEnabled() {
  const worker = fs.readFileSync(path.join(__dirname, "..", "backend", "worker.js"), "utf8");
  const gate = worker.slice(worker.indexOf("live owner"));
  assert(worker.includes("a.three_d_enabled AS threeDEnabled"),
    "bundle GET owner-row SELECT includes three_d_enabled AS threeDEnabled");
  assert(worker.includes("bundle.threeDEnabled = !!(ownerRow && ownerRow.threeDEnabled)"),
    "bundle GET injects bundle.threeDEnabled from the live owner row");
  assert(gate.indexOf("threeDEnabled") > -1, "the injection sits in the live-owner block");
})();

(function testApplyWinter2D() {
  const m = fakeMapWithBase();
  T.applyWinter(m, { dem: false });
  assert(m._paint["base"]["raster-saturation"] < 0, "applyWinter desaturates the base raster, got " + m._paint["base"]["raster-saturation"]);
  assert(m._paint["base"]["raster-brightness-min"] > 0, "applyWinter lifts base brightness-min");
  assert(!!m.getSource("winter-src"), "applyWinter adds the world-rect winter-src source");
  assert(!!m.getLayer("winter-wash"), "applyWinter adds winter-wash");
  assert(!!m.getLayer("winter-grain"), "applyWinter adds winter-grain");
  assert(m.hasImage("winter-grain"), "applyWinter registers the winter-grain image");
  const gi = m._images["winter-grain"].img;
  assert(gi && gi.width === 128 && gi.height === 128 && gi.data.length === 128 * 128 * 4, "grain image is 128x128 RGBA");
  assert(!m.getLayer("winter-hillshade") && !m.getLayer("winter-relief"), "no DEM layers in 2D mode (dem:false)");
})();

(function testApplyWinter3D() {
  const m = fakeMapWithBase();
  m.addSource("terrain-dem", { type: "raster-dem" });
  T.applyWinter(m, { dem: true });
  assert(!!m.getLayer("winter-hillshade"), "dem:true adds winter-hillshade");
  assert(!!m.getLayer("winter-relief"), "dem:true adds winter-relief");
  assert(m.getLayer("winter-hillshade").source === "terrain-dem", "hillshade reads the DEM source");
  assert(m.getLayer("winter-relief").source === "terrain-dem", "color-relief reads the DEM source");
  assert(m.getLayer("winter-hillshade").type === "hillshade", "winter-hillshade is a hillshade layer");
  assert(m.getLayer("winter-relief").type === "color-relief", "winter-relief is a color-relief layer");
  assert(m._sky && typeof m._sky === "object", "dem:true switches to the winter sky");
})();

(function testApplyWinter3DNoDemSourceSkipsDemLayers() {
  const m = fakeMapWithBase();               // dem:true but no terrain-dem source present
  T.applyWinter(m, { dem: true });
  assert(!m.getLayer("winter-hillshade") && !m.getLayer("winter-relief"),
    "dem:true but no raster-dem source -> DEM layers skipped (2D stays DEM-free)");
  assert(!!m.getLayer("winter-wash"), "the cheap layers still apply");
})();

(function testApplyWinterAnchorsBelowShroud() {
  const m = fakeMapWithBase();
  m.addLayer({ id: "shroud-fill", type: "fill", source: "shroud" });
  T.applyWinter(m, { dem: false });
  assert(m.getLayer("winter-wash").__before === "shroud-fill", "winter-wash is inserted before shroud-fill");
})();

(function testApplyWinterIdempotent() {
  const m = fakeMapWithBase();
  T.applyWinter(m, { dem: false });
  const img1 = m._images["winter-grain"];
  T.applyWinter(m, { dem: false });          // second call
  assert(m._images["winter-grain"] === img1, "a second applyWinter doesn't re-add the grain image");
  assert(Object.keys(m._layers).filter(k => k.startsWith("winter-")).length === 2, "no duplicate winter layers on re-apply");
})();

(function testClearWinter() {
  const m = fakeMapWithBase();
  m.addSource("terrain-dem", { type: "raster-dem" });
  T.applyWinter(m, { dem: true });
  T.clearWinter(m);
  ["winter-relief", "winter-hillshade", "winter-wash", "winter-grain"].forEach(id =>
    assert(!m.getLayer(id), "clearWinter removes " + id));
  assert(!m.getSource("winter-src"), "clearWinter removes winter-src");
  assert(!m.hasImage("winter-grain"), "clearWinter removes the grain image");
  assert(m._paint["base"]["raster-saturation"] === 0, "clearWinter resets base raster-saturation to 0");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
