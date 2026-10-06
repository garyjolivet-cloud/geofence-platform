// Boot packs are stats of their own (2026-09-30). A climb (stored activity "hike") never counts
// as a chute lap; it has its own Home tiles, its own "Boot packs" screen and its own endpoints.
//
// Run: `node --test tests/quest-bootpacks.test.js`
"use strict";
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const worker = fs.readFileSync(path.join(__dirname, "../backend/worker.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");
function extract(src, startTag) {
  const s = src.indexOf(startTag);
  assert.ok(s >= 0, "found " + startTag);
  let depth = 0, i = src.indexOf("{", s);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(s, i + 1);
}
// eslint-disable-next-line no-new-func
const lib = new Function(extract(worker, "function aggregateChuteCounts(") + "\n" + extract(worker, "function bootPackTotals(") +
  "\nreturn { aggregateChuteCounts, bootPackTotals };")();

test("chute laps only count ski descents; boot packs only count climbs", () => {
  const laps = worker.match(/const CHUTE_LAPS_SQL = "([^"]+)"/)[1];
  assert.ok(/run_type='chute'/.test(laps) && /activity='ski'/.test(laps), laps);
  const bp = worker.match(/const BOOTPACKS_SQL = "([^"]+)"/)[1];
  assert.ok(/activity='hike'/.test(bp) && /run_type='hike'/.test(bp) && /vertical_m/.test(bp), "only routes marked as boot packs (2026-10-01): " + bp);
  assert.strictEqual((worker.match(/prepare\(CHUTE_LAPS_SQL\)/g) || []).length, 2, "both chute endpoints use it");
  assert.ok(!/run_type='chute' ORDER BY/.test(worker), "no chute query left without the ski filter");
});

test("boot packs are grouped per route with vertical climbed, plus today and season totals", () => {
  const day = r => r.slice(0, 10), rows = [
    { zone_id: "guts", run_name: "Guts Hike", difficulty: null, started_at: "2026-09-30T10:00:00Z", vertical_m: -73 },
    { zone_id: "guts", run_name: "Guts Hike", difficulty: null, started_at: "2026-09-30T09:00:00Z", vertical_m: -70 },
    { zone_id: "t1", run_name: "T1 Hike", difficulty: null, started_at: "2026-09-30T08:00:00Z", vertical_m: null },
    { zone_id: "t1", run_name: "T1 Hike", difficulty: null, started_at: "2026-09-29T08:00:00Z", vertical_m: -95 }
  ];
  const today = lib.aggregateChuteCounts(rows, day, "2026-09-30");
  assert.deepStrictEqual(today.map(r => [r.zoneId, r.count, r.verticalM]), [["guts", 2, 143], ["t1", 1, 0]]);
  assert.deepStrictEqual(lib.bootPackTotals(today), { count: 3, verticalM: 143 });
});

test("the endpoint answers routes plus both totals", () => {
  const ep = worker.slice(worker.indexOf("const mpbp = path.match("), worker.indexOf("const mpbp = path.match(") + 1500);
  assert.ok(ep.includes("(bootpacks|lifts)\\/(daily|season)"), "daily and season routes");
  assert.ok(/today: bootPackTotals\(daily\), season: bootPackTotals\(season\)/.test(ep));
  assert.ok(/playerAuth\(request, env\)/.test(ep) && /P\.playerId !== decodeURIComponent\(mpbp\[1\]\)/.test(ep), "own stats only");
});

