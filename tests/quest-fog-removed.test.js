// Fog of war and tile art were REMOVED from Ridge Quest (2026-09-24). Neither was in use (fog off
// for every app with Ridge Quest enabled, tile art off everywhere). This pins that the client no
// longer loads, tracks, draws or POSTs any of it — and that the things that lived NEXT to it in the
// same code still work: Home's "navigated away" guard, the Corridor Guard notice, the activity
// filter, and drawing every run on My map.
//
// Run: `node --test tests/quest-fog-removed.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8").replace(/\r/g, "");
const code = html.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");   // ignore comments

test("no fog of war or tile art left in the client", () => {
  for (const banned of ["h3-js", "/api/fog-cells", "/fog\"", "fogCells", "RQ_FOG_ENABLED", "fogEnabled", "tileArtEnabled",
    "_revealFog", "onFogUpdated", "loadFogCells", "shroud", "corridorPreview", "questCompletionPct", "exploredPct",
    "viewshed", "_tickViewpoints", "enteredViewpoints", "FOG_RESOLUTION", "h3.latLngToCell", "h3.cellToBoundary"]) {
    assert.ok(!code.includes(banned), "still references " + banned);
  }
});

test("no third-party h3 script is loaded", () => {
  assert.ok(!/<script[^>]+h3-js/.test(html));
});

test("Quest.start has no dead fog-callback slot, and its only caller matches", () => {
  assert.ok(html.includes("start(onRunLogged, onStatus, selectedActivity, onCoverage){"));
  const callers = html.split(String.fromCharCode(10)).filter(l => l.includes("Quest.start(") && !l.trim().startsWith("//"));
  assert.strictEqual(callers.length, 1, "exactly one caller: " + JSON.stringify(callers));
  assert.ok(callers[0].includes("}, onStatus, selectedActivity, onCoverage);"), callers[0]);
});

test("Home's async block keeps its navigated-away guard ahead of the Guard notice and activity filter", () => {
  const i = html.indexOf("await Quest.loadCorridors();");
  assert.ok(i > 0, "loads corridors only (no fog cells)");
  const guard = html.indexOf('if(!document.getElementById("todayRuns")) return;', i);
  const notice = html.indexOf("rq.guardDefaultOnNoticeShown", i);
  const filter = html.indexOf('if(typeof applyActivityFilter==="function") applyActivityFilter();', i);
  assert.ok(guard > i && notice > guard && filter > notice, "guard -> notice -> activity filter, in that order");
  assert.ok(html.includes('id="todayRuns"'), "the guard element exists on Home");
});

test("My map draws every run unconditionally on load (plain-lines map)", () => {
  assert.ok(/map\.on\("load", \(\)=>\{\s*\/\/[^\n]*\n\s*drawNamedPeaks\(map\);\s*drawAllRuns\(map\);/.test(html));
});

test("map bounds come from the corridors and the project ref only", () => {
  const fn = html.slice(html.indexOf("function questMapBounds(){"), html.indexOf("function questMapBounds(){") + 500);
  assert.ok(fn.includes("Quest.corridors.forEach") && !fn.includes("fog"));
  const content = html.slice(html.indexOf("function questContentBounds(){"), html.indexOf("function questContentBounds(){") + 500);
  assert.ok(!content.includes("viewpoints"));
});
