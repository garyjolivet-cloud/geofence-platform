// Unit tests for Ridge Quest R4's viewpoint-entry detection and viewshed
// grant (Quest._tickViewpoints/_grantViewshed in frontend/ridge-quest.html)
// — the client-side piece that fires once a player walks within
// VIEWPOINT_RADIUS_M of a Viewpoint zone, granting its precomputed cell-set
// at state=1 ("Fog"/seen).
//
// Extracts both methods straight out of the shipped file via string-slice
// (same established technique as tests/quest-corridor-detection.test.js
// and tests/quest-fog-reveal.test.js), stubbing `api` (network) — QGeo/
// QUEST_TUNING are passed as EXTRA trailing parameters not present in the
// real call sites (which read them as free variables/closures over the
// same <script> scope) purely so this test can inject them, same pattern
// tests/quest-corridor-detection.test.js's classify() extraction already
// uses.
//
// Run: `node --test tests/quest-viewpoint-grant.test.js` (or as part of
// the full `node --test tests/` suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");

const qgeoM = html.match(/const QGeo = \{[\s\S]*?\n\};/);
if (!qgeoM) { console.log("FAIL: could not extract QGeo from ridge-quest.html"); process.exit(1); }
const QGeo = eval("(" + qgeoM[0].replace(/^const QGeo = /, "").replace(/;$/, "") + ")");

const tuningM = html.match(/const QUEST_TUNING = \{[\s\S]*?\n\};/);
if (!tuningM) { console.log("FAIL: could not extract QUEST_TUNING from ridge-quest.html"); process.exit(1); }
const QUEST_TUNING = eval("(" + tuningM[0].replace(/^const QUEST_TUNING = /, "").replace(/;$/, "") + ")");

function extractMethodBody(startTag) {
  const startIdx = html.indexOf(startTag);
  if (startIdx < 0) throw new Error("could not find " + startTag + " in ridge-quest.html");
  let depth = 0, i = html.indexOf("{", startIdx), bodyStart = i + 1;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(bodyStart, i);
}

// eslint-disable-next-line no-new-func
const tickViewpoints = new Function("p", "QGeo", "QUEST_TUNING", extractMethodBody("_tickViewpoints(p){"));
// eslint-disable-next-line no-new-func
const grantViewshed = new Function("vp", "QUEST_TUNING", "api", extractMethodBody("_grantViewshed(vp){"));

function mkQuest() {
  return {
    viewpoints: [], enteredViewpoints: new Set(), fogCells: new Map(), onFogUpdated: null,
    _tickViewpoints(p) { return tickViewpoints.call(this, p, QGeo, QUEST_TUNING); },
    _grantViewshed(vp) { return grantViewshed.call(this, vp, QUEST_TUNING, this._api); }
  };
}
function stubApi(calls) {
  return (path, opts) => { calls.push({ path, body: JSON.parse(opts.body) }); return Promise.resolve({ ok: true }); };
}

/* ---- _tickViewpoints: entry detection ---- */

(function testEntersWithinRadiusGrants() {
  const q = mkQuest();
  const calls = [];
  q._api = stubApi(calls);
  q.viewpoints = [{ zoneId: "vp1", name: "Summit", center: [51.30, -117.05], cells: ["cellA", "cellB"] }];
  q._tickViewpoints({ lat: 51.30, lon: -117.05 }); // right at the center
  assert(q.enteredViewpoints.has("vp1"), "standing at the viewpoint's own center marks it entered");
  assert(q.fogCells.get("cellA") === 1 && q.fogCells.get("cellB") === 1, "both cells granted at state 1");
  assert(calls.length === 1 && calls[0].body.state === 1, "one POST to /api/fog-cells at state 1, got " + JSON.stringify(calls));
})();

(function testOutsideRadiusDoesNotGrant() {
  const q = mkQuest();
  const calls = [];
  q._api = stubApi(calls);
  // ~1.1km east — well outside VIEWPOINT_RADIUS_M (15m default).
  q.viewpoints = [{ zoneId: "vp1", name: "Summit", center: [51.30, -117.05], cells: ["cellA"] }];
  q._tickViewpoints({ lat: 51.30, lon: -117.04 });
  assert(!q.enteredViewpoints.has("vp1"), "far from the viewpoint, entry is not marked");
  assert(calls.length === 0, "no grant/POST when out of range");
})();

