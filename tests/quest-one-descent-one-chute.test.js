// One descent, one chute (ridge-quest.html, 2026-10-03). Kicking Horse chutes are drawn
// 50-100 m wide and overlap, so one descent could verify two of them (12 pairs on the live map).
// The REAL Quest._offerPass / _settlePasses / _dropPass / _rivalRecording and passesOverlap() /
// QGeo.meanOffsetM are extracted and run against a fake Quest.
//
// Run: `node --test tests/quest-one-descent-one-chute.test.js` (or the full suite).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8").replace(/\r/g, "");
function extractFrom(src, tag) {
  const s = src.indexOf(tag);
  assert.ok(s >= 0, "found " + tag);
  let d = 0, i = src.indexOf("{", s);
  for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}") { d--; if (d === 0) break; } }
  return src.slice(s, i + 1);
}
const passesOverlap = new Function(extractFrom(html, "function passesOverlap(a, b){") + "\nreturn passesOverlap;")();
const qgeoM = html.match(/const QGeo = \{[\s\S]*?\n\};/);
const QGeoReal = eval("(" + qgeoM[0].replace(/^const QGeo = /, "").replace(/;$/, "") + ")");
const methods = ["_offerPass(corridor, run, trip){", "_settlePasses(force){", "_dropPass(c, winner){", "_rivalRecording(zoneId){"]
  .map(t => extractFrom(html, t)).join(",\n");

let clock = 1e12;
function makeQuest(opts) {
  const posted = [], said = [];
  const QGeo = { meanOffsetM: (c, fixes) => fixes.fit };   // each test pass carries its own fit
  const QUEST_TUNING = { PASS_SETTLE_MS: 15000 };
  const Date = { now: () => clock };
  const setTimeout = () => {};
  // eslint-disable-next-line no-new-func
  const Q = new Function("QGeo", "QUEST_TUNING", "passesOverlap", "Date", "setTimeout", "cgLog",
    "return {" + methods + "};")(QGeo, QUEST_TUNING, passesOverlap, Date, setTimeout, () => {});
  Object.assign(Q, {
    _passes: [], states: {}, corridors: opts.corridors || [],
    onCoverage: (name, cov, ok, why) => said.push({ name, ok, why }),
    _postRun: (c, run) => posted.push(c.name),
  });
  return { Q, posted, said };
}
const C = (zoneId, name, runType) => ({ zoneId, name: name || zoneId, runType: runType || "chute" });
const trip = (t0, t1, fit) => { const fixes = [{}]; fixes.fit = fit; return { tStart: t0, tEnd: t1, coverage: 0.95, fixes }; };
const run = (activity) => ({ activity: activity || "ski" });

test("alone: a pass with no rival recording is logged at once", () => {
  const { Q, posted } = makeQuest({ corridors: [C("a", "Legs Right")] });
  assert.strictEqual(Q._offerPass(C("a", "Legs Right"), run(), trip(0, 60000, 5)), true);
  assert.deepStrictEqual(posted, ["Legs Right"]);
});

test("two overlapping passes: the better fit is logged, the other 'not counted, you were on ...'", () => {
  const a = C("a", "Legs Right"), b = C("b", "Legs Left");
  const { Q, posted, said } = makeQuest({ corridors: [a, b] });
  Q.states.b = { rec: { sawTop: true } };                 // Legs Left still mid-pass
  Q._offerPass(a, run(), trip(0, 60000, 6));
  assert.deepStrictEqual(posted, [], "Legs Right waits for its rival");
  Q.states.b = { rec: null };
  Q._offerPass(b, run(), trip(2000, 61000, 14));           // worse fit
  assert.deepStrictEqual(posted, ["Legs Right"]);
  assert.ok(said.some(s => s.name === "Legs Left" && !s.ok && s.why === "not counted, you were on Legs Right"));
});

