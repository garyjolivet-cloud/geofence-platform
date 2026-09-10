// Tests for the GPX Editor's "every corridor on the map" overlay
// (frontend/gpx-editor.html): the pure FeatureCollection builder plus
// source-shape assertions that the overlay + guarded click-to-edit are wired.
//
// Run: `node tests/gpx-editor-overlay.test.js` (or `node --test "tests/**/*.test.js"`).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/gpx-editor.html"), "utf8");

function extractFn(startTag) {
  const s = html.indexOf(startTag);
  if (s < 0) throw new Error("could not find " + startTag);
  let depth = 0, i = html.indexOf("{", s);
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(s, i + 1);
}

// eslint-disable-next-line no-new-func
const corridorsToFC = new Function("return (" + extractFn("function corridorsToFC(") + ")")();

/* ---- corridorsToFC ---- */

const list = [
  { id: "a", name: "Alpha", difficulty: "blue", runType: "run", points: [[-117.05, 51.30], [-117.05, 51.31]] },
  { id: "b", name: "Bravo", difficulty: "black", points: [[-117.06, 51.30], [-117.06, 51.31], [-117.06, 51.32]] },
  { id: "c", name: "Charlie", points: [[-117.07, 51.30]] },            // <2 points — skipped
  { id: "d", name: "Delta", points: [[-117.08, 51.30], [-117.08, 51.31]] }
];

(function testExcludesActive() {
  const fc = corridorsToFC(list, "a", new Set());
  assert(fc.type === "FeatureCollection", "returns a FeatureCollection");
  const ids = fc.features.map(f => f.properties.id);
  assert(!ids.includes("a"), "the active corridor is excluded from the overlay, got " + JSON.stringify(ids));
  assert(ids.includes("b") && ids.includes("d"), "other corridors are included");
})();

(function testSkipsShortCorridors() {
  const fc = corridorsToFC(list, null, new Set());
  assert(!fc.features.some(f => f.properties.id === "c"), "a <2-point corridor is skipped");
  assert(fc.features.length === 3, "3 drawable corridors (a,b,d), got " + fc.features.length);
})();

(function testMineFlag() {
  const fc = corridorsToFC(list, null, new Set(["b", "d"]));
  const mine = {};
  fc.features.forEach(f => { mine[f.properties.id] = f.properties.mine; });
  assert(mine.a === 0, "a is not in the project set -> mine:0, got " + mine.a);
  assert(mine.b === 1 && mine.d === 1, "b,d are in the project set -> mine:1");
})();

(function testLineStringCoords() {
  const fc = corridorsToFC(list, null, new Set());
  const b = fc.features.find(f => f.properties.id === "b");
  assert(b.geometry.type === "LineString", "geometry is a LineString");
  assert(Array.isArray(b.geometry.coordinates) && b.geometry.coordinates.length === 3, "keeps all points");
  assert(b.geometry.coordinates[0].length === 2 && b.geometry.coordinates[0][0] === -117.06,
    "coords are [lon,lat] pairs, got " + JSON.stringify(b.geometry.coordinates[0]));
  assert(b.properties.difficulty === "black" && b.properties.runType === "run",
    "difficulty carried through, runType defaults to 'run'");
})();

(function testHandlesEmptyAndNull() {
  assert(corridorsToFC(null, null, null).features.length === 0, "null list -> empty FC, no throw");
  assert(corridorsToFC([], "x", new Set()).features.length === 0, "empty list -> empty FC");
})();

/* ---- source-shape: overlay + guarded click-to-edit are wired ---- */

(function testOverlaySourceAndLayers() {
  assert(/map\.addSource\("allCorridors"/.test(html), "renderAllCorridors adds the allCorridors source");
  assert(/id:"allCorridors-hit"/.test(html), "there is an invisible allCorridors-hit click-target layer");
  assert(/map\.on\("click","allCorridors-hit",/.test(html), "a click handler is bound to allCorridors-hit");
})();

(function testClickCallsGuardedPicker() {
  const clickHandler = extractFn('map.on("click","allCorridors-hit",');
  assert(/pickCorridorById\(/.test(clickHandler), "the overlay click loads a corridor via pickCorridorById");
  const picker = extractFn("function pickCorridorById(");
  assert(/confirmDiscardIfDirty\(\)/.test(picker), "pickCorridorById checks for unsaved changes before switching");
  const confirmFn = extractFn("function confirmDiscardIfDirty(");
  assert(/isDirty\(\)/.test(confirmFn) && /confirm\(/.test(confirmFn), "confirmDiscardIfDirty prompts confirm() when isDirty()");
})();

(function testTreeRowRoutesThroughPicker() {
  assert(/onPick:\s*item\s*=>\s*pickCorridorById\(item\.id\)/.test(html),
    "the rail tree onPick routes through pickCorridorById (same unsaved-changes guard)");
})();

(function testEnterProjectLoadsAll() {
  const ep = extractFn("async function enterProject(");
  assert(/loadAllCorridors\(\)/.test(ep), "enterProject calls loadAllCorridors()");
  assert(/mapMatchCorridorIds/.test(ep) && /z\.corridorId/.test(ep),
    "enterProject builds projectCorridorIds from the bundle (zones[].corridorId + mapMatchCorridorIds)");
  const loader = extractFn("async function loadAllCorridors(");
  assert(/\/api\/corridor\?appId=/.test(loader) && /withPoints=1/.test(loader),
    "loadAllCorridors fetches /api/corridor?appId=...&withPoints=1");
})();

(function testBeforeUnloadGuard() {
  assert(/beforeunload[\s\S]{0,80}isDirty\(\)/.test(html), "a beforeunload handler warns when isDirty()");
})();

(function testToggle() {
  assert(/id="showAllCorr"/.test(html), "there's a 'show every corridor' toggle");
  assert(/showAllCorr"\)\.onchange/.test(html) && /overlayOn\s*=/.test(html), "the toggle drives overlayOn + re-render");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
