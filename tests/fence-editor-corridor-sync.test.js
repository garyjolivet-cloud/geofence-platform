// Fence Editor <- corridor library sync (2026-09-24). Field report: "in gpx editor i changed
// name of pioneer chute to porcupine. on edit it still shows as pioneer chute". Two gaps:
//   1. the one-way library pull (reconcileLinkedCorridors, the per-stop refresh) copied shape,
//      width, difficulty, run type, activity and descent -- but never the NAME;
//   2. adding a library corridor already in the project made a SECOND stop linked to it (the
//      live RidgeQuest tour ended up with both "Pioneer" and "Porcupine" on one corridor, which
//      would log every pass twice in Ridge Quest).
// The REAL functions are extracted from fence-editor.html and run against fakes.
//
// Run: `node --test tests/fence-editor-corridor-sync.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const html = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8").replace(/\r/g, "");
function extract(startTag) {
  const s = html.indexOf(startTag);
  assert.ok(s >= 0, "found " + startTag);
  let depth = 0, i = html.indexOf("{", s);
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(s, i + 1);
}
const SRC = "const _corrAddsInFlight=new Set();\n" + [
  "function thisIsLine(z){",
  "function setStopName(z, name){",
  "function bearingTo(a,b){",
  "function chuteBearingFromLine(z){",
  "function duplicateCorridorStops(){",
  "async function importCorridorFromLibrary(corridorId){",
  "function _matchCorridorRow(rows, z){",
  "async function reconcileLinkedCorridors(){",
  "async function refreshCorridorShapeFromLibrary(z){"
].map(extract).join("\n");

const PTS = [[-117.05, 51.31, 2000], [-117.051, 51.309, 1990], [-117.052, 51.308, 1980]];
const row = (id, name, extra = {}) => Object.assign({ id, name, points: PTS, widthM: 30, difficulty: "black", runType: "chute", activityType: "ski_chute", elevLossM: 20, updatedAt: "2026-09-25T01:24:36Z" }, extra);
// The PTS line's start -> finish bearing, so a stop that is otherwise in sync needs no redraw.
// eslint-disable-next-line no-new-func
const PTS_BEARING = Math.round(new Function(extract("function bearingTo(a,b){") + "\nreturn bearingTo;")()(PTS[0], PTS[PTS.length - 1])) % 360;
const corrZone = (id, name, corridorId) => ({ id, name, corridorId, shape: { type: "corridor", coords: PTS.map(p => [p[0], p[1]]), widthM: 30 }, difficulty: "black", runType: "chute", activityType: "ski_chute", descentM: 20, bearingDeg: PTS_BEARING });

function harness(zonesIn, rows) {
  const toasts = [], renders = [];
  const env = {
    zones: zonesIn, rows,
    afAppId: () => "kh",
    getToken: () => "t",
    _appCorridorRows: async () => rows,
    _c6: c => c.map(p => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]),
    _strideCorridor: p => p.map(q => [q[0], q[1]]),
    _corrCenterCache: new Map(),
    gpxDistanceM: () => 0,
    render: () => renders.push("render"),
    refreshProps: () => {},
    toast: (m, k) => toasts.push({ m, k }),
    alert: m => { throw new Error("alert: " + m); },
    makeZone: (name, shape) => ({ id: name.toLowerCase(), name, shape }),
    focusedStopFolderId: null,
    fetch: async url => {
      const id = decodeURIComponent(url.split("/").pop());
      const r = rows.find(x => x.id === id);
      return r ? { ok: true, status: 200, json: async () => r } : { ok: false, status: 404, json: async () => ({ error: "not found" }), statusText: "nf" };
    }
  };
  // zones/sel/_corrReconcileBusy are module-level `let`s in the page; mirror that here.
  // eslint-disable-next-line no-new-func
  const api = new Function(...Object.keys(env).filter(k => k !== "zones" && k !== "rows"),
    "let zones = arguments[arguments.length-1].zones; let sel = -1; let _corrReconcileBusy = false;\n" + SRC +
    "\nreturn { importCorridorFromLibrary, reconcileLinkedCorridors, refreshCorridorShapeFromLibrary, duplicateCorridorStops, get sel(){ return sel; }, get zones(){ return zones; } };")
    (...Object.keys(env).filter(k => k !== "zones" && k !== "rows").map(k => env[k]), env);
  return { api, toasts, renders };
}

test("a rename in the GPX Editor reaches the linked stop on load; its id is kept", async () => {
  const z = corrZone("pioneer", "Pioneer", "ec5b");
  const h = harness([z], [row("ec5b", "Porcupine")]);
  await h.api.reconcileLinkedCorridors();
  assert.strictEqual(z.name, "Porcupine");
  assert.strictEqual(z.id, "pioneer", "the stop id (what rider history is keyed on) never changes");
  assert.ok(h.renders.length >= 1, "the editor redraws with the new name");
});

