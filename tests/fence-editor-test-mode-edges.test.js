// Fence Editor Test Mode: boundary lines now use the smooth GuardEdge outline (2026-09-24).
//
// Before: each path SEGMENT was offset on its own (_corridorEdgeSegments), leaving gaps and
// overlaps at every bend — the same "weird line at any change of direction" Ridge Quest had —
// and armed corridors additionally got tile-fog's kinked line-offset lines. Now one smooth
// outline per corridor (frontend/guard-edge.js), pink dashed for all as before, solid yellow for
// armed ones, and tile-fog's offset lines are switched off with `smoothEdges:true`.
//
// The real edge-building block is extracted from fence-editor.html and run against a fake map.
//
// Run: `node --test tests/fence-editor-test-mode-edges.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const vm = require("vm");
const sandbox = { window: {}, Math, Array, Object, JSON, Number, isFinite, Uint8Array };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../frontend/guard-edge.js"), "utf8"), sandbox);
const REAL_GUARD_EDGE = sandbox.window.GuardEdge;
const html = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8").replace(/\r/g, "");

const startTag = "  try{\n    const edgeFc=GuardEdge.featureCollection(cors,bufferM);";
const endTag = 'catch(e){ console.warn("test-mode guard edges:",e&&e.message); }';
const s = html.indexOf(startTag), e = html.indexOf(endTag, s);
const block = s >= 0 && e > s ? html.slice(s, e + endTag.length) : "";
const wM = html.match(/const _simRunW=.*;/);

// an S-bend, 20 m wide, plus a straight one
const cors = [
  { id: "bend", path: [[51.300, -117.050], [51.3005, -117.0495], [51.3010, -117.0500], [51.3015, -117.0505], [51.3020, -117.0500]], widthM: 20, runType: "chute" },
  { id: "straight", path: [[51.310, -117.040], [51.311, -117.040]], widthM: 10, runType: "run" },
];

function run(overrides = {}) {
  const sources = {}, layers = [], warns = [];
  const scope = {
    GuardEdge: overrides.GuardEdge || REAL_GUARD_EDGE, cors, bufferM: 0.5,
    _cgGuardedIds: overrides.armed || new Set(["bend"]),
    map: { addSource: (id, def) => { sources[id] = def; }, addLayer: def => { layers.push(def); } },
    console: { warn: (...a) => warns.push(a.join(" ")) },
  };
  const fn = new Function(...Object.keys(scope), wM[0] + "\n" + block);
  fn(...Object.values(scope));
  return { sources, layers, warns };
}

test("the edge block and _simRunW were found in fence-editor.html", () => {
  assert.ok(block.length > 100, "found the try{...} edge block");
  assert.ok(wM, "found _simRunW");
});

test("one smooth outline per corridor, flagged armed or not", () => {
  const r = run();
  const fc = r.sources.runLinesEdge.data;
  assert.strictEqual(JSON.stringify(fc.features.map(f => f.properties.id).sort()), JSON.stringify(["bend", "straight"]));   // JSON: sandbox arrays are another realm
  assert.strictEqual(fc.features.find(f => f.properties.id === "bend").properties.guarded, true);
  assert.strictEqual(fc.features.find(f => f.properties.id === "straight").properties.guarded, false);
  fc.features.forEach(f => assert.strictEqual(f.geometry.type, "MultiLineString"));
  assert.deepStrictEqual(r.warns, []);
});

test("pink dashed line for every corridor (unchanged look) + solid yellow only where armed", () => {
  const { layers } = run();
  const pink = layers.find(l => l.id === "runLines-edge");
  assert.strictEqual(pink.paint["line-color"], "#ff2fd0");
  assert.deepStrictEqual(pink.paint["line-dasharray"], [2, 1.6]);
  assert.strictEqual(pink.filter, undefined, "pink line is not filtered: all corridors");
  const yellow = layers.find(l => l.id === "runLines-edge-armed");
  assert.strictEqual(yellow.paint["line-color"], "#ffe600");
  assert.deepStrictEqual(yellow.filter, ["==", ["get", "guarded"], true]);
  assert.strictEqual(yellow.source, "runLinesEdge");
});

test("the outline is smooth: far fewer sharp direction changes than the old per-segment offsets", () => {
  const bend = run().sources.runLinesEdge.data.features.find(f => f.properties.id === "bend");
  bend.geometry.coordinates.forEach(line => {
    let sharp = 0;
    for (let i = 2; i < line.length; i++) {
      const a = line[i - 2], b = line[i - 1], c = line[i];
      const a1 = Math.atan2(b[1] - a[1], (b[0] - a[0]) * Math.cos(b[1] * Math.PI / 180));
      const a2 = Math.atan2(c[1] - b[1], (c[0] - b[0]) * Math.cos(c[1] * Math.PI / 180));
      let d = Math.abs(a2 - a1); if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > 60 * Math.PI / 180) sharp++;
    }
    assert.strictEqual(sharp, 0, "no turn sharper than 60 degrees between consecutive points");
  });
});

test("a GuardEdge failure is contained: it warns and never aborts the rest of Test Mode", () => {
  const r = run({ GuardEdge: { featureCollection() { throw new Error("boom"); } } });
  assert.strictEqual(r.warns.length, 1);
  assert.match(r.warns[0], /test-mode guard edges: boom/);
  assert.deepStrictEqual(r.layers, []);
});

test("wiring: script loaded, tile-fog offset lines off, both layers cleaned up, old helper gone", () => {
  assert.ok(html.includes('<script src="/guard-edge.js"></script>'));
  assert.ok(html.includes('TileFog.addCorridorLayers(map,{source:"runLines",id:"runLines",smoothEdges:true});'));
  assert.ok(/SIM_RUN_LAYERS=[^\n]*"runLines-edge","runLines-edge-armed"/.test(html));
  assert.ok(html.includes('if(map.getSource("runLinesEdge")) map.removeSource("runLinesEdge");'));
  assert.ok(!html.includes("_corridorEdgeSegments"), "the per-segment offset helper is gone");
});
