// Ridge Quest visuals (2026-09-24): today's ski track, "skied today" stripe, completion toast,
// sun-angle light. Rules from the rider: NO speed anywhere, NO turn counting, no day card;
// track and stripe must be switchable and must not put load on pan/zoom.
//
// The pure module (frontend/ridge-visuals.js) is tested directly; the wiring in ridge-quest.html
// is tested by running its REAL functions against fake maps.
//
// Run: `node --test tests/ridge-visuals.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const modSrc = fs.readFileSync(path.join(__dirname, "../frontend/ridge-visuals.js"), "utf8");
require("../frontend/ridge-visuals.js");
const V = globalThis.RidgeVisuals;
const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8").replace(/\r/g, "");

function extract(startTag) {
  const startIdx = html.indexOf(startTag);
  assert.ok(startIdx >= 0, "found " + startTag);
  let depth = 0, i = html.indexOf("{", startIdx);
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(startIdx, i + 1);
}

/* ---------- track ---------- */
function mkStore() { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, m }; }
// ~1.1 m per 0.00001 deg lat; 0.0001 deg ~ 11 m
const P = (i, dLat = 0.0001) => ({ lat: 51.3 + i * dLat, lon: -117.15, acc: 5, t: 1000 + i * 1000 });

test("track keeps points at least MIN_STEP_M apart and ignores poor GPS", () => {
  const tr = V.createTrack(mkStore(), () => "2026-09-24");
  assert.ok(tr.add(P(0)));
  assert.ok(!tr.add({ ...P(1, 0.00001) }), "1 m step is dropped");
  assert.ok(tr.add(P(2)), "11 m step is kept");
  assert.ok(!tr.add({ ...P(3), acc: 80 }), "acc 80 m is dropped");
  assert.strictEqual(tr.segments().length, 1);
  assert.strictEqual(tr.segments()[0].length, 2);
});

test("lift rides and long gaps start a new segment; lift fixes are never drawn", () => {
  const tr = V.createTrack(mkStore(), () => "2026-09-24");
  tr.add(P(0)); tr.add(P(1)); tr.add(P(2));
  assert.ok(!tr.add(P(3), true), "on a lift: not recorded");
  tr.add(P(4)); tr.add(P(5));
  assert.strictEqual(tr.segments().length, 2, "lift split the line in two");
  const late = { ...P(6), t: P(5).t + V.TRACK.GAP_MS + 1 };
  tr.add(late);
  assert.strictEqual(tr.segments().length, 3, "a 90 s+ gap splits too");
});

test("track persists per ski day and resets on a new day", () => {
  const store = mkStore();
  let day = "2026-09-24";
  const a = V.createTrack(store, () => day);
  a.add(P(0)); a.add(P(1)); a.save(true);
  const b = V.createTrack(store, () => day); b.load();
  assert.strictEqual(b.segments()[0].length, 2, "reloaded the same day");
  day = "2026-09-25";
  const c = V.createTrack(store, () => day); c.load();
  assert.strictEqual(c.segments().length, 0, "next day starts empty");
});

test("track is capped (thinned) and survives a throwing storage", () => {
  const tr = V.createTrack({ getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); } }, () => "d");
  tr.load();
  for (let i = 0; i < V.TRACK.MAX_POINTS + 500; i++) tr.add({ lat: 51 + i * 0.0001, lon: -117, acc: 5, t: i * 1000 });
  const n = tr.segments().reduce((a, s) => a + s.length, 0);
  assert.ok(n <= V.TRACK.MAX_POINTS + 1, "capped, got " + n);
});

test("trackFeatureCollection draws only segments with 2+ points, as one feature", () => {
  assert.strictEqual(V.trackFeatureCollection([[[0, 0]]]).features.length, 0);
  const fc = V.trackFeatureCollection([[[0, 0], [1, 1]], [[2, 2]], [[3, 3], [4, 4]]]);
  assert.strictEqual(fc.features.length, 1);
  assert.strictEqual(fc.features[0].geometry.coordinates.length, 2);
});

