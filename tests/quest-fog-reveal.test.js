// Unit tests for Ridge Quest R2's H3 disk-reveal logic
// (Quest._revealFog in frontend/ridge-quest.html): confidence gating,
// dedup against already-revealed cells, local state upgrade, and the
// POST payload sent to /api/fog-cells.
//
// Extracts the real _revealFog method body straight out of the shipped
// file via string slicing (same technique tests/quest-corridor-detection.
// test.js already uses for _classifyAndLog), wrapped as a standalone
// function with `h3` and `api` passed in as stubs — the real H3 grid math
// (latLngToCell/gridDisk) is an external library, not this codebase's own
// logic to verify; what IS this codebase's logic is the gating/dedup/
// upgrade/callback behavior around those two calls, which this tests
// against the real extracted code.
//
// Run: `node --test tests/quest-fog-reveal.test.js` (or as part of the
// full `node --test tests/` suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");

const tuningM = html.match(/const QUEST_TUNING = \{[\s\S]*?\n\};/);
if (!tuningM) { console.log("FAIL: could not extract QUEST_TUNING from ridge-quest.html"); process.exit(1); }
const QUEST_TUNING = eval("(" + tuningM[0].replace(/^const QUEST_TUNING = /, "").replace(/;$/, "") + ")");

const startTag = "_revealFog(p, acc){";
const startIdx = html.indexOf(startTag);
if (startIdx < 0) { console.log("FAIL: could not find _revealFog in ridge-quest.html"); process.exit(1); }
// The method body ends at the closing "  },\n" that precedes the next
// method definition ("_tick(corridor, p, selectedActivity){", R8) — find
// that boundary rather than a fixed-depth brace count, matching this
// codebase's other string-slice extractions.
const nextMethodIdx = html.indexOf("_tick(corridor, p, selectedActivity){", startIdx);
if (nextMethodIdx < 0) { console.log("FAIL: could not find end boundary of _revealFog"); process.exit(1); }
const bodyEnd = html.lastIndexOf("},", nextMethodIdx);
const revealFogBody = html.slice(startIdx + startTag.length, bodyEnd);
// eslint-disable-next-line no-new-func
const revealFog = new Function("p", "acc", "h3", "api", "QUEST_TUNING", revealFogBody);

function mkThis() {
  return { fogCells: new Map(), onFogUpdated: null };
}
function stubH3(originId) {
  // A trivial fake grid: origin is a deterministic string keyed on rounded
  // lat/lon, gridDisk returns the origin plus 6 synthetic neighbor ids —
  // exactly mirrors the real shape (7 cells) without depending on the real
  // H3 library being installed (this repo has zero npm dependencies by
  // design, and h3-js is loaded from a CDN at runtime, not a test-time
  // dependency).
  return {
    latLngToCell(lat, lon) { return originId || ("cell:" + lat.toFixed(3) + "," + lon.toFixed(3)); },
    gridDisk(origin) {
      const out = [origin];
      for (let i = 0; i < 6; i++) out.push(origin + ":n" + i);
      return out;
    }
  };
}
function stubApi(calls) {
  return (path, opts) => { calls.push({ path, body: JSON.parse(opts.body) }); return Promise.resolve({ ok: true }); };
}

(function testLowAccuracySkipsReveal() {
  const self = mkThis();
  const calls = [];
  revealFog.call(self, { lat: 51.3, lon: -117.05 }, QUEST_TUNING.ACCURACY_CAP_M + 1, stubH3(), stubApi(calls), QUEST_TUNING);
  assert(self.fogCells.size === 0, "a fix worse than ACCURACY_CAP_M reveals nothing, got " + self.fogCells.size + " cells");
  assert(calls.length === 0, "a low-accuracy fix never calls the API, got " + calls.length + " calls");
})();

(function testGoodAccuracyRevealsDiskAndPosts() {
  const self = mkThis();
  const calls = [];
  revealFog.call(self, { lat: 51.3, lon: -117.05 }, 10, stubH3("origin1"), stubApi(calls), QUEST_TUNING);
  assert(self.fogCells.size === 7, "a confident fix reveals the origin cell + its 6-cell k=1 ring (7 total), got " + self.fogCells.size);
  assert(self.fogCells.get("origin1") === 2, "revealed cells are stored as state=2 (Visible), got " + self.fogCells.get("origin1"));
  assert(calls.length === 1 && calls[0].path === "/api/fog-cells", "a new-territory reveal POSTs once to /api/fog-cells, got " + JSON.stringify(calls));
  assert(calls[0].body.cells.length === 7 && calls[0].body.state === 2, "the POST body carries all 7 new cells at state 2, got " + JSON.stringify(calls[0].body));
})();

(function testRevisitingKnownTerritoryIsLocalNoOp() {
  const self = mkThis();
  const calls = [];
  const h3 = stubH3("origin2");
  revealFog.call(self, { lat: 51.3, lon: -117.05 }, 10, h3, stubApi(calls), QUEST_TUNING);
  assert(calls.length === 1, "first visit posts once, got " + calls.length);
  revealFog.call(self, { lat: 51.3, lon: -117.05 }, 10, h3, stubApi(calls), QUEST_TUNING);
  assert(calls.length === 1, "revisiting the exact same spot posts nothing new (local dedup), got " + calls.length + " total calls");
})();

(function testPartialOverlapOnlyPostsNewCells() {
  const self = mkThis();
  self.fogCells.set("originA", 2);
  self.fogCells.set("originA:n0", 2);
  const calls = [];
  revealFog.call(self, { lat: 51.3, lon: -117.05 }, 10, stubH3("originA"), stubApi(calls), QUEST_TUNING);
  assert(calls.length === 1, "a partially-overlapping disk still posts, got " + calls.length);
  assert(calls[0].body.cells.length === 5, "only the 5 genuinely-new cells (7 minus 2 already known) are posted, got " + calls[0].body.cells.length);
})();

(function testOnFogUpdatedFiresOnlyWhenSomethingNewRevealed() {
  const self = mkThis();
  let fired = 0;
  self.onFogUpdated = () => { fired++; };
  const h3 = stubH3("origin3");
  revealFog.call(self, { lat: 51.3, lon: -117.05 }, 10, h3, stubApi([]), QUEST_TUNING);
  assert(fired === 1, "onFogUpdated fires once when new cells are revealed, got " + fired);
  revealFog.call(self, { lat: 51.3, lon: -117.05 }, 10, h3, stubApi([]), QUEST_TUNING);
  assert(fired === 1, "onFogUpdated does not fire again for a no-new-cells revisit, got " + fired);
})();

(function testMissingH3LibraryFailsSafe() {
  const self = mkThis();
  const calls = [];
  // typeof h3 === "undefined" inside the extracted body checks the free
  // variable named `h3` — passing JS's own `undefined` for that parameter
  // reproduces exactly the "CDN script blocked/offline" case.
  revealFog.call(self, { lat: 51.3, lon: -117.05 }, 10, undefined, stubApi(calls), QUEST_TUNING);
  assert(self.fogCells.size === 0, "a missing h3 library reveals nothing rather than throwing, got " + self.fogCells.size);
  assert(calls.length === 0, "a missing h3 library never calls the API, got " + calls.length);
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
