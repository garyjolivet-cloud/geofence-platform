// frontend/quest-narration.js (2026-10-02): the ONE narration decision both ridge-quest.html
// (live) and fence-editor.html Test Mode run, so Test Mode is exactly like live.
// ridge-quest's _tick is exercised end to end in quest-corridor-detection.test.js; this file
// pins the module itself and the Test Mode wiring.
//
// Run: `node --test tests/quest-narration.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");
const QN = require("../frontend/quest-narration.js");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const LAT = 51.305, mLon = m => -117.05 + m / (111320 * Math.cos(LAT * Math.PI / 180));
const chute = (extra) => Object.assign({ runType: "chute", widthM: 10, say: "This is Big Dumper",
  path: [[51.310, -117.05], [51.300, -117.05]] }, extra);
const ctx = (o) => Object.assign({ headingDeg: 180, narrOk: true, onLift: false, now: 1e12, canSay: true, canPrefetch: true }, o);

(function testSideAndText() {
  assert(QN.sideOf([LAT, mLon(20)], chute(), 180) === "right", "skiing south, chute to the west => right");
  assert(QN.sideOf([LAT, mLon(20)], chute(), 0) === "left", "skiing north => left");
  assert(QN.sideOf([LAT, mLon(20)], chute(), 270) === null, "straight ahead => no side");
  assert(QN.sideOf([LAT, mLon(20)], chute(), null) === null, "no heading => no side");
  assert(QN.passingSay("This is X.", "left") === "This is X, on your left", "text");
  assert(Math.abs(QN.bandDist([LAT, mLon(20)], chute()) - 15) < 0.1, "band distance = centreline distance - half width");
})();

(function testOnceAndRearm() {
  const st = {}, c = chute();
  const said = [];
  [60, 25, 10, 0, 25].forEach((m, i) => { const r = QN.step(st, c, [LAT, mLon(m)], ctx({ now: 1e12 + i * 1000 })); if (r.say) said.push(r.say); });
  assert(said.length === 1 && said[0] === "This is Big Dumper, on your right", "one announcement per approach, got " + JSON.stringify(said));
  QN.step(st, c, [LAT, mLon(80)], ctx());   // 75 m out: re-armed
  const r = QN.step(st, c, [LAT, mLon(20)], ctx());
  assert(r.say === "This is Big Dumper, on your right", "after leaving the area the next pass speaks again");
})();

(function testLiftAndGates() {
  const lift = chute({ runType: "lift", say: "Gondola" });
  let r = QN.step({}, lift, [LAT, mLon(20)], ctx());
  assert(r.say === null, "a lift is not announced when passed beside it");
  r = QN.step({}, lift, [LAT, mLon(0)], ctx());
  assert(r.say === "Gondola", "a lift is announced on entering it, plain");
  assert(QN.step({}, chute(), [LAT, mLon(20)], ctx({ onLift: true })).say === null, "on a lift => chutes quiet");
  assert(QN.step({}, chute(), [LAT, mLon(20)], ctx({ narrOk: false })).say === null, "narrOk false => quiet");
  const p = QN.step({}, chute(), [LAT, mLon(150)], ctx());
  assert(p.prefetch.length === 2 && p.say === null, "150 m out: both side lines prefetched, nothing said");
})();

// ---- Test Mode wiring (fence-editor.html) ----
const ed = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8");
(function testTestModeWiring() {
  assert(/<script src="\/quest-narration\.js"><\/script>/.test(ed), "the editor loads the shared module");
  assert(/_questOn=!!\(app&&app\.questEnabled\);/.test(ed), "Ridge Quest mode follows the workspace's questEnabled flag");
  assert(/if\(t\.say && _questOn\) return;/.test(ed), "in a Ridge Quest workspace the tour engine's zone-enter line is not spoken");
  assert(/QuestNarration\.step\(st, c, \[sm\.lat,sm\.lon\], \{ headingDeg:sm\.headingTravel/.test(ed),
    "Test Mode feeds the smoothed position + travel heading, like live");
  assert(/const active=SimFencer\.update\(raw,simPrevRaw,t\);\s*\n\s*\/\/[^\n]*\n\s*try\{ QuestSim\.tick\(sm\); \}/.test(ed), "every simulated fix ticks QuestSim");
  assert((ed.match(/QuestSim\.load\(simBundle\);/g) || []).length === 3, "QuestSim reloads wherever ChuteGuard does (enter, walk, reset)");
  assert(/body:JSON\.stringify\(\{text\}\)/.test(ed.slice(ed.indexOf("const QuestSim={"))), "same voice as live: /api/tts with the text only");
})();

// ---- live (ridge-quest.html) uses the same module ----
const rq = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");
(function testLiveUsesModule() {
  assert(/<script src="\/quest-narration\.js"><\/script>/.test(rq), "ridge-quest loads the shared module");
  assert(/QuestNarration\.step\(st, corridor, \[p\.lat,p\.lon\], \{ headingDeg:p\.headingTravel/.test(rq), "_tick narrates through the shared module");
  assert(!/function passingSay\(|sideOf\(pt, corridor, headingDeg\)\{/.test(rq), "no private copy of the narration rules left in ridge-quest");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