/* ---------- completion toast ---------- */
const corridors = [
  { zoneId: "a", runType: "chute" }, { zoneId: "b", runType: "chute" }, { zoneId: "c", runType: "chute" },
  { zoneId: "r1", runType: "run" }, { zoneId: "l1", runType: "lift" },
];
test("completion says 'Chute N of M' for a new chute and 'again' for a repeat", () => {
  const skied = new Set(["a"]);
  const c1 = V.completion({ runType: "chute", zoneId: "b", runName: "Big Dumper" }, skied, corridors);
  assert.strictEqual(c1.text, "Chute 2 of 3"); assert.strictEqual(c1.sub, "Big Dumper"); assert.ok(c1.isNew);
  const c2 = V.completion({ runType: "chute", zoneId: "a", runName: "X" }, skied, corridors);
  assert.strictEqual(c2.text, "Chute again"); assert.ok(!c2.isNew); assert.strictEqual(c2.n, 1);
  assert.strictEqual(V.completion({ runType: "lift", zoneId: "l1" }, skied, corridors), null);
  assert.strictEqual(V.completion({ runType: "chute", activity: "lift", zoneId: "a" }, skied, corridors), null);
  assert.strictEqual(V.completion({ runType: "run", zoneId: "r1", runName: "Easy" }, skied, corridors).text, "Run complete");
});

test("nothing in the visuals module measures or shows speed or turns", () => {
  const code = modSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/speed|mps|kmh|\bturn/i.test(code), "found a speed/turn reference in code");
  const c = V.completion({ runType: "chute", zoneId: "a", runName: "X", maxSpeedMps: 30, avgSpeedMps: 20 }, new Set(), corridors);
  assert.ok(!/speed|km|mph/i.test(JSON.stringify(c)));
});

/* ---------- sun light ---------- */
test("sun position and hillshade light follow the day (Kicking Horse, January)", () => {
  const noon = V.sunPosition(new Date("2026-01-15T19:39:00Z"), 51.3, -117.15);
  assert.ok(Math.abs(noon.azimuth - 180) < 8 && noon.altitude > 15 && noon.altitude < 21, JSON.stringify(noon));
  const morning = V.sunPosition(new Date("2026-01-15T16:30:00Z"), 51.3, -117.15);
  assert.ok(morning.azimuth < 150 && morning.altitude > 0, "morning sun is in the east: " + JSON.stringify(morning));
  const afternoon = V.hillshadeLight(new Date("2026-01-15T22:30:00Z"), 51.3, -117.15);
  assert.ok(afternoon.direction > 200 && afternoon.direction < 260);
  const night = V.hillshadeLight(new Date("2026-01-16T06:00:00Z"), 51.3, -117.15);
  assert.deepStrictEqual([night.direction, night.exaggeration], [335, 0.45]);
  const summer = V.hillshadeLight(new Date("2026-06-21T19:30:00Z"), 51.3, -117.15);
  assert.ok(summer.exaggeration < afternoon.exaggeration, "high sun = flatter shading");
});

/* ---------- layer shapes ---------- */
function zoomCurves(expr) {
  let n = 0;
  (function walk(e) { if (!Array.isArray(e)) return; if (e[0] === "interpolate" || e[0] === "step") { if (JSON.stringify(e[2]) === '["zoom"]') n++; } e.forEach(walk); })(expr);
  return n;
}
test("layers use one zoom curve each (MapLibre swallows more) and feature-state, not properties", () => {
  const sk = V.skiedLayer("s", "runLines");
  assert.strictEqual(zoomCurves(sk.paint["line-width"]), 1);
  assert.ok(JSON.stringify(sk.paint).includes('"feature-state","skied"') && JSON.stringify(sk.paint).includes('"feature-state","flash"'));
  assert.strictEqual(zoomCurves(V.trackLayer("t", "myTrack").paint["line-width"]), 1);
});

