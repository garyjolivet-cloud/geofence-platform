// The simulated Ridge Quest day (frontend/quest-sim-day.js) and the social image's day built from
// in-memory runs (SocialCard.dayFromRuns) -- 2026-10-08, Gary: "test needs to be a true simulator
// ... only today data will be used no year to date or saving of test data".
//
// Run: `node --test tests/quest-sim-day.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

require("../frontend/social-card.js");
require("../frontend/quest-sim-day.js");
const { QuestSimDay, SocialCard } = globalThis;

const P = (lat0, lat1) => [[lat0, -117.05], [lat1, -117.05]];
const corridors = [
  { zoneId: "c1", name: "Main Dumper", runType: "chute", difficulty: "double-black", path: P(51.31, 51.305), descentM: 123, climbM: 0 },
  { zoneId: "c2", name: "Big Dumper", runType: "chute", difficulty: "black", path: P(51.31, 51.304), descentM: 150, climbM: 0 },
  { zoneId: "r1", name: "Pioneer", runType: "run", difficulty: "blue", path: P(51.30, 51.29), descentM: 300, climbM: 0 },
  { zoneId: "l1", name: "Golden Eagle Express Gondi", runType: "lift", difficulty: null, path: P(51.29, 51.31), descentM: 0, climbM: 1068 },
  { zoneId: "h1", name: "T2 Boot Pack", runType: "hike", difficulty: null, path: P(51.31, 51.312), descentM: 0, climbM: 60 }
];
const run = (zoneId, activity, verticalM) => { const c = corridors.find(x => x.zoneId === zoneId);
  return { zoneId, runName: c.name, difficulty: c.difficulty, runType: c.runType, activity, verticalM, distanceM: 500, durationS: 60,
    startedAt: "2026-10-08T15:00:00.000Z", endedAt: "2026-10-08T15:01:00.000Z", avgSpeedMps: 9, maxSpeedMps: 14 }; };

function fullDay() {
  const d = QuestSimDay.create({ rider: "Gary Jolivet", corridors });
  d.addRun(run("l1", "lift", -1068), 0);
  d.addRun(run("c1", "ski", -123), 492);
  d.addRun(run("c1", "ski", -123), 492);      // lapped
  d.addRun(run("c2", "ski", -150), 450);
  d.addRun(run("r1", "ski", -300), 450);
  d.addRun(run("h1", "hike", -60), 60);
  d.addRun(run("l1", "lift", -1068), 0);
  return d;
}

test("totals follow Home's rules: vertical = lift rides + boot packs, chutes n of total, runs = non-chute descents", () => {
  const t = fullDay().totals();
  assert.deepStrictEqual(t, { verticalM: 1068 + 1068 + 60, chutes: 2, chutesTotal: 2, runs: 1, liftRides: 2, points: 492 + 492 + 450 + 450 + 60 });
});

test("an empty day is all zeros and the rider defaults to a name", () => {
  const d = QuestSimDay.create({ corridors });
  assert.deepStrictEqual(d.totals(), { verticalM: 0, chutes: 0, chutesTotal: 2, runs: 0, liftRides: 0, points: 0 });
  assert.strictEqual(d.rider, "Test rider");
  assert.strictEqual(d.runs().length, 0);
});

test("the leaderboard is the test rider only, like the server's day row (scored vertical, ski runs)", () => {
  const b = fullDay().board();
  assert.strictEqual(b.length, 1);
  assert.deepStrictEqual(b[0], { playerId: "sim", name: "Gary Jolivet", points: 1944, verticalM: 123 + 123 + 150 + 300 + 60, runsCount: 4 });
});

test("skiedSet is the chutes skied; a boot pack or a run is never a chute skied", () => {
  const s = fullDay().skiedSet();
  assert.deepStrictEqual([...s].sort(), ["c1", "c2"]);
});

test("reset empties the day; nothing is ever stored or fetched", () => {
  const d = fullDay(); d.reset();
  assert.strictEqual(d.runs().length, 0);
  const src = fs.readFileSync(path.join(__dirname, "../frontend/quest-sim-day.js"), "utf8").replace(/\/\*[\s\S]*?\*\//, "");
  assert.ok(!/localStorage|sessionStorage|fetch\(|indexedDB|XMLHttpRequest/.test(src), "no storage, no network");
  assert.ok(!/speed/i.test(src.replace(/Never show or reward speed/g, "")), "no speed anywhere");
});

test("the social image's day: same shape as the phone's, today only, no season", () => {
  const d = fullDay().socialDay({ resort: "Kicking Horse", track: [[[-117.05, 51.31], [-117.05, 51.305]], [[-117.05, 51.3]]], dateLabel: "Thursday, October 8" });
  assert.strictEqual(d.kind, "day");
  assert.strictEqual(d.season, null, "no season-to-date on a simulated day");
  assert.strictEqual(d.rider, "Gary Jolivet");
  assert.strictEqual(d.resort, "Kicking Horse");
  assert.strictEqual(d.verticalM, 2196);
  assert.strictEqual(d.points, 1944);
  assert.strictEqual(d.runs, 4, "ski descents");
  assert.deepStrictEqual(d.chutes, [{ name: "Main Dumper", difficulty: "double-black", count: 2, zoneId: "c1" }, { name: "Big Dumper", difficulty: "black", count: 1, zoneId: "c2" }]);
  assert.strictEqual(d.chuteCount, 2);
  assert.strictEqual(d.liftRides, 2);
  assert.strictEqual(d.lifts.length, 1); assert.strictEqual(d.lifts[0].count, 2); assert.strictEqual(d.lifts[0].verticalM, 2136);
  assert.deepStrictEqual({ count: d.bootPacks.count, verticalM: d.bootPacks.verticalM }, { count: 1, verticalM: 60 });
  assert.strictEqual(d.geo.chutes.length, 2); assert.strictEqual(d.geo.lifts.length, 1); assert.strictEqual(d.geo.bootPacks.length, 1);
  assert.deepStrictEqual(d.geo.chutes[0][0], [-117.05, 51.31], "paths are [lon,lat] for the map");
  assert.strictEqual(d.geo.track.length, 1, "a one-point track piece is dropped");
  assert.ok(d.geo.network.chutes.length === 2 && d.geo.network.lifts.length === 1, "framed on the whole resort network");
  // the drawing code accepts it (text summary used for EXIF) and never mentions speed
  const sum = SocialCard.summary(d);
  assert.ok(typeof sum === "string" && sum.length > 10 && !/km\/h|mph|speed/i.test(sum));
});

test("the phone's own collectDay still maps weather the same way (shared weatherFrom)", () => {
  assert.deepStrictEqual(SocialCard.weatherFrom({ ww_temp_c: -8, ww_wind_spd_kph: 14.6, ww_wind_dir_deg: 270 }, [{ hn24_cm: 12 }]),
    { snow24: 12, tempC: -8, windKph: 15, windDir: "W" });
  assert.strictEqual(SocialCard.weatherFrom({ error: "x" }, []), null);
  assert.strictEqual(SocialCard.weatherFrom(null, null), null);
});
