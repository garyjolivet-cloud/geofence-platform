// Fence Editor: every chute's bearing is its line's start -> finish direction (2026-10-02).
// chuteBearingFromLine + bearingTo are extracted straight out of the shipped file, and the
// wiring (import, per-stop refresh, load-time reconcile) is checked against its source.
//
// Run: `node --test tests/fence-editor-chute-bearing.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8");

function extractFunction(startTag) {
  const startIdx = html.indexOf(startTag);
  if (startIdx < 0) { console.log("FAIL: could not find " + startTag); process.exit(1); }
  let depth = 0, i = html.indexOf("{", startIdx);
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(startIdx, i + 1);
}
// eslint-disable-next-line no-new-func
const chuteBearingFromLine = new Function(
  extractFunction("function bearingTo(a,b){") + "\n" +
  extractFunction("function chuteBearingFromLine(z){") + "\nreturn chuteBearingFromLine;")();

const chute = (coords, extra) => Object.assign({ runType: "chute", bearingDeg: 90, shape: { type: "corridor", coords } }, extra);

(function testDueSouth() {
  const z = chute([[-117, 51.30], [-117, 51.29]]);
  assert(chuteBearingFromLine(z) === true && z.bearingDeg === 180, "a line running south points 180, got " + z.bearingDeg);
})();

(function testUsesEndsNotTheBends() {
  // Wanders east then comes back: start -> finish is still due south.
  const z = chute([[-117, 51.30], [-116.99, 51.297], [-117, 51.29]]);
  chuteBearingFromLine(z);
  assert(z.bearingDeg === 180, "only the start and finish points count, got " + z.bearingDeg);
})();

(function testNorthIsZeroNot360() {
  const z = chute([[-117, 51.29], [-117, 51.30]]);
  chuteBearingFromLine(z);
  assert(z.bearingDeg === 0, "due north is 0, never 360, got " + z.bearingDeg);
})();

(function testUnchangedReportsFalse() {
  const z = chute([[-117, 51.30], [-117, 51.29]], { bearingDeg: 180 });
  assert(chuteBearingFromLine(z) === false && z.bearingDeg === 180, "already right => no change reported");
})();

(function testOnlyChutes() {
  for (const runType of ["run", "lift", "hike", undefined]) {
    const z = chute([[-117, 51.30], [-117, 51.29]], { runType });
    assert(chuteBearingFromLine(z) === false && z.bearingDeg === 90, runType + " keeps its hand-set bearing");
  }
  const circle = { runType: "chute", bearingDeg: 90, shape: { type: "circle", center: [-117, 51.3], radiusM: 20 } };
  assert(chuteBearingFromLine(circle) === false && circle.bearingDeg === 90, "a non-corridor stop is left alone");
})();

(function testDegenerateLines() {
  const one = chute([[-117, 51.3]]);
  const loop = chute([[-117, 51.3], [-116.99, 51.29], [-117, 51.3]]);
  assert(chuteBearingFromLine(one) === false && one.bearingDeg === 90, "a 1-point line is left alone");
  assert(chuteBearingFromLine(loop) === false && loop.bearingDeg === 90, "start == finish has no direction; left alone");
})();

(function testWiring() {
  const imp = extractFunction("async function importCorridorFromLibrary(corridorId){");
  const ref = extractFunction("async function refreshCorridorShapeFromLibrary(z){");
  const rec = extractFunction("async function reconcileLinkedCorridors(){");
  assert(/chuteBearingFromLine\(z\);\s*zones\.push\(z\)/.test(imp), "a chute added from the library gets its bearing");
  assert(/chuteBearingFromLine\(z\);/.test(ref), "the per-stop refresh resets the bearing");
  assert(/for\(const z of corr\)\{ if\(chuteBearingFromLine\(z\)\)\{ bearings\+\+; changed=true; \} \}/.test(rec)
    && rec.indexOf("chuteBearingFromLine") < rec.indexOf("if(changed){ render();"),
    "load-time reconcile sets every chute's bearing before it re-renders (render autosaves the draft)");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
