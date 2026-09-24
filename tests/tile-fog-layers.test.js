// Guards tile-fog.js's shared corridor layer stack (TileFog.addCorridorLayers).
//
// Why this exists: MapLibre's addLayer() REJECTS an invalid style expression by
// throwing, and addCorridorLayers() wraps every addLayer in a try/catch that only
// console.warn()s — so a bad expression does not error, the layer just silently
// never appears. That happened to the halo (glow) layer: its line-width had TWO
// zoom curves in one expression ("Only one zoom-based step or interpolate
// subexpression may be used"), so the glow never rendered on any map.
//
// This runs the REAL tile-fog.js against a recording fake map (no MapLibre needed)
// and asserts the one rule that caused it: every paint/layout property carries at
// most one zoom curve. (The full check — MapLibre's own validateStyleMin — lives
// outside the repo because it needs @maplibre/maplibre-gl-style-spec; this catches
// the same class without a new dependency.)
//
// Run: `node --test tests/tile-fog-layers.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

function build(opts) {
  const layers = [], warns = [];
  const fakeMap = { getLayer: () => null, addLayer: def => { layers.push(def); }, getStyle: () => ({ layers }), moveLayer() {} };
  const sandbox = { window: {}, document: {}, console: { ...console, warn: (...a) => warns.push(a.join(" ")) }, Math, Set, Map, Array, Object, JSON };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../frontend/tile-fog.js"), "utf8"), sandbox);
  sandbox.window.TileFog.addCorridorLayers(fakeMap, opts);
  return { layers, warns };
}
const zoomCurves = expr => (JSON.stringify(expr).match(/\["zoom"\]/g) || []).length;

const MODES = [
  ["ridge-quest (guardByState)", { source: "runLines", id: "runLines", guardByState: true }],
  ["everything else (property-based)", { source: "runLines", id: "runLines" }],
];

MODES.forEach(([label, opts]) => {
  const { layers, warns } = build(opts);
  const ids = layers.map(l => l.id);

  (function testEveryExpectedLayerIsBuilt() {
    ["-width", "-halo", "-casing", "-core", "-edge-r", "-edge-l", "-liftline", "-tower"].forEach(sfx =>
      assert(ids.includes("runLines" + sfx), label + ": layer runLines" + sfx + " is built (got " + ids.join(",") + ")"));
    assert(warns.length === 0, label + ": addCorridorLayers logged no warnings, got " + JSON.stringify(warns));
  })();

  (function testNoPropertyHasTwoZoomCurves() {
    layers.forEach(l => {
      ["paint", "layout"].forEach(group => Object.keys(l[group] || {}).forEach(prop => {
        const n = zoomCurves(l[group][prop]);
        assert(n <= 1, label + ": " + l.id + " " + group + "." + prop + " has " + n +
          " zoom curves — MapLibre rejects that and the layer silently never renders");
      }));
    });
  })();

  (function testHaloWidthIsOneTopLevelInterpolate() {
    const halo = layers.find(l => l.id === "runLines-halo");
    const w = halo && halo.paint["line-width"];
    assert(Array.isArray(w) && w[0] === "interpolate" && w[2] && w[2][0] === "zoom",
      label + ": the glow's line-width is ONE top-level zoom interpolate, got " + JSON.stringify(w));
    assert(zoomCurves(w) === 1, label + ": the glow's line-width has exactly one zoom curve");
  })();

  (function testGlowActuallyShowsPastTheOutline() {
    // "Valid but invisible" is a failure too: after the expression was fixed the glow
    // rendered but stuck out only 0.75-1.75 px past the black casing (blurred, 45%
    // opacity) — nobody could see it. Compare the real stops: at every zoom the halo
    // must be wide enough that at least MIN_GLOW_PX of it shows on each side.
    const MIN_GLOW_PX = 3;
    const stops = expr => { const o = {}; for (let i = 3; i + 1 < expr.length; i += 2) o[expr[i]] = expr[i + 1]; return o; };
    const num = v => Array.isArray(v) ? v[v.length - 1] : v;        // ["*", <scale>, N] -> N
    const halo = stops(layers.find(l => l.id === "runLines-halo").paint["line-width"]);
    const casing = stops(layers.find(l => l.id === "runLines-casing").paint["line-width"]);
    Object.keys(casing).forEach(z => {
      const glow = (num(halo[z]) - num(casing[z])) / 2;
      assert(glow >= MIN_GLOW_PX, label + ": at zoom " + z + " the glow shows only " + glow + " px past the outline (need >= " + MIN_GLOW_PX + ")");
    });
    const op = layers.find(l => l.id === "runLines-halo").paint["line-opacity"];
    assert(op[op.length - 1] >= 0.5, label + ": the glow's normal opacity is not so low it disappears, got " + JSON.stringify(op));
  })();
});

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
