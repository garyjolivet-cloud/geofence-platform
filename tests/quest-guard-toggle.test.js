// Unit tests for Ridge Quest's Corridor Guard on/off (frontend/ridge-quest.html):
//   - Guard is ON for every chute/run by default (getChuteGuardMaster)
//   - isCorridorGuarded: workspace flag AND master switch AND not muted
//   - Quest.toggleMutedCorridor: press-and-hold mutes/unmutes one chute and persists it
//
// Extracted straight out of the shipped file (same technique as
// quest-completion-pct.test.js), so this tests the code that ships. The yellow
// buttons' DOM wiring is checked by hand in a browser.
//
// Run: `node --test tests/quest-guard-toggle.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");

function extractBody(startTag) {
  const startIdx = html.indexOf(startTag);
  if (startIdx < 0) { console.log("FAIL: could not find " + startTag); process.exit(1); }
  let depth = 0, i = html.indexOf("{", startIdx);
  const bodyStart = i + 1;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(bodyStart, i);
}
// eslint-disable-next-line no-new-func
const getChuteGuardMaster = new Function("localStorage", extractBody("function getChuteGuardMaster(){"));
// eslint-disable-next-line no-new-func
const isCorridorGuarded = new Function("workspaceOn", "masterOn", "mutedSet", "id",
  extractBody("function isCorridorGuarded(workspaceOn, masterOn, mutedSet, id){"));
// eslint-disable-next-line no-new-func
const toggleMuted = new Function("setMutedCorridors", extractBody("toggleMutedCorridor(zoneId){").replace(/^/, "return function(zoneId){") + "};");
const store = v => ({ getItem: () => v });

// ---- default ON ----

(function testOnByDefault() {
  assert(getChuteGuardMaster(store(null)) === true, "with nothing stored, Corridor Guard is ON for everything");
})();

(function testStoredOffTurnsItOff() {
  assert(getChuteGuardMaster(store("off")) === false, "a stored 'off' turns the master switch off");
})();

(function testStoredOnStaysOn() {
  assert(getChuteGuardMaster(store("on")) === true, "a stored 'on' keeps it on");
})();

(function testBrokenStorageFailsOn() {
  // Private mode / blocked storage throws — a safety feature must fail ON, not silently off.
  const broken = { getItem() { throw new Error("blocked"); } };
  assert(getChuteGuardMaster(broken) === true, "if localStorage throws, Guard stays ON");
})();

// ---- isCorridorGuarded ----

(function testGuardedByDefault() {
  assert(isCorridorGuarded(true, true, new Set(), "a") === true, "workspace on + master on + nothing muted => every chute is guarded");
})();

(function testMasterOffSilencesEverything() {
  assert(isCorridorGuarded(true, false, new Set(), "a") === false, "master off silences every chute");
})();

(function testMutedChuteIsSilentOthersStillGuard() {
  const muted = new Set(["a"]);
  assert(isCorridorGuarded(true, true, muted, "a") === false, "a muted chute is not guarded");
  assert(isCorridorGuarded(true, true, muted, "b") === true, "other chutes still are");
})();

(function testWorkspaceFlagOffSilencesEverything() {
  assert(isCorridorGuarded(false, true, new Set(), "a") === false, "a workspace without Corridor Guard never alerts, whatever the rider's switch says");
  assert(isCorridorGuarded(undefined, true, new Set(), "a") === false, "the flag being unset (not loaded yet) counts as off");
})();

(function testUnmutingRestoresGuarding() {
  const muted = new Set(["a"]);
  muted.delete("a");
  assert(isCorridorGuarded(true, true, muted, "a") === true, "un-muting a chute guards it again");
})();

// ---- toggleMutedCorridor ----

(function testPressAndHoldMutesThenUnmutes() {
  const saved = [];
  const fn = toggleMuted(ids => saved.push(ids));
  const self = { mutedCorridors: new Set() };
  const first = fn.call(self, "z1");
  assert(first === true && self.mutedCorridors.has("z1"), "first press-and-hold mutes the chute and reports muted=true");
  const second = fn.call(self, "z1");
  assert(second === false && !self.mutedCorridors.has("z1"), "second press-and-hold unmutes it and reports muted=false");
  assert(saved.length === 2 && saved[0].join() === "z1" && saved[1].length === 0, "every toggle is persisted, got " + JSON.stringify(saved));
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