test("a library rename carries the automatic spoken line; an authored line is kept (2026-10-07)", async () => {
  const z = Object.assign(corrZone("crystal", "Right Crysal Right", "d59b"), { say: "This is Right Crysal Right" });
  const own = Object.assign(corrZone("pw", "PW", "pw01"), { say: "This is Peee Double U" });
  const h = harness([z, own], [row("d59b", "Crystal Bowl right"), row("pw01", "P W")]);
  await h.api.reconcileLinkedCorridors();
  assert.strictEqual(z.say, "This is Crystal Bowl right");
  assert.strictEqual(own.name, "P W");
  assert.strictEqual(own.say, "This is Peee Double U");
});

test("the per-stop refresh button also pulls the new name", async () => {
  const z = corrZone("pioneer", "Pioneer", "ec5b");
  const h = harness([z], [row("ec5b", "Porcupine")]);
  await h.api.refreshCorridorShapeFromLibrary(z);
  assert.strictEqual(z.name, "Porcupine");
  assert.strictEqual(z.id, "pioneer");
});

test("an unchanged name does not trigger a redraw", async () => {
  const z = corrZone("porcupine", "Porcupine", "ec5b");
  const h = harness([z], [row("ec5b", "Porcupine")]);
  await h.api.reconcileLinkedCorridors();
  assert.strictEqual(h.renders.length, 0);
});

test("adding a corridor that is already in the project selects it instead of duplicating", async () => {
  const zs = [corrZone("a", "Alley 17", "alley"), corrZone("porcupine", "Porcupine", "ec5b")];
  const h = harness(zs, [row("ec5b", "Porcupine"), row("new1", "Big Dumper")]);
  await h.api.importCorridorFromLibrary("ec5b");
  assert.strictEqual(h.api.zones.length, 2, "no second stop");
  assert.strictEqual(h.api.sel, 1, "the existing stop is selected");
  assert.match(h.toasts[0].m, /already in this project/);
  await h.api.importCorridorFromLibrary("new1");
  assert.strictEqual(h.api.zones.length, 3, "a corridor not yet in the project is still added");
  assert.strictEqual(h.api.zones[2].corridorId, "new1");
});

test("on load, two stops already sharing one corridor are flagged by name", async () => {
  const zs = [corrZone("pioneer", "Pioneer", "ec5b"), corrZone("porcupine", "Porcupine", "ec5b"), corrZone("a", "Alley 17", "alley")];
  const h = harness(zs, [row("ec5b", "Porcupine"), row("alley", "Alley 17")]);
  await h.api.reconcileLinkedCorridors();
  const warn = h.toasts.find(t => /more than once/.test(t.m));
  assert.ok(warn, "warned");
  assert.match(warn.m, /Porcupine \(id pioneer\) \+ Porcupine \(id porcupine\)/, "both now carry the library name, so the ids tell them apart");
  assert.ok(!/Alley 17/.test(warn.m), "a corridor used once is not flagged");
});

// 2026-09-30: Hot Milty, Pine Tree and Booter (x3) were each in RidgeQuest more than once -- a
// second click landed while the first add was still fetching, before its stop existed.
test("a double click (second add while the first is still fetching) adds the corridor once", async () => {
  const h = harness([], [row("hm", "Hot Milty")]);
  await Promise.all([h.api.importCorridorFromLibrary("hm"), h.api.importCorridorFromLibrary("hm"), h.api.importCorridorFromLibrary("hm")]);
  assert.strictEqual(h.api.zones.length, 1, "one stop, not three");
  await h.api.importCorridorFromLibrary("hm");
  assert.strictEqual(h.api.zones.length, 1, "a later add still selects the existing stop");
});

test("a failed add can be retried", async () => {
  const rows = [];
  const h = harness([], rows);
  await assert.rejects(h.api.importCorridorFromLibrary("late"), /alert: Add corridor failed/);
  rows.push(row("late", "Late"));
  await h.api.importCorridorFromLibrary("late");
  assert.strictEqual(h.api.zones.length, 1, "the in-flight mark was cleared after the failure");
});

test("Copy refuses a library-linked corridor; Publish asks before publishing duplicates", () => {
  const copy = extract("function copyZone(zoneId){");
  assert.ok(copy.indexOf("if(zones[idx].corridorId)") > -1 && copy.indexOf("if(zones[idx].corridorId)") < copy.indexOf("JSON.parse(JSON.stringify("), "Copy stops before cloning a linked corridor");
  const pub = extract("async function publishToPlatform(){");
  assert.ok(/const dupStops=duplicateCorridorStops\(\);/.test(pub) && /confirm\(/.test(pub) && pub.indexOf("duplicateCorridorStops()") < pub.indexOf("fetch("),
    "Publish checks for duplicate corridors and asks before sending");
});
