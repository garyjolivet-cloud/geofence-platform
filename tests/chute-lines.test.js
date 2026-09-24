// Saved chute lines (2026-09-24): a rider's GPS line per verified chute descent, saved only
// while Corridor Guard is on for that chute, browsed as a folder per chute in "Your chutes",
// drawn on "My map" in cycling colours, smoothed so turns read as S-curves, not zig-zags.
//
// Covered here: the pure smoothing/colour helpers (frontend/ridge-visuals.js), the REAL
// Quest._saveChuteLine from ridge-quest.html (the save gate), and the worker's point
// validation + both player-data deletion paths. The newest-3 SQL rule is checked against
// real local D1 by hand (see CLAUDE.md), and the map look on-device is unverified.
//
// Run: `node --test tests/chute-lines.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

require("../frontend/ridge-visuals.js");
const V = globalThis.RidgeVisuals;
const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8").replace(/\r/g, "");
const worker = fs.readFileSync(path.join(__dirname, "../backend/worker.js"), "utf8").replace(/\r/g, "");

function extractFrom(src, startTag) {
  const startIdx = src.indexOf(startTag);
  assert.ok(startIdx >= 0, "found " + startTag);
  let depth = 0, i = src.indexOf("{", startIdx);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(startIdx, i + 1);
}

// ---- synthetic ski line: 1 Hz fixes at 8 m/s down a 12 m-wide S-turn line, plus GPS noise ----
const LAT0 = 51.3, LON0 = -117.05, KY = 111320, KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => [LON0 + x / KX, LAT0 + y / KY];
const toXY = p => ({ x: (p[0] - LON0) * KX, y: (p[1] - LAT0) * KY });
function sLine(noiseM, seed) {
  let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const raw = [], truth = [];
  for (let t = 0; t < 30; t++) {
    const y = -t * 8, x = 6 * Math.sin(2 * Math.PI * (t * 8) / 30);
    truth.push({ x, y });
    raw.push(toLL(x + rnd() * 2 * noiseM, y + rnd() * 2 * noiseM));
  }
  return { raw, truth };
}
function resample(P, step) {
  const out = [P[0]]; let carry = 0;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], L = Math.hypot(b.x - a.x, b.y - a.y); let d = step - carry;
    while (d <= L) { out.push({ x: a.x + (b.x - a.x) * d / L, y: a.y + (b.y - a.y) * d / L }); d += step; }
    carry = L - (d - step);
  }
  return out;
}
// Sharpest heading change between consecutive 1.5 m steps (a "Z" corner is a big number).
function sharpest(lonlats) {
  const R = resample(lonlats.map(toXY), 1.5); let m = 0;
  for (let i = 1; i < R.length - 1; i++) {
    const h1 = Math.atan2(R[i].y - R[i - 1].y, R[i].x - R[i - 1].x), h2 = Math.atan2(R[i + 1].y - R[i].y, R[i + 1].x - R[i].x);
    let d = Math.abs(h2 - h1) * 180 / Math.PI; if (d > 180) d = 360 - d; m = Math.max(m, d);
  }
  return m;
}
function meanDevFromTruth(lonlats, truth) {
  const P = lonlats.map(toXY); let sum = 0;
  P.forEach(p => {
    let best = Infinity;
    for (let i = 0; i < truth.length - 1; i++) {
      const a = truth[i], b = truth[i + 1], dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L));
      best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
    }
    sum += best;
  });
  return sum / P.length;
}

test("smoothLine turns a noisy 1 Hz zig-zag into rounded S-curves", () => {
  for (const noise of [2, 4]) {
    const { raw, truth } = sLine(noise, 7);
    const sm = V.smoothLine(raw);
    assert.ok(sharpest(raw) > 70, "the raw line really is zig-zag (" + sharpest(raw).toFixed(0) + " deg corners)");
    assert.ok(sharpest(sm) < 60, "smoothed corners are rounded at noise " + noise + " m, got " + sharpest(sm).toFixed(0) + " deg");
    assert.ok(meanDevFromTruth(sm, truth) <= meanDevFromTruth(raw, truth) + 0.2,
      "smoothing never drifts further from the true line than the raw fixes were");
  }
});

test("smoothLine keeps most of a real turn's width and the exact endpoints", () => {
  const { raw } = sLine(0, 7);
  const sm = V.smoothLine(raw);
  const xs = sm.map(p => toXY(p).x), width = Math.max(...xs) - Math.min(...xs);
  assert.ok(width >= 9, "a clean 12 m-wide S-turn stays at least 9 m wide, got " + width.toFixed(1));
  assert.deepStrictEqual(sm[0], raw[0], "start point unchanged");
  assert.deepStrictEqual(sm[sm.length - 1], raw[raw.length - 1], "finish point unchanged");
});

