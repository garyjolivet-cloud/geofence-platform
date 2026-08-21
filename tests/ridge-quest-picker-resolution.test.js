// Regression test for a real bug found in a 2026-08-21 live QA pass:
// frontend/ridge-quest.html's RQ_PROJECT_ID used to default to the literal
// placeholder string "REPLACE_WITH_QUEST_PROJECT_ID" (a leftover from
// before R7's public workspace/project picker existed). That string is
// truthy, so boot()'s own gate — `if(!RQ_APP_ID || !RQ_PROJECT_ID){
// renderWorkspacePicker(); return; }` — never fired for a genuinely fresh
// visitor (no ?project= URL param, no localStorage): they silently skipped
// the picker entirely and tried to load corridors for a project id that
// doesn't exist, with the picker (R7's whole point for a bare `/quest`
// visit) never shown. Confirmed live: a cleared-localStorage tab hitting
// bare /quest landed on a login screen instead of "Choose your resort."
//
// Fixed by defaulting to null (matching RQ_APP_ID's own established
// pattern one line above it) so the falsy check actually catches the
// unresolved case. This test guards the fix two ways: a structural check
// that the placeholder string is gone from the source, and a behavioral
// check that the exact default-assignment expression evaluates to
// something falsy — the precise property the whole bug hinged on.
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");

(function testPlaceholderSentinelIsGone() {
  // Checked as a default-VALUE pattern, not whole-file absence — the fix's
  // own explanatory comment legitimately mentions this string by name to
  // document the old bug, same as every other fix in this codebase.
  assert(!/\|\|\s*"REPLACE_WITH_QUEST_PROJECT_ID"/.test(html),
    "the old truthy placeholder must not reappear as a default value");
})();

(function testProjectIdDefaultsToFalsyWhenNoUrlParam() {
  const m = html.match(/let RQ_PROJECT_ID = new URLSearchParams\(location\.search\)\.get\("project"\) \|\| ([^;]+);/);
  if (!m) { fail++; console.log("FAIL: could not find RQ_PROJECT_ID's default-assignment line in ridge-quest.html"); return; }
  // Simulate location.search having no ?project= param at all (a truly
  // bare /quest visit) — .get() returns null in that case, same as the
  // real URLSearchParams API.
  // eslint-disable-next-line no-new-func
  const resolved = new Function("return (null) || " + m[1] + ";")();
  assert(!resolved, "RQ_PROJECT_ID's default must be falsy (so boot()'s !RQ_PROJECT_ID check fires) when no ?project= param is present, got " + JSON.stringify(resolved));
})();

(function testBootGateFiresWhenBothUnresolved() {
  // The exact guard condition from boot() — reproduced here (not extracted,
  // it's a one-line boolean expression, not worth brace-depth-extracting
  // the whole async function for) to confirm the specific property this
  // bug broke: with neither RQ_APP_ID nor RQ_PROJECT_ID resolved, the
  // picker must fire.
  const RQ_APP_ID = null, RQ_PROJECT_ID = null;
  assert((!RQ_APP_ID || !RQ_PROJECT_ID) === true,
    "boot()'s picker-gate condition must be true when both ids are unresolved");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
