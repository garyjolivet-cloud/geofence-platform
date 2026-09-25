// Armed isolation + armed name labels (ridge-quest.html, 2026-09-25).
// With Guard OFF and chutes armed by press-and-hold:
//   - an unarmed chute/run/hike whose band touches or runs within ARMED_ADJ_PAD_M of an armed
//     corridor ignores GPS (Quest._onFix never ticks it) for as long as that one stays armed;
//   - each armed run shows its name on "My map" (_rebuildArmedLabels).
// Guard ON is unchanged. Extracts the real code from the shipped file.
//
// Run: `node --test tests/quest-armed-isolation.test.js`
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");
const QGeo = eval("(" + html.match(/const QGeo = \{[\s\S]*?\n\};/)[0].replace(/^const QGeo = /, "").replace(/;$/, "") + ")");
const QUEST_TUNING = eval("(" + html.match(/const QUEST_TUNING = \{[\s\S]*?\n\};/)[0].replace(/^const QUEST_TUNING = /, "").replace(/;$/, "") + ")");

function extractBody(tag) {
  const s = html.indexOf(tag);
  if (s < 0) { console.log("FAIL: could not find " + tag); process.exit(1); }
  let depth = 0, i = html.indexOf("{", s); const bodyStart = i + 1;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(bodyStart, i);
}

// Local metres -> [lat,lon] around a Kicking Horse-ish ref.
const REF = [51.3, -117.05];
const ll = (x, y) => [REF[0] + y / QGeo.mPerDegLat, REF[1] + x / QGeo.mPerDegLon(REF[0])];
const cor = (zoneId, pts, widthM, runType) => ({ zoneId, name: "Run " + zoneId, runType: runType || "chute", widthM, ref: REF, path: pts.map(p => ll(p[0], p[1])) });

// ---- QGeo.corridorsTouch ----
const A = cor("A", [[0, 0], [0, 400]], 40);                 // vertical chute, 40 m wide
const B = cor("B", [[-300, 200], [300, 200]], 20, "run");   // crosses A (2 vertices only, far from A)
const C = cor("C", [[30, 0], [30, 400]], 10, "hike");       // parallel: centrelines 30 m apart, bands 5 m apart
const D = cor("D", [[400, 0], [400, 400]], 20, "run");      // far away
const L = cor("L", [[-100, 100], [100, 100]], 10, "lift");  // lift crossing A
const pad = QUEST_TUNING.ARMED_ADJ_PAD_M;
assert(pad === 10, "ARMED_ADJ_PAD_M is 10 m");
assert(QGeo.corridorsTouch(A, B, pad) === true, "crossing lines touch (sparse vertices)");
assert(QGeo.corridorsTouch(A, C, pad) === true, "parallel bands 5 m apart touch");
assert(QGeo.corridorsTouch(A, C, 0) === false, "parallel bands 5 m apart don't touch with no pad");
assert(QGeo.corridorsTouch(A, D, pad) === false, "a run 400 m away doesn't touch");
assert(QGeo.corridorsTouch(A, { path: [ll(0, 0)] }, pad) === false, "a one-point path never touches");

