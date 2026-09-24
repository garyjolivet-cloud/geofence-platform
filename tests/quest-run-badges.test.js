// Ridge Quest's map no longer draws run NAMES as text (removed 2026-09-23): the
// zoomed-in labels landed on top of neighbouring chutes' names and were unreadable.
// A run's name comes from tapping it (showRunPopup), which works well.
//
// This pins that decision — and what must STAY: the tap popup, the small ◆/◆◆
// difficulty badges, and the named-peak labels (different things, not chute names).
// Source-level checks (the code is DOM/MapLibre bound), extracted from the shipped file.
//
// Run: `node --test tests/quest-run-badges.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");

function extractBody(startTag) {
  const startIdx = html.indexOf(startTag);
  if (startIdx < 0) return "";
  let depth = 0, i = html.indexOf("{", startIdx);
  const bodyStart = i + 1;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(bodyStart, i);
}

(function testNoRunNameTextOnTheMap() {
  assert(!/className\s*=\s*"runLabel"/.test(html), "no run-name text marker is created (class runLabel)");
  assert(!/\.runLabel\s*\{/.test(html), "the .runLabel style is gone");
  assert(!/_rebuildRunLabels|RUN_LABEL_MAX_VISIBLE|_runLabelMarkers/.test(html), "the old run-label function/constants are gone");
  const body = extractBody("function _rebuildRunBadges(map, cors){");
  assert(body.length > 0, "found _rebuildRunBadges");
  assert(!/textContent\s*=\s*c\.name/.test(body) && !/c\.name/.test(body), "the badge builder never writes a run name onto the map");
})();

(function testWhatMustStay() {
  const body = extractBody("function _rebuildRunBadges(map, cors){");
  assert(/runDiamond/.test(body) && /dblack/.test(body), "the ◆/◆◆ difficulty badges are still built");
  assert(/function showRunPopup\(/.test(html) && /onTap:\s*showRunPopup/.test(html), "tapping a run still shows its name (showRunPopup)");
  assert(/_rebuildRunBadges\(map,\s*cors\)/.test(html), "the badges are still rebuilt on the map");
  assert(/className\s*=\s*"peakLabel"/.test(html) && /function _rebuildPeakLabels\(/.test(html), "named-peak labels are untouched (they are mountains, not chutes)");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
