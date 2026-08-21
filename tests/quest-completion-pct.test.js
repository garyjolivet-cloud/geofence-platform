// Unit tests for Ridge Quest R11's completion-percentage stat
// (Quest.questCompletionPct in frontend/ridge-quest.html): what fraction of
// a project's own corridor-network H3 footprint a player has actually
// skied/walked (state===2), not just seen from a viewpoint (state===1).
//
// Pure function, no h3/DOM dependency (it takes the already-built preview
// cell Set and fogCells Map as plain arguments) — extracted via brace-depth
// counting straight out of the shipped file, same technique this codebase's
// other quest-*.test.js files use, not a reimplementation.
//
// Run: `node --test tests/quest-completion-pct.test.js` (or as part of the
// full `node --test tests/` suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");

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
const questCompletionPct = new Function(
  "previewCells", "fogCells",
  extractMethodBody("function questCompletionPct(previewCells, fogCells){")
);

(function testEmptyPreviewSetReturnsNull() {
  const pct = questCompletionPct(new Set(), new Map());
  assert(pct === null, "an empty preview-cell set (no corridors / unloaded bundle) returns null, got " + pct);
})();

(function testFullyUnrevealedReturnsZero() {
  const preview = new Set(["a", "b", "c", "d"]);
  const fog = new Map(); // nothing revealed at all
  const pct = questCompletionPct(preview, fog);
  assert(pct === 0, "no revealed cells at all gives 0% (not null), got " + pct);
})();

(function testFullyRevealedReturnsOne() {
  const preview = new Set(["a", "b", "c", "d"]);
  const fog = new Map([["a", 2], ["b", 2], ["c", 2], ["d", 2]]);
  const pct = questCompletionPct(preview, fog);
  assert(pct === 1, "every preview cell skied gives exactly 1.0 (100%), got " + pct);
})();

(function testPartialRevealComputesFraction() {
  const preview = new Set(["a", "b", "c", "d"]);
  const fog = new Map([["a", 2], ["b", 2]]); // 2 of 4 skied
  const pct = questCompletionPct(preview, fog);
  assert(pct === 0.5, "2 of 4 preview cells skied gives exactly 0.5, got " + pct);
})();

(function testViewpointSeenStateDoesNotCount() {
  // A cell only ever granted via a viewpoint (state 1, R4's "seen but not
  // skied" tier) must NOT count toward completion — otherwise standing at
  // a viewpoint could instantly "complete" terrain never actually walked.
  const preview = new Set(["a", "b"]);
  const fog = new Map([["a", 1], ["b", 1]]); // both only "seen", never skied
  const pct = questCompletionPct(preview, fog);
  assert(pct === 0, "viewpoint-granted (state 1) cells don't count toward completion, got " + pct);
})();

(function testCellsOutsidePreviewSetAreIgnored() {
  // Revealed cells that aren't part of THIS project's corridor network
  // (e.g. free-roam GPS wandering, or fog carried over from a different
  // project — Quest.fogCells is global per player, not project-scoped)
  // must not inflate the percentage.
  const preview = new Set(["a", "b"]);
  const fog = new Map([["a", 2], ["b", 2], ["zzz-unrelated-cell", 2]]);
  const pct = questCompletionPct(preview, fog);
  assert(pct === 1, "cells outside the preview set are ignored, not counted as bonus progress, got " + pct);
})();

(function testMissingCellDefaultsToUnrevealed() {
  const preview = new Set(["a", "b", "c"]);
  const fog = new Map([["a", 2]]); // "b" and "c" have no entry at all (Shroud)
  const pct = questCompletionPct(preview, fog);
  assert(Math.abs(pct - (1 / 3)) < 1e-9, "a preview cell with no fogCells entry at all counts as unrevealed, got " + pct);
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