// 2026-10-06 (Gary: "Remove boot pack stats info. Only use boot pack to calculate elevation"):
// no boot pack numbers, tile or screen button on Home; boot packs still feed Vertical.
test("Home: no boot pack stats; boot packs still count toward vertical", () => {
  const home = extract(html, "function renderHome(){");
  assert.ok(!/bpTodayN|bpTodayM|bpSeasonM|btnBootPacks/.test(home), "no boot pack tiles or button on Home");
  assert.ok(/refreshClimbTiles\(playerId\);/.test(extract(html, "async function refreshStats(playerId){")), "vertical still refreshes with the stats");
  const climb = extract(html, "async function refreshClimbTiles(playerId){");
  assert.ok(/"\/bootpacks\/daily"/.test(climb) && /set\("vertToday", m\(\(\(bp\.today&&bp\.today\.verticalM\)\|\|0\) \+ \(\(lf\.today&&lf\.today\.verticalM\)\|\|0\)\)\);/.test(climb),
    "Vertical today = boot packs + lifts");
  assert.ok(/"\/"\+kind\+"\/"\+mode/.test(extract(html, "async function renderTally(kind, mode){")), "the screen fetches /bootpacks|lifts/<mode>");
  assert.ok(/return renderTally\("bootpacks", mode\)/.test(html) && /return renderTally\("lifts", mode\)/.test(html));
});

// 2026-09-30: "lifts and number of times needs to be recorded also".
test("lift rides are tallied per lift, with a Home tile and their own screen", () => {
  const lifts = worker.match(/const LIFTS_SQL = "([^"]+)"/)[1];
  assert.ok(/activity='lift'/.test(lifts), lifts);
  assert.ok(worker.includes("(bootpacks|lifts)\\/(daily|season)"), "one endpoint serves both");
  assert.ok(/prepare\(mpbp\[2\] === "lifts" \? LIFTS_SQL : BOOTPACKS_SQL\)/.test(worker));
  assert.ok(/hs\("liftTodayN","Lift rides"\)/.test(html) && /"\/lifts\/daily"/.test(extract(html, "async function refreshClimbTiles(playerId){")), "Lift rides today tile");
  assert.ok(/vertical_m/.test(worker.match(/const LIFTS_SQL = "([^"]+)"/)[1]), "lift rides carry their vertical");
  assert.ok(/b\.activity === "lift" \? 0 : Math\.abs\(verticalM \|\| 0\)/.test(worker), "lift vertical stays out of the scored day vertical_m");
  assert.ok(/tile\("btnLifts","🚡","Lift rides"\)/.test(html) && /btnLifts"\)\.onclick=\(\)=>renderLifts\(\)/.test(html), "Home button opens Lift rides");
  const day = r => r.slice(0, 10);
  const rows = [
    { zone_id: "gondola", run_name: "Golden Eagle Express", started_at: "2026-09-30T10:00:00Z" },
    { zone_id: "gondola", run_name: "Golden Eagle Express", started_at: "2026-09-30T12:00:00Z" },
    { zone_id: "stairway", run_name: "Stairway Chair", started_at: "2026-09-30T11:00:00Z" }
  ];
  const t = lib.aggregateChuteCounts(rows, day, "2026-09-30");
  assert.deepStrictEqual(t.map(r => [r.name, r.count]), [["Golden Eagle Express", 2], ["Stairway Chair", 1]]);
  assert.deepStrictEqual(lib.bootPackTotals(t), { count: 3, verticalM: 0 });
});

// 2026-09-30: "use lift and boot pack elevations to calculate total vertical for the day, not chute
// elevations" -- and for the season ("for year also").
test("Home's total vertical is lifts + boot packs, today and this season", () => {
  const f = extract(html, "async function refreshClimbTiles(playerId){");
  assert.ok(/set\("vertToday", m\(\(\(bp\.today&&bp\.today\.verticalM\)\|\|0\) \+ \(\(lf\.today&&lf\.today\.verticalM\)\|\|0\)\)\)/.test(f), "today = boot packs + lifts");
  assert.ok(/set\("vertSeason", m\(\(\(bp\.season&&bp\.season\.verticalM\)\|\|0\) \+ \(\(lf\.season&&lf\.season\.verticalM\)\|\|0\)\)\)/.test(f), "season = boot packs + lifts");
  const stats = extract(html, "async function refreshStats(playerId){");
  assert.ok(!/checkpoint_vertical_m|vertical_m/.test(stats), "neither the checkpoint total nor the chute-descent vertical_m drives the tiles");
  assert.ok(stats.indexOf("tilesEl.innerHTML") < stats.indexOf("await api("), "tiles are drawn before the stats request, so a failing request can't blank the row");
});