/* ---------- wiring in ridge-quest.html ---------- */
function makeMap() {
  const layers = [], sources = {}, states = {}, calls = { setData: 0, vis: {} };
  const map = {
    addSource: (id, def) => { sources[id] = def; },
    getSource: id => sources[id] && { setData: () => { calls.setData++; } },
    addLayer: (def, before) => { layers.push({ def, before }); },
    getLayer: id => (["runLines-width", "runLines-halo", "runLines-casing"].includes(id) || layers.some(l => l.def.id === id)) ? {} : undefined,
    moveLayer: () => {},
    setLayoutProperty: (id, k, v) => { calls.vis[id] = v; },
    setFeatureState: (t, s) => { states[t.id] = { ...(states[t.id] || {}), ...s }; },
    getCanvasContainer: () => ({ addEventListener() {} }),
    getContainer: () => ({ isConnected: true, parentNode: host }),
    isMoving: () => false,
  };
  const host = { kids: [], appendChild(b) { this.kids.push(b); } };
  return { map, layers, sources, states, calls, host };
}
function runSetup(overrides = {}) {
  const { map, layers, sources, states, calls, host } = makeMap();
  const store = mkStore();
  const timers = [];
  const scope = {
    RidgeVisuals: V, RQTrack: V.createTrack(store, () => "d"),
    Quest: { skiedToday: new Set(["c1"]), onSkiedChanged: null },
    localStorage: overrides.localStorage || store,
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    setInterval: () => 1, clearInterval() {},
    document: { createElement: () => ({ style: {}, setAttribute() {}, set onclick(f) { this._c = f; }, get onclick() { return this._c; } }) },
    console,
  };
  const src = ["function getRideToggle(", "function setRideToggle(", "function orderRideLayers(", "function setupRideVisuals("].map(extract).join("\n");
  const fn = new Function(...Object.keys(scope), src + "; return { setupRideVisuals };");
  const api = fn(...Object.values(scope));
  const cors = [{ zoneId: "c1", runType: "chute" }, { zoneId: "c2", runType: "chute" }, { zoneId: "r1", runType: "run" }, { zoneId: "l1", runType: "lift" }];
  api.setupRideVisuals(map, cors);
  return { scope, layers, sources, states, calls, host, timers, cors };
}

test("setupRideVisuals adds the track under the runs, the stripe on the runLines source, and two toggles", () => {
  const r = runSetup();
  const ids = r.layers.map(l => l.def.id);
  assert.deepStrictEqual(ids, ["myTrack-line", "runLines-skied"]);
  assert.strictEqual(r.layers[0].before, "runLines-width", "track goes beneath the run lines");
  assert.strictEqual(r.layers[1].def.source, "runLines");
  assert.deepStrictEqual(r.host.kids.map(b => b.id), ["fogTrackBtn", "fogSkiedBtn"]);
  assert.ok(r.host.kids.every(b => b.textContent.endsWith(" on")), "both default ON");
});

test("skied state is set only on chutes, via feature-state, with no source reload", () => {
  const r = runSetup();
  assert.deepStrictEqual(r.states, { c1: { skied: true }, c2: { skied: false } });
  assert.strictEqual(r.calls.setData, 0);
});

test("finishing a chute flashes its stripe for ~2 s then clears it; repeats and lifts do not mark anything new", () => {
  const r = runSetup();
  r.scope.Quest.skiedToday.add("c2");
  r.scope.Quest.onSkiedChanged("c2", true);
  assert.deepStrictEqual(r.states.c2, { skied: true, flash: true });
  const t = r.timers.find(x => x.ms === 2000);
  assert.ok(t, "a 2 s timer clears the flash");
  t.f();
  assert.strictEqual(r.states.c2.flash, false);
  assert.strictEqual(r.states.c2.skied, true, "the stripe stays");
  assert.ok(!("r1" in r.states) && !("l1" in r.states));
});

