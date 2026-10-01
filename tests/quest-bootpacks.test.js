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
  assert.ok(/activity='hike'/.test(bp) && /vertical_m/.test(bp), bp);
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
  assert.ok(ep.includes("bootpacks\\/(daily|season)"), "daily and season routes");
  assert.ok(/today: bootPackTotals\(daily\), season: bootPackTotals\(season\)/.test(ep));
  assert.ok(/playerAuth\(request, env\)/.test(ep) && /P\.playerId !== decodeURIComponent\(mpbp\[1\]\)/.test(ep), "own stats only");
});

test("Home shows boot-pack tiles and a Boot packs screen", () => {
  assert.ok(/id="bpTodayN"/.test(html) && /id="bpTodayM"/.test(html) && /id="bpSeasonM"/.test(html), "three tiles");
  assert.ok(/refreshBootPackTiles\(playerId\);/.test(extract(html, "async function refreshStats(playerId){")), "tiles refresh with the stats");
  assert.ok(/"\/bootpacks\/daily"/.test(extract(html, "async function refreshBootPackTiles(playerId){")));
  assert.ok(/id="btnBootPacks"/.test(html) && /btnBootPacks"\)\.onclick=\(\)=>renderBootPacks\(\)/.test(html), "Home button opens the screen");
  assert.ok(/"\/bootpacks\/"\+mode/.test(extract(html, "async function renderBootPacks(mode){")));
});
