// Fence Editor speed (2026-10-06, user: "panning zooming tilting edit and test so slow"):
//  A. 3D terrain + winter DEM shading only while tilted   B. no glow blur in the editor
//  C. drawing resolution capped at 1.5x                   D. map data re-sent only when it changed
// Run: `node --test tests/fence-editor-speed.test.js` (or the full suite).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const ed = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8").replace(/\r/g, "");
const tf = fs.readFileSync(path.join(__dirname, "../frontend/tile-fog.js"), "utf8");

function extract(tag) {
  const s = ed.indexOf(tag); assert.ok(s >= 0, tag);
  let d = 0, i = ed.indexOf("{", s);
  for (; i < ed.length; i++) { if (ed[i] === "{") d++; else if (ed[i] === "}") { d--; if (d === 0) break; } }
  return ed.slice(s, i + 1);
}

test("A: terrain follows the tilt — on above 5 degrees, off when flat, shading with it", () => {
  const body = extract("function syncTerrainToPitch(force){");
  const calls = [], vis = {};
  let pitch = 0;
  const map = { getSource: () => ({}), getPitch: () => pitch, setTerrain: t => calls.push(t), getLayer: id => id.startsWith("winter"),
    setLayoutProperty: (id, k, v) => { vis[id] = v; }, once() {} };
  // eslint-disable-next-line no-new-func
  const f = new Function("map", "TERRAIN_SOURCE_ID", "TERRAIN_MIN_PITCH", "renderSources", "_threeDOn",
    "let _terrainActive=false;\n" + body + "\nreturn syncTerrainToPitch;")(map, "terrain-dem", 5, () => {}, true);
  f(true);
  assert.deepStrictEqual(calls, [null], "flat: no terrain");
  assert.strictEqual(vis["winter-hillshade"], "none");
  pitch = 30; f();
  assert.deepStrictEqual(calls[1], { source: "terrain-dem", exaggeration: 1 }, "tilted: terrain on");
  assert.strictEqual(vis["winter-hillshade"], "visible");
  f(); assert.strictEqual(calls.length, 2, "no repeat while already on");
  pitch = 0; f();
  assert.strictEqual(calls[2], null, "flat again: off");
  assert.ok(/map\.on\("pitch",/.test(ed) && /map\.on\("pitchend",\(\)=>syncTerrainToPitch\(\)\)/.test(ed));
});

test("B: no glow blur in the editor or Test Mode; other hosts unchanged", () => {
  assert.ok(/"line-blur": o\.lightGlow \? 0 : \["case", guardedExpr, 4, 6\]/.test(tf));
  assert.ok(ed.includes('id:"fenceCorr",lightGlow:true') && ed.includes('smoothEdges:true,lightGlow:true'));
});

test("C: drawing resolution capped at 1.5x", () => {
  assert.ok(/pixelRatio:Math\.min\(window\.devicePixelRatio\|\|1,1\.5\)/.test(ed));
});

test("D: unchanged data is not re-sent; a recreated source always gets it", () => {
  const body = extract("function setDataIfChanged(id, data){");
  let src = { n: 0, setData() { this.n++; } };
  const map = { getSource: () => src };
  // eslint-disable-next-line no-new-func
  const f = new Function("map", "const _lastSourceJson=new Map();\n" + body + "\nreturn setDataIfChanged;")(map);
  assert.strictEqual(f("fences", { a: 1 }), true);
  assert.strictEqual(f("fences", { a: 1 }), false, "same data: skipped");
  assert.strictEqual(f("fences", { a: 2 }), true, "changed: sent");
  src = { n: 0, setData() { this.n++; } };
  assert.strictEqual(f("fences", { a: 2 }), true, "new source object (style reload): sent again");
  assert.ok(ed.includes('setDataIfChanged("fences", fc(feats));'));
});
