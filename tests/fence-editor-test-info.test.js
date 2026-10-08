// The Fence Editor's info button in Test Mode (2026-10-08, Gary: "the info button in test need to be updated").
// While editing, "⬤ Key" shows the map handle legend; in Test Mode the same button reads "ⓘ Test guide" and
// explains Test Mode. Its numbers are the real rules -- this test fails when a rule changes and the text doesn't.
//
// Run: `node --test tests/fence-editor-test-info.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const test = require("node:test");
const assert = require("node:assert");

const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\r/g, "");
const fe = read("frontend/fence-editor.html");
const guide = fe.slice(fe.indexOf('<div id="mapKeyTest"'), fe.indexOf("<!-- /mapKeyTest -->"));
const text = guide.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const load = f => { const sb = { window: {} }; vm.createContext(sb); vm.runInContext(read(f), sb); return sb.window; };
const T = load("frontend/quest-core.js").QuestCore.TUNING;
const G = load("frontend/chute-guard.js").ChuteGuard.TUNING;
const N = require("../frontend/quest-narration.js").TUNING;
const kmh = mps => Math.round(mps * 3.6 * 2) / 2;      // to the nearest half km/h, as the guide prints them

test("the guide is there, with every section a tester needs", () => {
  assert.ok(guide.length > 2000, "found #mapKeyTest");
  ["Moving the avatar", "Corridor Guard, chime and voice", "Scoring — Ridge Quest workspaces, same rules as the phone",
   "Today, leaderboard and share images", "The log"].forEach(s => assert.ok(guide.includes('<div class="key-section">' + s + "</div>"), s));
  ["Drag the dot", "Click the map", "Tap a line, then ▶", "Stops are read-only", "Guard ON / OFF", "Tone", "Victory chime", "Voice",
   "What counts", "Pace", "Timing", "Vertical and points", "Today line", "Leaderboard", "Social media", "Nothing is saved",
   "RUN logged", "RUN not counted · RUN no pass · RUN ignored", "Export log"].forEach(b => assert.ok(guide.includes("<b>" + b + "</b>"), b));
  assert.ok(!/<b>[^<]*<\/b>[^<]*<b>/.test(guide.replace(/<div class="key-row-text"><b>/g, "")), "no second <b> inside a row (it is a block heading here)");
});

test("its numbers are the real rules", () => {
  // pace limits (quest-core.js)
  assert.strictEqual(kmh(T.SKI_SPEED_MIN_MPS), 9); assert.ok(text.includes("A run needs at least 9 km/h"));
  assert.strictEqual(kmh(T.CHUTE_SPEED_MIN_MPS), 2.5); assert.ok(text.includes("a chute 2.5 km/h"));
  assert.strictEqual(kmh(T.LIFT_SPEED_MIN_MPS), 6.5); assert.ok(text.includes("a lift 6.5 km/h"));
  assert.strictEqual(kmh(T.HIKE_SPEED_MAX_MPS), 18); assert.ok(text.includes("a boot pack no more than 18 km/h"));
  assert.strictEqual(Math.round(T.MAX_ALONG_SPEED_MPS * 3.6), 162);
  assert.strictEqual((text.match(/162 km\/h/g) || []).length, 2, "the 162 km/h limit, in Moving and in Pace");
  assert.strictEqual(T.CORRIDOR_COMPLETION_PCT, 0.8); assert.ok(text.includes("covering about 80% of it"));
  assert.strictEqual(T.COOLDOWN_MS, 4000); assert.ok(text.includes("only 4 seconds after it was last logged"));
  assert.strictEqual(T.PASS_SETTLE_MS, 15000); assert.ok(text.includes("up to 15 seconds to appear"));
  assert.strictEqual(T.REC_GRACE_S, 15); assert.ok(text.includes("about 15 seconds after the rider has left the line"));
  // guard (chute-guard.js)
  assert.strictEqual(G.DROPIN_PCT, 0.10); assert.ok(text.includes("skiing the first 10% of it"));
  assert.strictEqual(G.FINISH_PCT, 0.90); assert.ok(text.includes("Skied from the top to 90%"));
  assert.ok(/holdMs: 2000,/.test(fe) && text.includes("press and hold a line for 2 seconds"));
  // voice (quest-narration.js)
  assert.strictEqual(N.PASS_ANNOUNCE_M, 5); assert.ok(text.includes("any passed within 5 m are named"));
  assert.strictEqual(N.LIFT_FIRST_M, 10); assert.ok(text.includes("boarded within its first 10 m"));
  // the ▶ paces
  assert.ok(fe.includes('const SIM_RIDE={ lift:{ kmh:30, verb:"Ride up" }, hike:{ kmh:5, verb:"Boot pack up" }, ski:{ kmh:40, verb:"Ski down" } };'));
  assert.ok(text.includes("▶ Ride up (30 km/h)") && text.includes("▶ Ski down (40 km/h)") && text.includes("▶ Boot pack up (5 km/h)"));
  assert.ok(text.includes("Playback runs four times faster than real time") && fe.includes("_simTOffset+=750;"), "250 ms of wall time per simulated second");
  // what the Today line really prints
  assert.ok(text.includes("Vertical · Chutes n/total · Runs n/total · Lift rides · Points") &&
    fe.includes('" · Runs "+t.runsSkied+"/"+t.runsTotal+" · Lift rides "+t.liftRides+" · Points "'));
});