// ---- Quest.refreshIgnoredCorridors (real body) ----
// eslint-disable-next-line no-new-func
const refresh = new Function("QGeo", "QUEST_TUNING", extractBody("refreshIgnoredCorridors(){"));
function mkQuest(master, armed) {
  const Q = { corridors: [A, B, C, D, L], chuteGuardEnabled: true, chuteGuardMaster: master,
    armedCorridors: new Set(armed), ignoredCorridors: new Set(), states: {} };
  Q.refresh = () => refresh.call(Q, QGeo, QUEST_TUNING);
  return Q;
}
let Q = mkQuest(true, ["A"]); Q.refresh();
assert(Q.ignoredCorridors.size === 0, "Guard ON ignores nothing");
Q = mkQuest(false, []); Q.refresh();
assert(Q.ignoredCorridors.size === 0, "Guard OFF with nothing armed ignores nothing");
Q = mkQuest(false, ["A"]); Q.chuteGuardEnabled = false; Q.refresh();
assert(Q.ignoredCorridors.size === 0, "workspace without Corridor Guard ignores nothing");
Q = mkQuest(false, ["A"]);
Q.states.B = { phase: "idle", rec: { buf: [1, 2, 3] } };
Q.refresh();
assert(Q.ignoredCorridors.has("B") && Q.ignoredCorridors.has("C"), "arming A ignores crossing B and parallel C");
assert(!Q.ignoredCorridors.has("D"), "far run D still tracked");
assert(!Q.ignoredCorridors.has("L"), "lifts are never ignored");
assert(!Q.ignoredCorridors.has("A"), "the armed chute itself is tracked");
assert(Q.states.B.rec === null, "a half-recorded run is dropped when it becomes ignored");
Q.armedCorridors.add("B"); Q.refresh();
assert(!Q.ignoredCorridors.has("B") && Q.ignoredCorridors.has("C"), "arming B too makes B tracked again");
Q.chuteGuardMaster = true; Q.refresh();
assert(Q.ignoredCorridors.size === 0, "switching Guard ON clears the ignored set");

// ---- wiring ----
assert(/this\.corridors\.forEach\(corridor=>\{ if\(!this\.ignoredCorridors\.has\(corridor\.zoneId\)\) this\._tick\(/.test(extractBody("_onFix(pos){")),
  "_onFix skips ignored corridors");
assert(/refreshIgnoredCorridors\(\)/.test(extractBody("toggleGuardForCorridor(zoneId){")), "press-and-hold refreshes the ignored set");
assert(/refreshIgnoredCorridors\(\)/.test(extractBody("  setChuteGuardMaster(on){")), "the Guard button refreshes the ignored set");
assert(/refreshIgnoredCorridors\(\)/.test(extractBody("async loadCorridors(){")), "loading corridors refreshes the ignored set");
assert(/refreshIgnoredCorridors\(\)/.test(extractBody("start(onRunLogged, onStatus, selectedActivity, onCoverage){")), "start() refreshes the ignored set");
assert(/_rebuildArmedLabels\(map, cors\)/.test(extractBody("function applyGuardState(){")), "applyGuardState rebuilds armed labels");

// ---- _rebuildArmedLabels (real function, fake Marker/DOM) ----
const markers = [];
class FakeMarker {
  constructor(o) { this.o = o; }
  setLngLat(p) { this.ll = p; return this; }
  addTo() { markers.push(this); return this; }
  remove() { const i = markers.indexOf(this); if (i >= 0) markers.splice(i, 1); }
}
const fakeDoc = { createElement: () => ({ className: "", textContent: "" }) };
const Quest = { chuteGuardEnabled: true, chuteGuardMaster: false, armedCorridors: new Set(["A"]) };
// eslint-disable-next-line no-new-func
const rebuild = new Function("maplibregl", "document", "Quest",
  "let _armedLabelMarkers=[];\nreturn function(map, cors){" + extractBody("function _rebuildArmedLabels(map, cors){") + "};")(
  { Marker: FakeMarker }, fakeDoc, Quest);
const cors = [A, B, C, D, L];
rebuild({}, cors);
assert(markers.length === 1 && markers[0].o.element.textContent === "Run A" && markers[0].o.element.className === "runLabel",
  "one .runLabel with the run's name for the armed run");
Quest.armedCorridors.add("B"); rebuild({}, cors);
assert(markers.length === 2, "arming another run adds its label (old ones replaced, not duplicated)");
Quest.chuteGuardMaster = true; rebuild({}, cors);
assert(markers.length === 0, "Guard ON shows no name labels");
Quest.chuteGuardMaster = false; Quest.armedCorridors.clear(); rebuild({}, cors);
assert(markers.length === 0, "nothing armed shows no name labels");

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
