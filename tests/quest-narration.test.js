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
// inRun: true = the rider is skiing inside some chute or run (the host works it out per fix).
const ctx = (o) => Object.assign({ inRun: true, narrOk: true, onLift: false, now: 1e12, canSay: true, canPrefetch: true }, o);

(function testSideAndText() {
  assert(QN.sideOf === undefined && QN.passingSay === undefined, "no left/right detection (user 2026-10-03: \"remove code for right and left detection\")");
  assert(QN.TUNING.PASS_ANNOUNCE_M === 5, "passing distance is 5 m (user: \"try 5 meters\")");
  assert(Math.abs(QN.bandDist([LAT, mLon(20)], chute()) - 15) < 0.1, "band distance = centreline distance - half width");
})();

(function testAutomaticLine() {
  assert(QN.lineFor({ runType: "chute", name: "Cat Fight", say: null }) === "This is Cat Fight", "no line => \"This is <name>\"");
  assert(QN.lineFor({ runType: "run", name: " Home Run ", say: "  " }) === "This is Home Run", "blank line counts as none; name trimmed");
  assert(QN.lineFor({ runType: "chute", name: "PW", say: "This is Peee Double U" }) === "This is Peee Double U", "an authored line wins");
  assert(QN.lineFor({ runType: "lift", name: "Gondola", say: null }) === null, "a lift with no line stays silent");
})();

(function testFiveMetresInsideARunOnly() {
  const c = chute({ say: null, name: "Cat Fight" });   // centreline lon -117.05, 10 m wide: edge 5 m out
  assert(QN.step({}, c, [LAT, mLon(9)], ctx()).say === "This is Cat Fight", "4 m from its edge, in a run => named");
  assert(QN.step({}, c, [LAT, mLon(11)], ctx()).say === null, "6 m from its edge => beyond 5 m, quiet");
  assert(QN.step({}, c, [LAT, mLon(9)], ctx({ inRun: false })).say === null, "not skiing inside a chute or run => quiet");
  assert(QN.step({}, c, [LAT, mLon(0)], ctx()).say === "This is Cat Fight", "inside it => its line, no side");
})();

(function testOnceAndRearm() {
  const st = {}, c = chute();
  const said = [];
  [60, 9, 6, 0, 9].forEach((m, i) => { const r = QN.step(st, c, [LAT, mLon(m)], ctx({ now: 1e12 + i * 1000 })); if (r.say) said.push(r.say); });
  assert(said.length === 1 && said[0] === "This is Big Dumper", "one announcement per approach, got " + JSON.stringify(said));
  QN.step(st, c, [LAT, mLon(80)], ctx());   // 75 m out: re-armed
  const r = QN.step(st, c, [LAT, mLon(9)], ctx());
  assert(r.say === "This is Big Dumper", "after leaving the area the next pass speaks again");
})();

(function testLiftAndGates() {
  const lift = chute({ runType: "lift", say: "Gondola" });
  let r = QN.step({}, lift, [LAT, mLon(8)], ctx());
  assert(r.say === null, "a lift is not announced when passed beside it");
  r = QN.step({}, lift, [LAT, mLon(0)], ctx({ inRun: false }));
  assert(r.say === "Gondola", "a lift is announced on entering it, plain (no run needed)");
  assert(QN.step({}, chute(), [LAT, mLon(9)], ctx({ onLift: true })).say === null, "on a lift => chutes quiet");
  assert(QN.step({}, chute(), [LAT, mLon(9)], ctx({ narrOk: false })).say === null, "narrOk false => quiet");
  const p = QN.step({}, chute(), [LAT, mLon(150)], ctx());
  assert(p.prefetch.length === 1 && p.say === null, "150 m out: the line is prefetched, nothing said");
  const inside = [{ runType: "run", widthM: 50, path: [[51.310, -117.05], [51.300, -117.05]] }];
  assert(QN.insideRun([LAT, mLon(20)], inside) === true && QN.insideRun([LAT, mLon(30)], inside) === false, "insideRun = inside a chute/run band");
  assert(QN.insideRun([LAT, mLon(0)], [Object.assign({}, inside[0], { runType: "lift" })]) === false, "a lift band is not a run");
})();

