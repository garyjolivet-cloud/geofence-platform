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
const SRC = [
  "async function importCorridorFromLibrary(corridorId){",
  "function _matchCorridorRow(rows, z){",
  "async function reconcileLinkedCorridors(){",
  "async function refreshCorridorShapeFromLibrary(z){"
].map(extract).join("\n");

const PTS = [[-117.05, 51.31, 2000], [-117.051, 51.309, 1990], [-117.052, 51.308, 1980]];
const row = (id, name, extra = {}) => Object.assign({ id, name, points: PTS, widthM: 30, difficulty: "black", runType: "chute", activityType: "ski_chute", elevLossM: 20, updatedAt: "2026-09-25T01:24:36Z" }, extra);
const corrZone = (id, name, corridorId) => ({ id, name, corridorId, shape: { type: "corridor", coords: PTS.map(p => [p[0], p[1]]), widthM: 30 }, difficulty: "black", runType: "chute", activityType: "ski_chute", descentM: 20 });

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
    "\nreturn { importCorridorFromLibrary, reconcileLinkedCorridors, refreshCorridorShapeFromLibrary, get sel(){ return sel; }, get zones(){ return zones; } };")
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
