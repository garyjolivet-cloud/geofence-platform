// Fence Editor Test Mode is a true Ridge Quest simulator (2026-10-08, Gary: "test needs to be a true
// simulator. score chutes runs and social media need to be part of test ... use the admin login
// name for the test data created. only today data will be used no year to date or saving").
//
// The run engine is the phone's own: frontend/quest-core.js, mixed into ridge-quest.html's Quest AND
// into the editor's QuestRunSim. These tests run that real engine through the editor's real wiring
// (functions extracted from fence-editor.html), and pin that nothing is saved.
//
// Run: `node --test tests/fence-editor-test-mode-scoring.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const test = require("node:test");
const assert = require("node:assert");

const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\r/g, "");
const fe = read("frontend/fence-editor.html"), rq = read("frontend/ridge-quest.html"), core = read("frontend/quest-core.js"), worker = read("backend/worker.js");
function extract(src, tag) {
  const s = src.indexOf(tag);
  assert.ok(s >= 0, "found " + tag);
  let d = 0, i = src.indexOf("{", s);
  for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}") { d--; if (d === 0) break; } }
  return src.slice(s, i + 1);
}
const sb = { window: {} }; vm.createContext(sb); vm.runInContext(core, sb);
const QuestCore = sb.window.QuestCore;
require("../frontend/social-card.js"); require("../frontend/quest-sim-day.js"); require("../frontend/ridge-visuals.js");
const { QuestSimDay, RidgeVisuals } = globalThis;