// ---- Test Mode wiring (fence-editor.html) ----
const ed = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8");
(function testTestModeWiring() {
  assert(/<script src="\/quest-narration\.js"><\/script>/.test(ed), "the editor loads the shared module");
  assert(/_questOn=!!\(app&&app\.questEnabled\);/.test(ed), "Ridge Quest mode follows the workspace's questEnabled flag");
  assert(/if\(t\.say && _questOn\) return;/.test(ed), "in a Ridge Quest workspace the tour engine's zone-enter line is not spoken");
  assert(/QuestNarration\.step\(st, c, \[sm\.lat,sm\.lon\], \{ inRun, narrOk:questSimNarrOk\(c\)/.test(ed) && /const inRun=QuestNarration\.insideRun\(\[sm\.lat,sm\.lon\], this\.corridors\);/.test(ed),
    "Test Mode feeds the smoothed position and the in-a-run gate, like live");
  assert(/const active=SimFencer\.update\(raw,simPrevRaw,t\);\s*\n\s*\/\/[^\n]*\n\s*try\{ QuestSim\.tick\(sm\); \}/.test(ed), "every simulated fix ticks QuestSim");
  assert((ed.match(/QuestSim\.load\(simBundle\);/g) || []).length === 3, "QuestSim reloads wherever ChuteGuard does (enter, walk, reset)");
  assert(/body:JSON\.stringify\(\{text\}\)/.test(ed.slice(ed.indexOf("const QuestSim={"))), "same voice as live: /api/tts with the text only");
})();

// ---- live (ridge-quest.html) uses the same module ----
const rq = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");
(function testLiveUsesModule() {
  assert(/<script src="\/quest-narration\.js"><\/script>/.test(rq), "ridge-quest loads the shared module");
  assert(/QuestNarration\.step\(st, corridor, \[p\.lat,p\.lon\], \{ inRun:this\._inRunNow, narrOk/.test(rq)
    && /this\._inRunNow = QuestNarration\.insideRun\(/.test(rq), "_tick narrates through the shared module, with the in-a-run gate worked out once per fix");
  assert(!/function passingSay\(|sideOf\(pt, corridor, headingDeg\)\{|on your " \+ side/.test(rq), "no private copy of the narration rules (or left/right) left in ridge-quest");
})();

// ---- Guard ON/OFF in Test Mode (user 2026-10-03: "when guard is off voice is only used for
// selected guard runs", "add guard on off to test"), same rule as live ----
const fnSrc = tag => { const s = ed.slice(ed.indexOf(tag)); return s.slice(0, s.indexOf("\n}") + 2); };
(function testGuardDecidesWhoSpeaks() {
  const body = fnSrc("function _cgTestGuarded(id){") + "\n" + fnSrc("function questSimNarrOk(c){");
  const run = (o, c) => {
    const document = { getElementById: () => ({ checked: o.guardedOnly !== false }) };
    // eslint-disable-next-line no-new-func
    return new Function("document", "_chuteGuardOn", "_cgTestMaster", "_cgMutedIds", "_cgGuardedIds", "_cgDefaultOffIds", "_cgOnIds", body + "\nreturn questSimNarrOk;")(
      document, o.workspace !== false, !!o.master, o.muted || new Set(), o.armed || new Set(), o.defaultOff || new Set(), o.on || new Set())(c);
  };
  const cat = { runType: "chute", zoneId: "cat-fight" }, hal = { runType: "chute", zoneId: "hallowed" };
  const armed = new Set(["cat-fight"]), muted = new Set(["cat-fight"]);
  // Guard OFF: armed only
  assert(run({ master: false, armed }, cat) === true, "Guard OFF: an armed chute speaks");
  assert(run({ master: false, armed }, hal) === false, "Guard OFF: an unarmed chute is silent");
  assert(run({ master: false }, { runType: "lift", zoneId: "gondola" }) === true, "lifts always speak");
  // Guard ON: everything but muted
  assert(run({ master: true }, hal) === true, "Guard ON: every chute speaks");
  assert(run({ master: true, muted }, cat) === false, "Guard ON: a muted chute is silent");
  assert(run({ master: true, muted, armed }, hal) === true, "Guard ON ignores the armed set");
  assert(run({ master: false, muted, armed }, cat) === true, "Guard OFF ignores the muted set (each survives a flip)");
  // Guard defaults: the author set Cat Fight Off for Guard ON
  const off = new Set(["cat-fight"]);
  assert(run({ master: true, defaultOff: off }, cat) === false, "Guard ON: an author-Off run is silent");
  assert(run({ master: true, defaultOff: off, on: new Set(["cat-fight"]) }, cat) === true, "Guard ON: ...until held on");
  assert(run({ master: true, defaultOff: off }, hal) === true, "Guard ON: other runs unaffected");
  assert(run({ master: false, defaultOff: off, armed }, cat) === true, "Guard OFF: arming still works for it");
  // gates that open everything
  assert(run({ master: false, guardedOnly: false }, hal) === true, "setting \"narrate only guarded runs\" off => every run speaks");
  assert(run({ master: false, workspace: false }, hal) === true, "workspace without Corridor Guard => every run speaks");
})();

(function testGuardSwitchWiring() {
  assert(/<button id="simGuard"/.test(ed), "Test Mode has a Guard ON/OFF button");
  assert(/_cgGuardedIds = new Set\(\); _cgMutedIds = new Set\(\); _cgOnIds = new Set\(\); _cgTestMaster = true;/.test(ed), "each Test Mode entry starts Guard ON with nothing muted or armed, like live's default");
  assert(/getActiveAlarm\(id=>_cgTestGuarded\(id\)\)/.test(ed), "the tone follows the same Guard rule");
  const lp = fnSrc("function _simRunLongPressHandler(feature){");
  assert(/if\(_cgTestMaster\)\{[\s\S]*_cgMutedIds[\s\S]*\} else \{[\s\S]*_cgGuardedIds/.test(lp), "press-and-hold mutes with Guard ON and arms with Guard OFF");
  assert(!/_cgGuardedIds\.has\(corridorId\)/.test(ed), "no Guard check left that ignores the ON/OFF switch");
})();

(function testLiveRuleMatches() {
  // live: the same rule with Guard OFF (master false) => only the armed set
  const live = rq.match(/const narrOk = (.*);/);
  assert(!!live && /this\.isGuarded\(corridor\.zoneId\)/.test(live[1]) && /corridor\.runType==="lift"/.test(live[1]),
    "live narrOk uses the same guard rule (isGuarded: master OFF => armed only)");
})();




// ---- speech queue (2026-10-03, "queue so both play") ----
(function testSayQueue() {
  let t = 0; const played = [], log = [];
  let finish = null;
  const q = QN.makeSayQueue({ now: () => t, log: m => log.push(m), play: (text, done) => { played.push(text); finish = done; } });
  q.say("This is Legs Right"); q.say("This is Legs Left");
  assert(played.join("|") === "This is Legs Right", "the second line waits instead of cutting the first off");
  q.say("This is Legs Left");
  assert(q.waiting() === 1, "a line already waiting is not added twice");
  finish();
  assert(played.join("|") === "This is Legs Right|This is Legs Left", "when the first ends, the second plays");
  q.say("A"); q.say("B"); q.say("C"); q.say("D");
  assert(q.waiting() === 3 && log.some(m => /queue full/.test(m)), "at most 3 wait; the oldest drops");
  t += 13000; finish();
  assert(played[played.length - 1] === "This is Legs Left" && log.some(m => /waited too long/.test(m)), "lines that waited over 12 s are skipped");
  assert(q.busy() === false, "queue idle again");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
