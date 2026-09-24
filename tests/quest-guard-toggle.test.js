// Unit tests for Ridge Quest's Corridor Guard on/off (frontend/ridge-quest.html):
//   - Guard is ON for every chute/run by default (getChuteGuardMaster)
//   - isCorridorGuarded: workspace flag AND (master on and not muted, OR master off and armed by hand)
//   - Quest.toggleGuardForCorridor: press-and-hold MUTES with the master on, ARMS with the master off
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
const isCorridorGuarded = new Function("workspaceOn", "masterOn", "mutedSet", "armedSet", "id",
  extractBody("function isCorridorGuarded(workspaceOn, masterOn, mutedSet, armedSet, id){"));
// eslint-disable-next-line no-new-func
const toggleGuard = new Function("setMutedCorridors", "setArmedCorridors", extractBody("toggleGuardForCorridor(zoneId){").replace(/^/, "return function(zoneId){") + "};");
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
  assert(isCorridorGuarded(true, true, new Set(), new Set(), "a") === true, "workspace on + master on + nothing muted => every chute is guarded");
})();

(function testMasterOffSilencesEverything() {
  assert(isCorridorGuarded(true, false, new Set(), new Set(), "a") === false, "master off silences every chute");
})();

(function testMutedChuteIsSilentOthersStillGuard() {
  const muted = new Set(["a"]);
  assert(isCorridorGuarded(true, true, muted, new Set(), "a") === false, "a muted chute is not guarded");
  assert(isCorridorGuarded(true, true, muted, new Set(), "b") === true, "other chutes still are");
})();

(function testWorkspaceFlagOffSilencesEverything() {
  assert(isCorridorGuarded(false, true, new Set(), new Set(), "a") === false, "a workspace without Corridor Guard never alerts, whatever the rider's switch says");
  assert(isCorridorGuarded(undefined, true, new Set(), new Set(), "a") === false, "the flag being unset (not loaded yet) counts as off");
})();

(function testUnmutingRestoresGuarding() {
  const muted = new Set(["a"]);
  muted.delete("a");
  assert(isCorridorGuarded(true, true, muted, new Set(), "a") === true, "un-muting a chute guards it again");
})();

// ---- master OFF: guard only the runs armed by hand ----

(function testMasterOffGuardsOnlyArmedRuns() {
  const armed = new Set(["a"]);
  assert(isCorridorGuarded(true, false, new Set(), armed, "a") === true, "master OFF + armed => that run IS guarded (its boundary lines draw too)");
  assert(isCorridorGuarded(true, false, new Set(), armed, "b") === false, "master OFF + not armed => not guarded");
})();

(function testArmedSetIsIgnoredWhileMasterIsOn() {
  // Everything is guarded when ON; being in the armed set changes nothing, and
  // the set survives so the rider's picks come back when they turn Guard OFF again.
  assert(isCorridorGuarded(true, true, new Set(), new Set(["a"]), "b") === true, "master ON guards runs regardless of the armed set");
})();

(function testMutedSetIsIgnoredWhileMasterIsOff() {
  // A run muted while ON must not silence an armed run once the master is OFF.
  assert(isCorridorGuarded(true, false, new Set(["a"]), new Set(["a"]), "a") === true, "an armed run stays guarded even if it was muted earlier");
})();

(function testWorkspaceOffBeatsArming() {
  assert(isCorridorGuarded(false, false, new Set(), new Set(["a"]), "a") === false, "a workspace without Corridor Guard never alerts, even for an armed run");
})();

// ---- toggleGuardForCorridor: what press-and-hold does ----

function holdRig(masterOn) {
  const savedMuted = [], savedArmed = [];
  const fn = toggleGuard(ids => savedMuted.push(ids), ids => savedArmed.push(ids));
  const self = { chuteGuardMaster: masterOn, mutedCorridors: new Set(), armedCorridors: new Set() };
  return { self, hold: id => fn.call(self, id), savedMuted, savedArmed };
}

(function testHoldMutesWhileMasterIsOn() {
  const r = holdRig(true);
  const first = r.hold("z1");
  assert(first === false && r.self.mutedCorridors.has("z1"), "master ON: first hold MUTES the run and reports it is no longer guarded");
  const second = r.hold("z1");
  assert(second === true && !r.self.mutedCorridors.has("z1"), "master ON: second hold un-mutes it (guarded again)");
  assert(r.savedMuted.length === 2 && r.savedMuted[0].join() === "z1" && r.savedMuted[1].length === 0, "mutes are persisted, got " + JSON.stringify(r.savedMuted));
  assert(r.self.armedCorridors.size === 0 && r.savedArmed.length === 0, "master ON: the armed set is never touched");
})();