test("a better rival arriving second wins and the first is dropped", () => {
  const a = C("a", "Darwin 2"), b = C("b", "Darwin 3");
  const { Q, posted, said } = makeQuest({ corridors: [a, b] });
  Q.states.b = { rec: { sawTop: true } };
  Q._offerPass(a, run(), trip(0, 60000, 20));
  Q.states.b = { rec: null };
  Q._offerPass(b, run(), trip(1000, 59000, 4));
  assert.deepStrictEqual(posted, ["Darwin 3"]);
  assert.ok(said.some(s => s.name === "Darwin 2" && s.why === "not counted, you were on Darwin 3"));
});

test("a pass overlapping one already logged is never logged too", () => {
  const a = C("a", "140"), b = C("b", "141");
  const { Q, posted } = makeQuest({ corridors: [a, b] });
  Q._offerPass(a, run(), trip(0, 60000, 9));                // logged at once (no rival recording)
  clock += 30000;
  assert.strictEqual(Q._offerPass(b, run(), trip(5000, 62000, 2)), "rejected");
  assert.deepStrictEqual(posted, ["140"]);
});

test("different descents (no time overlap) both count", () => {
  const a = C("a", "Legs Right"), b = C("b", "Legs Left");
  const { Q, posted } = makeQuest({ corridors: [a, b] });
  Q._offerPass(a, run(), trip(0, 60000, 9));
  Q._offerPass(b, run(), trip(600000, 660000, 9));
  assert.deepStrictEqual(posted, ["Legs Right", "Legs Left"]);
});

test("a rival that never finishes only delays the pass by PASS_SETTLE_MS", () => {
  const a = C("a", "Ozone"), b = C("b", "Darwin 1");
  const { Q, posted } = makeQuest({ corridors: [a, b] });
  Q.states.b = { rec: { sawTop: true } };
  Q._offerPass(a, run(), trip(0, 60000, 9));
  Q._settlePasses(false);
  assert.deepStrictEqual(posted, []);
  clock += 15001;
  Q._settlePasses(false);
  assert.deepStrictEqual(posted, ["Ozone"]);
});

test("stopping tracking logs what was waiting", () => {
  const a = C("a", "Ozone"), b = C("b", "Darwin 1");
  const { Q, posted } = makeQuest({ corridors: [a, b] });
  Q.states.b = { rec: { sawTop: true } };
  Q._offerPass(a, run(), trip(0, 60000, 9));
  Q._settlePasses(true);
  assert.deepStrictEqual(posted, ["Ozone"]);
  assert.ok(/stop\(\)\{[\s\S]*?this\._settlePasses\(true\)/.test(html), "Quest.stop() flushes");
});

test("passesOverlap: same descent = different non-lift corridors overlapping >= half the shorter", () => {
  const p = (id, t0, t1, act) => ({ corridor: { zoneId: id }, run: { activity: act || "ski" }, t0, t1 });
  assert.strictEqual(passesOverlap(p("a", 0, 60), p("b", 30, 90)), true);
  assert.strictEqual(passesOverlap(p("a", 0, 60), p("b", 50, 110)), false, "10 s of 60 is not the same descent");
  assert.strictEqual(passesOverlap(p("a", 0, 60), p("a", 0, 60)), false, "same corridor");
  assert.strictEqual(passesOverlap(p("a", 0, 60), p("b", 0, 60, "lift")), false, "lifts never");
});

test("QGeo.meanOffsetM: mean distance of the fixes from the centreline", () => {
  const corridor = { path: [[51.31, -117.05], [51.30, -117.05]], ref: [51.305, -117.05] };
  const lonAt = m => -117.05 + m / QGeoReal.mPerDegLon(51.305);
  const fixes = [{ lat: 51.306, lon: lonAt(4) }, { lat: 51.305, lon: lonAt(-8) }];
  assert.ok(Math.abs(QGeoReal.meanOffsetM(corridor, fixes) - 6) < 0.2);
});