test("smoothLine handles degenerate input", () => {
  assert.deepStrictEqual(V.smoothLine([]), []);
  assert.deepStrictEqual(V.smoothLine(null), []);
  assert.deepStrictEqual(V.smoothLine([[1, 2]]), [[1, 2]]);
  assert.deepStrictEqual(V.smoothLine([[1, 2], [1.0001, 2.0001]]), [[1, 2], [1.0001, 2.0001]]);
  const same = V.smoothLine([[1, 2], [1, 2], [1, 2], [1, 2]]);
  assert.ok(same.length <= 2, "repeated identical points collapse instead of producing NaN");
  assert.ok(same.every(p => isFinite(p[0]) && isFinite(p[1])));
});

test("colours cycle newest-first per chute, hidden lines get none", () => {
  const C = V.CHUTE_LINE.COLORS;
  const lines = [
    { id: "a1", zoneId: "A", startedAt: "2026-09-20T10:00:00Z", visible: true },
    { id: "a2", zoneId: "A", startedAt: "2026-09-22T10:00:00Z", visible: true },
    { id: "a3", zoneId: "A", startedAt: "2026-09-21T10:00:00Z", visible: false },
    { id: "b1", zoneId: "B", startedAt: "2026-09-19T10:00:00Z", visible: true }
  ];
  const col = V.chuteLineColors(lines);
  assert.strictEqual(col.a2, C[0], "newest visible line of a chute gets the first colour");
  assert.strictEqual(col.a1, C[1]);
  assert.strictEqual(col.a3, undefined, "a switched-off line has no colour");
  assert.strictEqual(col.b1, C[0], "each chute starts its own cycle");
  const many = Array.from({ length: C.length + 1 }, (_, i) => ({ id: "m" + i, zoneId: "M", startedAt: "2026-09-" + String(10 + i) + "T00:00:00Z", visible: true }));
  const cm = V.chuteLineColors(many);
  assert.strictEqual(cm["m0"], C[0], "the palette wraps round after " + C.length + " lines");
  assert.ok(!C.includes("#ffd23f") && !C.includes("#00e5ff") && !C.includes("#8fe3ff"),
    "palette avoids guard yellow, armed cyan and the day-track aqua");
});

test("feature collection draws only lines with a colour and >= 2 points", () => {
  const fc = V.chuteLinesFeatureCollection(
    [{ id: "x", points: [] }, { id: "y" }, { id: "z" }],
    { x: "#fff", z: "#f00" },
    l => l.id === "x" ? [[0, 0], [1, 1]] : l.id === "z" ? [[0, 0]] : [[0, 0], [2, 2]]);
  assert.deepStrictEqual(fc.features.map(f => f.properties.id), ["x"]);
  assert.strictEqual(fc.features[0].properties.color, "#fff");
  const L = V.chuteLinesLayer("l", "s");
  assert.deepStrictEqual(L.paint["line-color"], ["get", "color"]);
});

// ---- the REAL Quest._saveChuteLine ----
function loadSaveChuteLine(apiStub) {
  const method = extractFrom(html, "_saveChuteLine(corridor, run, fixes){");
  // eslint-disable-next-line no-new-func
  return new Function("api", "return function " + method)(apiStub);
}
function makeHost(opts) {
  const calls = [];
  const api = (p, o) => { calls.push({ p, body: JSON.parse(o.body) }); return opts.fail ? Promise.reject(new Error("offline")) : Promise.resolve({ ok: true }); };
  const fn = loadSaveChuteLine(api);
  const host = { chuteGuardEnabled: opts.enabled !== false, isGuarded: id => (opts.guarded || []).includes(id), onChuteLineSaved: null };
  return { save: (...a) => fn.apply(host, a), calls, host };
}
const chute = { zoneId: "c1", name: "Big Dumper", runType: "chute" };
const skiRun = { activity: "ski", startedAt: "2026-09-24T18:00:00Z", endedAt: "2026-09-24T18:01:00Z" };
const passFixes = [{ lat: 51.31, lon: -117.05, t: 1 }, { lat: 51.309, lon: -117.0501, t: 2 }, { lat: 51.308, lon: -117.05, t: 3 }];