test("toggle buttons hide/show their layer and remember the choice", () => {
  const r = runSetup();
  r.host.kids[0].onclick();   // Track
  assert.strictEqual(r.calls.vis["myTrack-line"], "none");
  assert.strictEqual(r.scope.localStorage.m["rq.showTrack"], "0");
  assert.ok(r.host.kids[0].textContent.endsWith(" off"));
  r.host.kids[1].onclick();   // Skied
  assert.strictEqual(r.calls.vis["runLines-skied"], "none");
  r.host.kids[1].onclick();
  assert.strictEqual(r.calls.vis["runLines-skied"], "visible");
});

test("a remembered 'off' is honoured on the next open", () => {
  const store = mkStore(); store.setItem("rq.showTrack", "0");
  const r = runSetup({ localStorage: store });
  assert.strictEqual(r.calls.vis["myTrack-line"], "none");
  assert.strictEqual(r.calls.vis["runLines-skied"], "visible");
});

test("Quest._celebrate marks a chute skied, shows the toast and never throws", () => {
  const body = extract("_celebrate(run){").replace(/^_celebrate\(run\)/, "function _celebrate(run)");
  const shown = []; let vib = 0, changed = null;
  const self = { skiedToday: new Set(["a"]), corridors, onSkiedChanged: (id, j) => { changed = [id, j]; } };
  const scope = { RidgeVisuals: { ...V, celebrate: (d, c) => shown.push(c.text) }, document: {}, navigator: { vibrate: () => { vib++; } }, console };
  const f = new Function(...Object.keys(scope), body + "; return _celebrate;")(...Object.values(scope));
  f.call(self, { runType: "chute", zoneId: "b", runName: "X", activity: "ski_chute" });
  assert.deepStrictEqual(shown, ["Chute 2 of 3"]);
  assert.ok(self.skiedToday.has("b")); assert.strictEqual(vib, 1); assert.deepStrictEqual(changed, ["b", true]);
  const bad = { skiedToday: null, corridors };
  assert.doesNotThrow(() => f.call(bad, { runType: "chute", zoneId: "z" }));
  f.call(self, { runType: "lift", zoneId: "l1" });
  assert.strictEqual(shown.length, 1, "lift rides get no toast");
});

test("source wiring: track feed is isolated in try/catch, back-out clears the hook, script is loaded", () => {
  assert.ok(/try\{ if\(RQTrack\) RQTrack\.add\(\{ lat:fix\.lat, lon:fix\.lon, acc:fix\.acc, t:fix\.t \}, onLift \|\| this\.liftModeActive\); \}catch\(e\)\{\}/.test(html));
  assert.ok(html.includes("Quest.onSkiedChanged=null;"));
  assert.ok(html.includes('<script src="/ridge-visuals.js"></script>'));
  assert.ok(html.includes("this._celebrate(run); if(this.onRunLogged) this.onRunLogged(run);"));
  const applySkiedBody = extract("function setupRideVisuals(");
  assert.ok(!/setData\(RidgeVisuals\.trackFeatureCollection[\s\S]*skied/.test(applySkiedBody.split("function applySkied")[1].split("Quest.onSkiedChanged")[0]), "skied state never reloads a source");
});

test("Track/Skied buttons sit in the right column, clear of Recenter (left column)", () => {
  const rule = html.replace(/\/\*[\s\S]*?\*\//g, "").match(/button\.fogMapLayer\{[^}]*\}/)[0];
  assert.ok(/right:14px/.test(rule) && !/left:14px/.test(rule), rule);
  const tops = [...html.matchAll(/mkBtn\("fog\w+Btn", (\d+),/g)].map(m => +m[1]);
  assert.deepStrictEqual(tops, [102, 146]);
  // right column already holds Battery (top 14) and Guard (top 58); mine start below it
  assert.ok(/\.fogMapGuard\{position:absolute;top:58px;right:14px/.test(html));
});