test("one button, two guides: the handle legend while editing, the Test guide while testing", () => {
  const cut = tag => { const s = fe.indexOf(tag); let d = 0, i = fe.indexOf("{", s); for (; i < fe.length; i++) { if (fe[i] === "{") d++; else if (fe[i] === "}") { d--; if (d === 0) break; } } return fe.slice(s, i + 1); };
  const els = {}; const el = id => els[id] || (els[id] = { style: {}, textContent: "", title: "", classList: { toggle(c, on) { els[id].cls = on ? c : ""; } } });
  // eslint-disable-next-line no-new-func
  const api = new Function("document", "let simMode=false;\n" + cut("function showMapKey(){") + "\n" + cut("function paintMapKeyBtn(){") +
    "\nreturn { showMapKey, paintMapKeyBtn, set simMode(v){ simMode=v; } };")({ getElementById: el });
  api.paintMapKeyBtn(); api.showMapKey();
  assert.strictEqual(el("mapKeyBtn").textContent, "⬤ Key");
  assert.deepStrictEqual([el("mapKeyEdit").style.display, el("mapKeyTest").style.display], ["", "none"]);
  api.simMode = true; api.paintMapKeyBtn(); api.showMapKey();
  assert.strictEqual(el("mapKeyBtn").textContent, "ⓘ Test guide");
  assert.deepStrictEqual([el("mapKeyEdit").style.display, el("mapKeyTest").style.display], ["none", ""]);
  assert.ok(fe.includes('<div id="mapKeyEdit">') && fe.includes("</div><!-- /mapKeyEdit -->"), "the legend is kept, wrapped");
  assert.ok(cut("function enterTestMode(){").includes("paintMapKeyBtn();") && cut("function exitTestMode(){").includes("paintMapKeyBtn();"), "relabelled on entering and leaving Test");
  assert.ok(fe.includes('getElementById("mapKeyBtn").onclick=()=>{ showMapKey();'), "the right guide is picked when it opens");
  assert.ok(/#mapKeyOverlay\{display:none;position:fixed;inset:0;z-index:700;/.test(fe), "above the floating palettes (Code Objects is 400)");
});

test("a tapped line's popup is readable on the editor's dark popups", () => {
  const pop = fe.slice(fe.indexOf("function _simRunClick(e){"), fe.indexOf("function _simRunsAt(lngLat, first){"));
  assert.ok(!/color:#0a1018|color:#5b7088|#d5dde6/.test(pop), "no dark-on-dark text (those colours came from the phone's light popup)");
  assert.ok((pop.match(/color:var\(--snow\)/g) || []).length >= 2 && (pop.match(/color:var\(--fog\)/g) || []).length >= 3);
});