(function testHoldTurnsGuardONForThatRunWhileMasterIsOff() {
  // THE REPORTED BUG: with Guard off, holding a run used to add it to the MUTED
  // set (i.e. "turn guard off" for a run that was already unguarded).
  const r = holdRig(false);
  const first = r.hold("z1");
  assert(first === true && r.self.armedCorridors.has("z1"), "master OFF: hold ARMS that run and reports it is now guarded");
  assert(r.self.mutedCorridors.size === 0 && r.savedMuted.length === 0, "master OFF: hold must not touch the muted set (that was the bug)");
  const second = r.hold("z1");
  assert(second === false && !r.self.armedCorridors.has("z1"), "master OFF: holding an armed run again turns its guard back off");
  assert(r.savedArmed.length === 2 && r.savedArmed[0].join() === "z1" && r.savedArmed[1].length === 0, "arming is persisted, got " + JSON.stringify(r.savedArmed));
})();

(function testHoldWhileOffThenIsGuardedEndToEnd() {
  const r = holdRig(false);
  r.hold("z1");
  assert(isCorridorGuarded(true, r.self.chuteGuardMaster, r.self.mutedCorridors, r.self.armedCorridors, "z1") === true, "after holding a run with Guard OFF, that run alerts");
  assert(isCorridorGuarded(true, r.self.chuteGuardMaster, r.self.mutedCorridors, r.self.armedCorridors, "z2") === false, "and other runs still do not");
})();

// ---- boundary lines stay wired up (regression, 2026-09-23) ----
// The yellow trigger-boundary lines were dropped once without being asked for
// (guarding moved to on-by-default, so the old `guarded` flag — which also turns
// the corridor cyan — was no longer set). They are keyed on `guardEdges` now.
// This can't render a map, but it stops the wiring from silently disappearing again.
const tileFog = fs.readFileSync(path.join(__dirname, "../frontend/tile-fog.js"), "utf8");
(function testBoundaryLinesAreWiredEndToEnd() {
  assert(/guardEdges/.test(tileFog) && /-edge-r[\s\S]{0,80}filter:\s*guardedAndAlertable/.test(tileFog),
    "tile-fog.js draws the -edge-r/-edge-l boundary lines for guardEdges corridors");
  assert(/const edgesExpr = \["any", guardedExpr, \["==", \["get", "guardEdges"\], true\]\]/.test(tileFog),
    "the property-based boundary-line filter still accepts guardEdges/guarded (every other host unchanged)");
  assert(/guardByState:\s*true/.test(html) && /promoteId:\s*"id"/.test(html),
    "ridge-quest.html builds its runLines source with promoteId and opts into guardByState");
  assert(/const edgeOpacity = stateMode \? \["case", \["boolean", \["feature-state", "guardEdges"\], false\], 1, 0\]/.test(tileFog),
    "in state mode the boundary lines' opacity reads the guardEdges feature-state");
  assert(/if\(this\.onGuardChanged\) this\.onGuardChanged\(\)/.test(html) && /Quest\.onGuardChanged = applyGuardState/.test(html),
    "the lines redraw live when the master button or a hold changes");
  assert(!/guarded:Quest\./.test(html), "Ridge Quest must not set `guarded` (it would recolor every corridor cyan)");
})();

// ---- toggling Guard must not reload the map data (regression, 2026-09-23) ----
// Turning Guard OFF used to take seconds to clear the yellow lines: the look was a
// feature PROPERTY, so every toggle called source.setData(), which reloads and
// re-drapes every tile. It is per-feature STATE now (no data reload). Fail loudly
// if anyone puts a setData() back into that path.
(function testGuardToggleNeverReloadsTheSource() {
  const body = extractBody("function applyGuardState(){");
  assert(body.length > 0, "found applyGuardState in ridge-quest.html");
  assert(/setFeatureState/.test(body), "applyGuardState uses setFeatureState");
  assert(!/setData/.test(body), "applyGuardState must NOT call setData (that reloads every tile; it took seconds on a phone)");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
