// Unit tests for the "My map" gold-medal marker (frontend/ridge-quest.html):
// medalEligible(run) decides whether a just-logged run should ever credit a
// medal at all (mirrors the backend's /chutes/completed WHERE clause
// exactly — run_type='chute' AND activity='ski', so a hike UP a chute never
// counts), and medalCandidates(cors, completedChuteIds) decides which
// corridors currently get a marker drawn (decoupled from map.project() so
// it's testable with no real MapLibre map).
//
// Pure functions, extracted via brace-depth counting straight out of the
// shipped file, same technique this codebase's other quest-*.test.js files
// use (see quest-completion-pct.test.js), not a reimplementation.
//
// Run: `node --test tests/quest-medal-eligibility.test.js` (or as part of
// the full `node --test tests/` suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");

function extractFunctionBody(startTag) {
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
const medalEligible = new Function(
  "run",
  extractFunctionBody("function medalEligible(run){")
);
// eslint-disable-next-line no-new-func
const medalCandidates = new Function(
  "cors", "completedChuteIds",
  extractFunctionBody("function medalCandidates(cors, completedChuteIds){")
);

(function testChuteSkiedIsEligible() {
  const run = { runType: "chute", activity: "ski", zoneId: "z1" };
  assert(medalEligible(run) === true, "a completed chute skied down is medal-eligible");
})();

(function testChuteHikedIsNotEligible() {
  // Ascending a chute logs activity='hike' per the run-verification rules —
  // the medal means "you skied it," so a hike-up must not count.
  const run = { runType: "chute", activity: "hike", zoneId: "z1" };
  assert(medalEligible(run) === false, "a chute reached by hiking UP is not medal-eligible, got true");
})();

(function testRunTypeRunIsNotEligible() {
  const run = { runType: "run", activity: "ski", zoneId: "z1" };
  assert(medalEligible(run) === false, "a plain 'run' corridor (not a chute) is not medal-eligible, got true");
})();

(function testLiftIsNotEligible() {
  const run = { runType: "lift", activity: "ski", zoneId: "z1" };
  assert(medalEligible(run) === false, "a lift corridor is never medal-eligible, got true");
})();

(function testNullRunIsNotEligible() {
  assert(medalEligible(null) === false, "a null run is not medal-eligible, got true");
})();

(function testCandidatesOnlyReturnsCompletedChutes() {
  const cors = [
    { zoneId: "a", runType: "chute", path: [[1, 1], [2, 2]] },
    { zoneId: "b", runType: "chute", path: [[1, 1], [2, 2]] }, // not completed
    { zoneId: "c", runType: "run", path: [[1, 1], [2, 2]] },   // completed but not a chute
  ];
  const completed = new Set(["a", "c"]);
  const vis = medalCandidates(cors, completed);
  assert(vis.length === 1 && vis[0].zoneId === "a", "only completed CHUTE corridors are candidates, got " + JSON.stringify(vis.map(c => c.zoneId)));
})();

(function testCandidatesRequireAtLeastTwoPoints() {
  const cors = [{ zoneId: "a", runType: "chute", path: [[1, 1]] }]; // degenerate
  const vis = medalCandidates(cors, new Set(["a"]));
  assert(vis.length === 0, "a corridor with <2 points is never a medal candidate, got " + vis.length);
})();

(function testCandidatesEmptyWhenNoneCompleted() {
  const cors = [{ zoneId: "a", runType: "chute", path: [[1, 1], [2, 2]] }];
  const vis = medalCandidates(cors, new Set());
  assert(vis.length === 0, "no candidates when completedChuteIds is empty, got " + vis.length);
})();

(function testBottomPointIsLastCoordinate() {
  // medalCandidates itself doesn't resolve the marker point (that's
  // _rebuildMedalMarkers' bottomOf(), which needs a real map to test
  // end-to-end) — this just documents/locks the authored-top-to-bottom
  // convention the candidate's own path array must support.
  const cors = [{ zoneId: "a", runType: "chute", path: [[10, 10], [20, 20], [30, 30]] }];
  const vis = medalCandidates(cors, new Set(["a"]));
  const bottom = vis[0].path[vis[0].path.length - 1];
  assert(bottom[0] === 30 && bottom[1] === 30, "the corridor's last coordinate is its authored bottom, got " + JSON.stringify(bottom));
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