// ---- the editor's own engine wiring, run against a fake page ----
function editor(opts) {
  opts = opts || {};
  const log = [], toasts = [], scored = [], els = {};
  const el = id => els[id] || (els[id] = { style: {}, textContent: "" });
  const env = {
    QuestCore, QuestSimDay, RidgeVisuals,
    document: { getElementById: el },
    localStorage: { getItem: k => (k === "gp.user" ? opts.user : null) },
    simLogEv: (cls, msg) => log.push(msg), toast: m => toasts.push(m),
    fetch: async (url, o) => { scored.push({ url, body: JSON.parse(o.body), method: o.method });
      if (opts.offline) throw new Error("offline");
      return { ok: true, json: async () => ({ ok: true, points: 492, snowBonus: 1 }) }; }
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const api = new Function(...names, "let _questOn = " + (opts.questOff ? "false" : "true") + ";\n" +
    "let QuestRunSim=null, _simDay=null, _simTrack=[];\n" +
    ["function simRiderName(){", "function questRunSimCorridors(bundle){", "function questRunSimLoad(bundle, newDay){",
     "function questRunSimTick(raw, sm, t){", "async function simScoreRun(run){", "function paintSimToday(){"].map(t => extract(fe, t)).join("\n") +
    "\nconst SIM_ACTIVITY_WORD={ ski:\"ski\", hike:\"boot pack\", lift:\"lift ride\" };" +
    "\nreturn { questRunSimLoad, questRunSimTick, simRiderName, get sim(){ return QuestRunSim; }, get day(){ return _simDay; }, get track(){ return _simTrack; } };")
    (...names.map(k => env[k]));
  return { api, log, toasts, scored, el };
}

// A 400 m chute running south from its top, 20 m wide, 120 m of authored descent; and a 400 m lift beside it.
const TOP = [51.31, -117.05], M = 1 / 111320;
const at = (southM, eastM) => ({ lat: TOP[0] - southM * M, lon: TOP[1] + (eastM || 0) * M / Math.cos(TOP[0] * Math.PI / 180) });
const linePath = (eastM) => [0, 100, 200, 300, 400].map(s => { const p = at(s, eastM); return [p.lat, p.lon]; });
const zone = (id, name, runType, eastM, geo) => ({ id, name, runType, difficulty: runType === "chute" ? "double-black" : null,
  layers: [{ kind: "general", radiusM: 60 }, { kind: "target", geometry: Object.assign({ type: "corridor", path: linePath(eastM), widthM: 20 }, geo) }] });
const bundle = { ref: [51.308, -117.05], zones: [
  zone("main-dumper", "Main Dumper", "chute", 0, { descentM: 120, climbM: 0 }),
  zone("gondi", "Gondi", "lift", 300, { descentM: 0, climbM: 0 }),               // drawn top -> bottom, no elevation: a ride = against the line
  { id: "stop1", name: "A circle stop", layers: [{ kind: "general", radiusM: 30 }, { kind: "target", radiusM: 12 }] }
] };

async function drive(e, pts, speed) {
  const realNow = Date.now; let t = 1760000000000;
  try {
    for (const p of pts) { t += 1000; Date.now = () => t; e.api.questRunSimTick({ lat: p.lat, lon: p.lon, acc: 5, alt: null }, { speed }, t); }
  } finally { Date.now = realNow; }
  await new Promise(r => setTimeout(r, 5));   // let the score request settle
}
const down = (from, to, step, east) => { const out = []; for (let s = from; s <= to; s += step) out.push(at(s, east)); return out; };

test("skiing a chute top to bottom in Test Mode logs it, scores it on the server's formula and saves nothing", async () => {
  const e = editor({ user: JSON.stringify({ name: "Gary Jolivet", email: "g@example.com" }) });
  e.api.questRunSimLoad(bundle, true);
  assert.strictEqual(e.api.sim.corridors.length, 2, "corridor stops only");
  assert.strictEqual(e.el("simRider").textContent, "Gary Jolivet", "the test rider is the admin's login name");
  assert.strictEqual(e.el("simToday").style.display, "", "the Today block is shown");
  await drive(e, down(0, 400, 8), 8);
  const runs = e.api.day.runs();
  assert.strictEqual(runs.length, 1, "one run logged, got " + JSON.stringify(e.log));
  assert.strictEqual(runs[0].activity, "ski"); assert.strictEqual(runs[0].runType, "chute");
  assert.ok(Math.abs(runs[0].verticalM) >= 110 && Math.abs(runs[0].verticalM) <= 120, "the authored descent x coverage, got " + runs[0].verticalM);
  assert.strictEqual(runs[0].points, 492, "points come from the server");
  assert.strictEqual(e.scored.length, 1);
  assert.strictEqual(e.scored[0].url, "/api/quest-score"); assert.strictEqual(e.scored[0].method, "POST");
  assert.deepStrictEqual(Object.keys(e.scored[0].body).sort(), ["activity", "difficulty", "distanceM", "runType", "startedAt", "verticalM"]);
  assert.ok(e.log.some(l => /^RUN logged "Main Dumper" — ski · 1\d\d m · \+492 pts — Chute 1 of 1/.test(l)), "log line: " + e.log.join(" | "));
  assert.ok(e.toasts.some(t => /Chute 1 of 1/.test(t)), "the phone's completion text");
  assert.match(e.el("simTodayNums").textContent, /^Vertical 0 m · Chutes 1\/1 · Runs 0 · Lift rides 0 · Points 492$/);
  assert.ok(e.api.track.length === 1 && e.api.track[0].length > 20, "the day's track is kept for the share image");
});

test("crossing a chute midway, or joining it halfway, logs nothing -- same rule as the phone", async () => {
  let e = editor(); e.api.questRunSimLoad(bundle, true);
  await drive(e, [-40, -30, -20, -10, 0, 10, 20, 30, 40, 200].map(x => at(200, x)), 8);
  assert.strictEqual(e.api.day.runs().length, 0);
  e = editor(); e.api.questRunSimLoad(bundle, true);
  await drive(e, down(200, 400, 8).concat([at(400, 150), at(400, 400)]), 8);
  await drive(e, [at(400, 600)], 8);
  assert.strictEqual(e.api.day.runs().length, 0, "joined halfway: not a run");
});

test("a lift ride counts toward vertical and lift rides; the rider name falls back to email, then 'Test rider'", async () => {
  const e = editor({ user: JSON.stringify({ email: "admin@example.com" }) });
  const b = JSON.parse(JSON.stringify(bundle)); Object.assign(b.zones[1].layers[1].geometry, { descentM: 0, climbM: 300, path: linePath(300).reverse() });   // drawn bottom -> top
  e.api.questRunSimLoad(b, true);
  assert.strictEqual(e.el("simRider").textContent, "admin@example.com");
  const up = down(0, 400, 5, 300).reverse();
  await drive(e, up, 5);
  const runs = e.api.day.runs();
  assert.strictEqual(runs.length, 1); assert.strictEqual(runs[0].activity, "lift");
  assert.match(e.el("simTodayNums").textContent, /^Vertical (2\d\d|300) m · Chutes 0\/1 · Runs 0 · Lift rides 1 · /);   // the lift's climb x coverage
  assert.strictEqual(editor().api.simRiderName(), "Test rider");
  assert.strictEqual(editor({ user: "{not json" }).api.simRiderName(), "Test rider");
});

test("each ▶ Test starts an empty day; Walk stops / Reset keep it; no connection still logs the run", async () => {
  const e = editor({ offline: true }); e.api.questRunSimLoad(bundle, true);
  await drive(e, down(0, 400, 8), 8);
  assert.strictEqual(e.api.day.runs().length, 1);
  assert.ok(e.log.some(l => /points unavailable \(no connection\)/.test(l)));
  const day = e.api.day;
  e.api.questRunSimLoad(bundle, false);
  assert.strictEqual(e.api.day, day, "Walk stops / Reset rebuild the engine, not the day");
  e.api.questRunSimLoad(bundle, true);
  assert.notStrictEqual(e.api.day, day); assert.strictEqual(e.api.day.runs().length, 0);
});

test("a workspace without Ridge Quest gets no simulator", () => {
  const e = editor({ questOff: true }); e.api.questRunSimLoad(bundle, true);
  assert.strictEqual(e.api.sim, null); assert.strictEqual(e.el("simToday").style.display, "none");
});

test("one engine: the phone and Test Mode both mix in QuestCore.runMethods, and the page keeps no copy", () => {
  assert.ok(/<script src="\/quest-core\.js"><\/script>/.test(rq) && /<script src="\/quest-core\.js"><\/script>/.test(fe), "both pages load it");
  assert.ok(rq.indexOf('<script src="/quest-core.js">') < rq.indexOf("const QUEST_TUNING = QuestCore.TUNING;"), "loaded before the page script uses it");
  assert.ok(/const QGeo = QuestCore\.QGeo;/.test(rq) && /const passesOverlap = QuestCore\.passesOverlap;/.test(rq));
  assert.ok(rq.indexOf("Object.assign(Quest, QuestCore.runMethods);") > rq.indexOf("const Quest = {"), "mixed into Quest");
  assert.ok(/this\._record\(corridor, p, selectedActivity, st, halfW, dist\);/.test(extract(rq, "_tick(corridor, p, selectedActivity){")), "Quest._tick hands the recorder its own st / halfW / dist");
  ["_classifyAndLog(corridor, buffer", "_offerPass(corridor, run, trip){", "_settlePasses(force){", "evaluateTraversal(", "MAX_ALONG_SPEED_MPS:"].forEach(t =>
    assert.ok(!rq.includes(t) && !fe.includes(t) && core.includes(t), t + " lives only in quest-core.js"));
  assert.ok(/riderName\(zoneId, official\)\{ return rqName\(zoneId, official\); \}/.test(rq), "the phone still shows the rider's own chute names");
  assert.ok(!/\brqName\(|\bcgLog\(|localStorage|fetch\(|document\./.test(core.replace(/\/\*[\s\S]*?\*\//, "")), "the engine has no page globals, storage, network or DOM");
  assert.deepStrictEqual(Object.keys(QuestCore.runMethods), ["_record", "_classifyAndLog", "_offerPass", "_settlePasses", "_dropPass", "_rivalRecording"]);
  assert.ok(/Object\.assign\(\{[\s\S]{0,700}\}, QuestCore\.runMethods\);/.test(extract(fe, "function questRunSimLoad(bundle, newDay){")), "Test Mode mixes the same methods in");
});

test("Test Mode wiring: fed every simulated fix, buttons present, day cleared on entry and dropped on exit, nothing saved", () => {
  const feed = extract(fe, "function feedSim(lat,lon,acc,t,bleFix){");
  assert.ok(feed.indexOf("questRunSimTick(raw, sm, t)") > feed.indexOf("QuestSim.tick(raw)"), "scored after the voice, on the avatar's exact position");
  assert.ok(/try\{ questRunSimTick\(raw, sm, t\); \}catch/.test(feed), "a scoring error can't break the simulated fix");
  const enter = extract(fe, "function enterTestMode(){");
  assert.ok(/questRunSimLoad\(simBundle, true\)/.test(enter), "an empty day every time Test starts");
  assert.strictEqual((fe.match(/questRunSimLoad\(simBundle, false\)/g) || []).length, 2, "Walk stops and Reset keep the day");
  assert.ok(/QuestRunSim=null; _simDay=null; _simTrack=\[\];/.test(extract(fe, "function exitTestMode(){")), "Exit test drops the day");
  assert.ok(/<button id="simLeaderboard"[^>]*>🏆 Leaderboard<\/button>/.test(fe) && /<button id="simSocial"[^>]*>📸 Social media<\/button>/.test(fe), "the two buttons");
  assert.ok(/getElementById\("simLeaderboard"\)\.onclick = openSimLeaderboard;/.test(fe) && /getElementById\("simSocial"\)\.onclick = openSimSocial;/.test(fe));
  const lb = extract(fe, "function openSimLeaderboard(){");
  assert.ok(/_simDay\.board\(\)/.test(lb) && /not saved, not on the real leaderboard/.test(lb) && !/fetch\(|\/api\/leaderboard/.test(lb), "the leaderboard is the test rider only, nothing fetched");
  const soc = extract(fe, "async function openSimSocial(){");
  assert.ok(/day0\.socialDay\(/.test(soc) && /renderSocialTest\(/.test(soc), "the share images are drawn from the simulated day");
  assert.ok(/const jobs=\[\[day,"story"\],\[day,"wide"\]\];/.test(fe) && !/testSeason\(/.test(fe), "today only: Story + Facebook, no season anywhere");
  assert.ok(/if\(simMode && _simDay && QuestRunSim\)\{ openSimSocial\(\); return; \}/.test(extract(fe, "function openSocialTest(){")), "in Test Mode the toolbar's Social button shows the simulated day too");
  assert.ok(!/\/api\/quest-runs|\/api\/chute-lines|\/api\/quest-day-vertical/.test(fe), "the editor never calls an endpoint that saves a run");
  const sim = fe.slice(fe.indexOf("let QuestRunSim=null"), fe.indexOf("function feedSim(lat,lon,acc,t,bleFix){"));
  assert.ok(!/localStorage\.setItem|sessionStorage\.setItem/.test(sim), "nothing persisted");
  assert.ok(!/km\/h|avgSpeed|maxSpeed/.test(sim), "never shows speed");
});

test("POST /api/quest-score uses the run endpoint's own formula and writes nothing", () => {
  const h = worker.slice(worker.indexOf('if (path === "/api/quest-score" && method === "POST") {'), worker.indexOf('if (path === "/api/quest-runs" && method === "POST") {'));
  assert.ok(h.length > 200, "handler found, before /api/quest-runs");
  assert.ok(/questPoints\(b\.activity, b\.difficulty, b\.runType, verticalM, distanceM, snowBonus\)/.test(h), "same questPoints call");
  assert.ok(/questSnowBonus\(/.test(h) && /questDateBucket\(startedAt\)/.test(h), "same snow bonus for the run's day");
  assert.ok(/\(b\.activity === "ski" \|\| b\.activity === "hike"\) \? snowBonusRaw : 1/.test(h), "snow bonus only for ski / boot pack, as when saving");
  assert.ok(!/INSERT|UPDATE|DELETE|\.batch\(|\.run\(\)/.test(h), "no write");
  assert.ok(!/playerAuth|requireAuth|authed\(/.test(h), "no sign-in needed (the editor has no rider session)");
});

// 2026-10-08, Gary: "i moved up the stairway chair yet no vertical was recorded" -- several outcomes
// were silent by design for the rider (riding a lift line downhill, a pass too small to mention).
// They now leave a line in the host's log (log only: nothing is counted or toasted differently).
test("silent outcomes say why in the Test log: a lift taken down its line, and a small partial pass", async () => {
  let e = editor(); e.api.questRunSimLoad(bundle, true);
  await drive(e, down(0, 400, 5, 300), 5);          // the fixture lift's ride direction is against its line; this goes along it
  assert.strictEqual(e.api.day.runs().length, 0, "not a lift ride");
  assert.ok(e.log.some(l => /^RUN ignored: "Gondi" -- a lift counts only when ridden UP it/.test(l)), "log: " + e.log.join(" | "));
  e = editor(); e.api.questRunSimLoad(bundle, true);
  // a quarter of the chute, then away; the engine judges an unfinished pass REC_GRACE_S (15 s) after the rider left
  await drive(e, down(100, 200, 8).concat([at(200, 200), at(200, 400)], Array.from({ length: 20 }, (_, i) => at(200, 600 + i * 8))), 8);
  assert.strictEqual(e.api.day.runs().length, 0);
  assert.ok(e.log.some(l => /^RUN no pass: "Main Dumper" -- .+\(\d+% covered\)$/.test(l)), "log: " + e.log.join(" | "));
  assert.ok(!e.log.some(l => /^RUN not counted/.test(l)), "below the 40% the rider is told about, so no 'not counted' message");
});