(function testOnlyGrantsOncePerSession() {
  const q = mkQuest();
  const calls = [];
  q._api = stubApi(calls);
  q.viewpoints = [{ zoneId: "vp1", name: "Summit", center: [51.30, -117.05], cells: ["cellA"] }];
  q._tickViewpoints({ lat: 51.30, lon: -117.05 });
  q._tickViewpoints({ lat: 51.30, lon: -117.05 }); // lingering — same fix again
  q._tickViewpoints({ lat: 51.3001, lon: -117.05 }); // still within radius, next tick
  assert(calls.length === 1, "a viewpoint only grants once per session even while lingering, got " + calls.length + " calls");
})();

(function testMultipleViewpointsIndependent() {
  const q = mkQuest();
  const calls = [];
  q._api = stubApi(calls);
  q.viewpoints = [
    { zoneId: "vp1", name: "A", center: [51.30, -117.05], cells: ["cellA"] },
    { zoneId: "vp2", name: "B", center: [51.31, -117.06], cells: ["cellB"] }
  ];
  q._tickViewpoints({ lat: 51.30, lon: -117.05 }); // enters only vp1
  assert(q.enteredViewpoints.has("vp1") && !q.enteredViewpoints.has("vp2"), "only the viewpoint actually entered is marked");
  assert(calls.length === 1 && calls[0].body.cells.includes("cellA") && !calls[0].body.cells.includes("cellB"), "only vp1's cells were granted");
})();

/* ---- _grantViewshed: state-aware dedupe, never-downgrade, chunking ---- */

(function testGrantSkipsAlreadySeenCells() {
  const q = mkQuest();
  const calls = [];
  q._api = stubApi(calls);
  q.fogCells.set("cellA", 1); // already granted from an earlier viewpoint
  q._grantViewshed({ zoneId: "vp1", cells: ["cellA", "cellC"] });
  assert(calls.length === 1 && calls[0].body.cells.length === 1 && calls[0].body.cells[0] === "cellC", "only the genuinely new cell is posted, got " + JSON.stringify(calls[0] && calls[0].body));
})();

(function testGrantNeverDowngradesSkiedCell() {
  const q = mkQuest();
  const calls = [];
  q._api = stubApi(calls);
  q.fogCells.set("cellA", 2); // actually skied (R2's state)
  q._grantViewshed({ zoneId: "vp1", cells: ["cellA"] });
  assert(q.fogCells.get("cellA") === 2, "a cell already at state 2 (skied) is never downgraded to 1 by a viewpoint grant, got " + q.fogCells.get("cellA"));
  assert(calls.length === 0, "a cell already at state 2 doesn't even get re-posted (it's not < 1), got " + calls.length + " calls");
})();

(function testGrantNoOpWhenNothingNew() {
  const q = mkQuest();
  const calls = [];
  q._api = stubApi(calls);
  q.fogCells.set("cellA", 1);
  q._grantViewshed({ zoneId: "vp1", cells: ["cellA"] });
  assert(calls.length === 0, "no POST when every cell in the grant is already known, got " + calls.length);
})();

(function testGrantChunksLargeViewsheds() {
  const q = mkQuest();
  const calls = [];
  q._api = stubApi(calls);
  const bigCellSet = Array.from({ length: 1200 }, (_, i) => "cell" + i);
  q._grantViewshed({ zoneId: "vp1", cells: bigCellSet });
  assert(calls.length === 3, "1200 cells at a 500-cell chunk size makes 3 POST calls, got " + calls.length);
  const totalPosted = calls.reduce((sum, c) => sum + c.body.cells.length, 0);
  assert(totalPosted === 1200, "every cell across all chunks is posted exactly once, got " + totalPosted);
  assert(calls.every(c => c.body.cells.length <= 500), "no single chunk exceeds the 500-cell cap");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