test("a guarded chute descent saves exactly the verified start->finish fixes", () => {
  const h = makeHost({ guarded: ["c1"] });
  const body = h.save(chute, skiRun, passFixes);
  assert.ok(body, "saved");
  assert.strictEqual(h.calls.length, 1);
  assert.strictEqual(h.calls[0].p, "/api/chute-lines");
  assert.deepStrictEqual(h.calls[0].body.points, [[-117.05, 51.31], [-117.0501, 51.309], [-117.05, 51.308]]);
  assert.strictEqual(h.calls[0].body.zoneId, "c1");
  assert.strictEqual(h.calls[0].body.runName, "Big Dumper");
  assert.ok(!("speed" in h.calls[0].body) && !JSON.stringify(h.calls[0].body).includes("speed"), "no speed is sent or stored");
});

test("nothing is saved unless it is a guarded chute descent", () => {
  const cases = [
    ["muted / not armed chute", { guarded: [] }, chute, skiRun],
    ["workspace without Corridor Guard", { guarded: ["c1"], enabled: false }, chute, skiRun],
    ["chute climbed (hike)", { guarded: ["c1"] }, chute, Object.assign({}, skiRun, { activity: "hike" })],
    ["ordinary run", { guarded: ["c1"] }, Object.assign({}, chute, { runType: "run" }), skiRun],
    ["lift", { guarded: ["c1"] }, Object.assign({}, chute, { runType: "lift" }), Object.assign({}, skiRun, { activity: "lift" })]
  ];
  for (const [why, opts, cor, run] of cases) {
    const h = makeHost(opts);
    assert.strictEqual(h.save(cor, run, passFixes), null, why + ": not saved");
    assert.strictEqual(h.calls.length, 0, why + ": no request");
  }
  const h = makeHost({ guarded: ["c1"] });
  assert.strictEqual(h.save(chute, skiRun, [passFixes[0]]), null, "a single fix is not a line");
});

test("a failed save is swallowed and never throws into run logging", async () => {
  const h = makeHost({ guarded: ["c1"], fail: true });
  assert.doesNotThrow(() => h.save(chute, skiRun, passFixes));
  await new Promise(r => setTimeout(r, 10));   // the rejection must be handled (no unhandledRejection)
  const bad = makeHost({ guarded: ["c1"] });
  bad.host.isGuarded = () => { throw new Error("boom"); };
  assert.strictEqual(bad.save(chute, skiRun, passFixes), null, "an exception inside the gate returns null");
});

test("_classifyAndLog saves the line only after the run itself is logged", () => {
  const src = extractFrom(html, "_classifyAndLog(corridor, buffer, selectedActivity, isFinal){");
  assert.match(src, /api\("\/api\/quest-runs"[\s\S]*?\.then\(\(\)=>\{[^}]*this\._saveChuteLine\(corridor, run, trip\.fixes\)/,
    "the save is chained after the quest-runs POST succeeds, using the verified pass's own fixes");
});

// ---- worker: validation + deletion paths ----
test("worker validates and rounds points", () => {
  const consts = worker.match(/const CHUTE_LINE_MAX_POINTS = \d+;/)[0];
  const fn = extractFrom(worker, "function cleanChuteLinePoints(points) {");
  // eslint-disable-next-line no-new-func
  const clean = new Function(consts + "\n" + fn + "\nreturn cleanChuteLinePoints;")();
  assert.deepStrictEqual(clean([[-117.123456789, 51.987654321], [-117.1, 51.9]]), [[-117.123457, 51.987654], [-117.1, 51.9]]);
  assert.strictEqual(clean([[1, 2]]), null, "one point is not a line");
  assert.strictEqual(clean("x"), null);
  assert.strictEqual(clean([[1, 2], [200, 2]]), null, "out-of-range longitude rejected");
  assert.strictEqual(clean([[1, 2], ["a", 2]]), null, "non-numeric rejected");
  assert.strictEqual(clean(Array.from({ length: 2001 }, () => [1, 2])), null, "over the point cap rejected");
});

test("worker keeps the newest 3 switched on, same number as the client", () => {
  assert.match(worker, /const CHUTE_LINE_DEFAULT_VISIBLE = 3;/);
  assert.strictEqual(V.CHUTE_LINE.DEFAULT_VISIBLE, 3);
  assert.match(worker, /UPDATE chute_line SET visible=0 WHERE player_id=\? AND zone_id=\? AND visible=1 AND id NOT IN/);
});

test("chute_line is removed by 'forget my data' and by workspace delete (player_id FK)", () => {
  const forget = worker.indexOf('env.DB.prepare("DELETE FROM chute_line WHERE player_id=?")');
  const acct = worker.indexOf('env.DB.prepare("DELETE FROM player_account WHERE id=?").bind(P.playerId)');
  assert.ok(forget > 0 && acct > forget, "forget-my-data deletes chute_line before player_account");
  assert.match(worker, /for \(const t of \[[^\]]*"chute_line"[^\]]*\]\)/, "workspace delete includes chute_line");
});
