// Unit tests for frontend/guard-edge.js — the Corridor Guard boundary lines (window.GuardEdge).
//
// The yellow trigger-boundary lines used to be the centreline pushed sideways with
// MapLibre's line-offset, which folds into loops on the inside of a bend and grows
// spikes at every kink ("any change in direction causes a weird line"). GuardEdge
// draws the TRUE boundary instead: offset with a round join, trim what falls inside
// the buffer, stitch, and Bézier-smooth. These tests pin that behaviour, including on
// a real Kicking Horse chute (Big Dumper, 38 points, 50 m wide) — the kind of geometry
// that broke the old approach.
//
// Run: `node --test tests/guard-edge.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const sandbox = { window: {}, Math, Array, Object, JSON, Number, isFinite, Uint8Array };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../frontend/guard-edge.js"), "utf8"), sandbox);
const GE = sandbox.window.GuardEdge;

// ---- helpers: work in local metres so distances are easy to assert ----
const M_LAT = 111320;
function makeProj(p0) {
  const mLon = M_LAT * Math.cos(p0[0] * Math.PI / 180);
  return { xy: p => ({ x: (p[1] - p0[1]) * mLon, y: (p[0] - p0[0]) * M_LAT }), ll: (x, y) => [p0[0] + y / M_LAT, p0[1] + x / mLon] };
}
function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
const distToPoly = (p, P) => { let m = Infinity; for (let i = 0; i < P.length - 1; i++) m = Math.min(m, distToSeg(p, P[i], P[i + 1])); return m; };
function segsCross(a, b, c, d) {
  const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function selfIntersects(pl) {
  for (let i = 0; i < pl.length - 1; i++) for (let j = i + 2; j < pl.length - 1; j++) if (segsCross(pl[i], pl[i + 1], pl[j], pl[j + 1])) return true;
  return false;
}
const toXY = (line, proj) => line.map(([lon, lat]) => proj.xy([lat, lon]));   // outline output is [lon,lat]
function stats(pathLL, edgeM) {
  const proj = makeProj(pathLL[0]), P = pathLL.map(proj.xy), o = GE.outline(pathLL, edgeM);
  const lines = o.left.concat(o.right).map(l => toXY(l, proj));
  let maxOver = 0, maxUnder = 0, n = 0;
  lines.forEach(l => l.forEach(p => { const d = distToPoly(p, P); n++; maxOver = Math.max(maxOver, d - edgeM); maxUnder = Math.max(maxUnder, edgeM - d); }));
  return { o, P, proj, lines, maxOver, maxUnder, n };
}

// ---- 1. straight corridor: two clean parallel lines exactly edgeM away ----
(function testStraightCorridor() {
  const pathLL = [[51.300, -117.05], [51.3013, -117.05], [51.3027, -117.05]];   // ~300 m north
  const s = stats(pathLL, 25.5);
  assert(s.o.left.length === 1 && s.o.right.length === 1, "straight: exactly one line per side, got " + s.o.left.length + "/" + s.o.right.length);
  assert(s.maxOver < 0.05 && s.maxUnder < 0.05, "straight: every point is 25.5 m from the centreline (+" + s.maxOver.toFixed(3) + " / -" + s.maxUnder.toFixed(3) + ")");
  const L = s.lines[0];
  assert(Math.abs(L[0].y - 0) < 1 && Math.abs(L[L.length - 1].y - s.P[2].y) < 1, "straight: the line runs the full length of the corridor");
})();

// ---- 2. wide corridor with a 90 degree bend: arc outside, NO fold-over loop inside ----
(function testWideBend() {
  const proj = makeProj([51.3, -117.05]);
  const pathLL = [proj.ll(0, 0), proj.ll(0, 120), proj.ll(120, 120)];          // north 120 m, then east 120 m
  const edge = 40.5;                                                           // 80 m wide: far wider than the bend can hold on the inside
  const s = stats(pathLL, edge);
  assert(s.o.left.length === 1 && s.o.right.length === 1, "bend: one continuous line per side, got " + s.o.left.length + "/" + s.o.right.length);
  assert(s.maxUnder < 0.6, "bend: nothing drawn inside the trigger boundary — the inside-of-bend loop is trimmed (" + s.maxUnder.toFixed(2) + " m under)");
  // The Bézier rounds the crisp inside corner a little past the exact boundary (0.67 m here) —
  // the same sub-metre tolerance as the real chute below, and well under GPS error (5-10 m). A
  // miter spike would be tens of metres, so 1 m still catches it.
  assert(s.maxOver < 1.0, "bend: nothing drawn outside it either, so no spike at the corner (" + s.maxOver.toFixed(2) + " m over)");
  assert(!s.lines.some(selfIntersects), "bend: no line crosses itself");
  const around = s.lines.reduce((n, l) => n + l.filter(p => Math.abs(Math.hypot(p.x - s.P[1].x, p.y - s.P[1].y) - edge) < 0.3).length, 0);
  assert(around >= 6, "bend: the outside of the corner is a round arc of radius edgeM around the vertex (" + around + " points on it)");
})();

// ---- 3. hairpin: a 180 degree reversal must not spike ----
(function testHairpin() {
  const proj = makeProj([51.3, -117.05]);
  const pathLL = [proj.ll(0, 0), proj.ll(0, 150), proj.ll(14, 150), proj.ll(14, 0)];
  const s = stats(pathLL, 12.5);
  assert(s.maxOver < 0.8, "hairpin: no miter spike beyond the trigger distance (" + s.maxOver.toFixed(2) + " m over)");
  assert(s.maxUnder < 0.8, "hairpin: nothing drawn inside the boundary (" + s.maxUnder.toFixed(2) + " m under)");
  assert(!s.lines.some(selfIntersects), "hairpin: no line crosses itself");
})();

// ---- 4. REAL chute: Big Dumper, Kicking Horse (38 recorded points, 50 m wide) ----
const BIG_DUMPER = [[51.275454,-117.077804],[51.275516,-117.077772],[51.275535,-117.077796],[51.275558,-117.077807],[51.275577,-117.077831],[51.27557,-117.077879],[51.275567,-117.077925],[51.275585,-117.07797],[51.275594,-117.078013],[51.275626,-117.078123],[51.275644,-117.078137],[51.275664,-117.078179],[51.275709,-117.07826],[51.275718,-117.078324],[51.275797,-117.078399],[51.275807,-117.078469],[51.275877,-117.078528],[51.275896,-117.078574],[51.275958,-117.078657],[51.275991,-117.078724],[51.27606,-117.078759],[51.276087,-117.07882],[51.276136,-117.078906],[51.276142,-117.078925],[51.276236,-117.079097],[51.276339,-117.079225],[51.276382,-117.079284],[51.276426,-117.079338],[51.27652,-117.07947],[51.276555,-117.07951],[51.276615,-117.07959],[51.276678,-117.079671],[51.27674,-117.079749],[51.27678,-117.079818],[51.276824,-117.079909],[51.276907,-117.079974],[51.277114,-117.080216],[51.277268,-117.080364]];
(function testRealChute() {
  const s = stats(BIG_DUMPER, 25.5);
  assert(s.o.left.length === 1 && s.o.right.length === 1, "Big Dumper: one continuous line per side, got " + s.o.left.length + "/" + s.o.right.length);
  assert(s.maxOver < 1.0 && s.maxUnder < 1.0, "Big Dumper: the drawn line stays within 1 m of the true trigger distance (+" + s.maxOver.toFixed(2) + " / -" + s.maxUnder.toFixed(2) + "; GPS is 5-10 m)");
  assert(!s.lines.some(selfIntersects), "Big Dumper: no line crosses itself (the old per-vertex offset looped and spiked at the hook)");
  assert(s.n < 600, "Big Dumper: the thinned line is light enough to draw (" + s.n + " points)");
})();

// ---- 5. degenerate input never throws ----
(function testDegenerate() {
  let threw = null;
  try {
    [null, [], [[51.3, -117.05]], [[51.3, -117.05], [51.3, -117.05]]].forEach(p => GE.outline(p, 25));
    GE.outline([[51.3, -117.05], [51.301, -117.05]], 0); GE.outline([[51.3, -117.05], [51.301, -117.05]], -5);
    GE.featureCollection(null); GE.featureCollection([{ zoneId: "x", path: [[51.3, -117.05]] }]);
  } catch (e) { threw = e.message; }
  assert(threw === null, "degenerate input (null, 1 point, duplicates, zero/negative edge) must not throw, got: " + threw);
  const d = GE.outline([[51.3, -117.05], [51.3, -117.05], [51.3, -117.05]], 25);
  assert(d.left.length === 0 && d.right.length === 0, "a zero-length path yields no lines");
})();

// ---- 6. featureCollection ----
(function testFeatureCollection() {
  const fc = GE.featureCollection([
    { zoneId: "chute", path: [[51.300, -117.05], [51.303, -117.05]], widthM: 50, runType: "chute" },
    { zoneId: "lift", path: [[51.300, -117.05], [51.303, -117.05]], widthM: 15, runType: "lift" },
    { zoneId: "nowidth", path: [[51.300, -117.06], [51.303, -117.06]], runType: "run" },
    { zoneId: "short", path: [[51.3, -117.07]], widthM: 20, runType: "run" },
  ]);
  const ids = fc.features.map(f => f.properties.id);
  assert(ids.join() === "chute,nowidth", "lifts and 1-point paths are skipped; got " + ids.join());
  const f0 = fc.features[0];
  assert(f0.geometry.type === "MultiLineString" && f0.geometry.coordinates.length === 2, "each corridor is one MultiLineString with a line per side");
  assert(f0.geometry.coordinates[0][0][0] < -117 && f0.geometry.coordinates[0][0][1] > 51, "coordinates are [lon, lat] (GeoJSON order)");
  const nw = makeProj([51.300, -117.06]), pts = fc.features[1].geometry.coordinates[0].map(([lo, la]) => nw.xy([la, lo]));
  assert(Math.abs(Math.abs(pts[0].x) - 5.5) < 0.1, "a missing width counts as 10 m like chute-guard.js (edge 5.5 m with the 0.5 m buffer), got " + Math.abs(pts[0].x).toFixed(2));
})();

// ---- 7. the layer: valid shape, state-driven, one zoom curve ----
(function testLayer() {
  const l = GE.layer("runGuardEdges-line", "runGuardEdges");
  assert(l.type === "line" && l.source === "runGuardEdges" && l.id === "runGuardEdges-line", "layer targets its own source");
  const op = JSON.stringify(l.paint["line-opacity"]);
  assert(/feature-state/.test(op) && /guardEdges/.test(op), "opacity is driven by the guardEdges feature-state (a toggle never reloads data)");
  assert((JSON.stringify(l.paint["line-width"]).match(/\["zoom"\]/g) || []).length === 1, "line-width has exactly one zoom curve (MapLibre rejects two)");
  assert(l.paint["line-color"] === "#ffe600" && l.layout["line-cap"] === "round", "solid yellow, round caps");
})();

// ---- 8. wiring in the page ----
const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");
(function testWiring() {
  assert(/<script src="\/guard-edge\.js">/.test(html), "ridge-quest.html loads /guard-edge.js");
  assert(/GuardEdge\.featureCollection\(/.test(html) && /GuardEdge\.layer\(/.test(html), "ridge-quest.html builds the boundary lines from GuardEdge");
  assert(/promoteId:\s*"id"/.test(html) && /runGuardEdges/.test(html), "the boundary source has ids so feature-state can target one corridor");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
