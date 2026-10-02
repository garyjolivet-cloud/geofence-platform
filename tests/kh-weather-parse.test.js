// Kicking Horse weather scrape (backend/worker.js parseKhWeather), 2026-10-02.
// The old parser required every row to start with the Dogtooth plot's date. Off-season
// that half of the table is blank while the White Wall station keeps reporting, so every
// scrape since ~2026-08-23 threw "No Dogtooth data rows found" and /api/weather kept
// serving the Aug 8 reading. The fixture is the real table from 2026-10-02.
//
// Run: `node --test tests/kh-weather-parse.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const worker = fs.readFileSync(path.join(__dirname, "../backend/worker.js"), "utf8").replace(/\r/g, "");
const s = worker.indexOf("function parseKhWeather(");
let d = 0, i = worker.indexOf("{", s);
for (; i < worker.length; i++) { if (worker[i] === "{") d++; else if (worker[i] === "}") { d--; if (d === 0) break; } }
// eslint-disable-next-line no-new-func
const parse = new Function(worker.slice(s, i + 1) + "\nreturn parseKhWeather;")();

const real = fs.readFileSync(path.join(__dirname, "fixtures/kh-weather-2026-10-02.html"), "utf8");
const OCT2 = new Date("2026-10-02T18:00:00Z");

(function testOffSeasonPageReadsWhiteWall() {
  const r = parse(real, OCT2);
  assert(r.readingDate === "2026-10-02" && r.readingTime === 1100, "latest White Wall row is 10/2 at 1100, got " + r.readingDate + " " + r.readingTime);
  assert(r.wwWs === 18 && r.wwWd === 243 && r.wwGust === 25, "wind 18 kph from 243, gust 25, got " + JSON.stringify(r));
  assert(r.wwTemp === 0 && !Object.is(r.wwTemp, -0), "the page's \"-0\" is stored as 0 (no \"-0°\" on screen)");
  assert(r.hn24 === null && r.hst === null && r.hs === null && r.hourPrecip === null && r.precip24hr === null,
    "blank Dogtooth columns give null snow/precip — never a stale or guessed number");
})();

// Same layout, in season: both halves filled (column positions copied from the real header).
const HEADER = [
  "  Dogtooth                                         Hour       24hr  Precip  WhiteWall          2 min  spot   Max      ",
  "                     Air        HN24   HST    HS  Precip    Precip   Gauge                Air avg WS    WD  Gust  Wind",
  "      Date  Time  Temp C    RH Board Board            mm        mm      mm       Time  Temp C    kph         kph   Run",
  "----------------------------------------------------------------------------------------------------------------------"
];
const page = rows => "<h3>Dogtooth Snow Study Plot | 2060 metres</h3><p><PRE>\r\n" + HEADER.concat(rows).join("\r\n") + "\r\n</PRE><h3>Descriptions</h3>";
const WW_COL = HEADER[2].lastIndexOf("Time") + 4;   // White Wall time is right-aligned here
const row = (dog, ww) => { const left = dog || ""; return left + " ".repeat(Math.max(1, WW_COL - 4 - left.length)) + ww; };

(function testInSeasonRowUsesBothHalves() {
  const r = parse(page([
    row("    1 15  1100    -9    80    12    30   210     0.4       8.2   512.0", "1100     -14     22   250    40   300    1 15"),
    row("    1 15  1200    -8    78    14    32   212     0.5       9.1   512.5", "1200     -13     25   255    44   320    1 15")
  ]), new Date("2027-01-15T20:00:00Z"));
  assert(r.readingDate === "2027-01-15" && r.readingTime === 1200 && r.wwTemp === -13, "in season the latest row's White Wall values are used, got " + JSON.stringify(r));
  assert(r.hn24 === 14 && r.hst === 32 && r.hs === 212 && r.hourPrecip === 0.5 && r.precip24hr === 9.1,
    "a complete Dogtooth half gives snow and precip, got " + JSON.stringify(r));
})();

(function testPartialDogtoothHalfIsIgnored() {
  // RH missing: 10 values can't be placed reliably, so none are used.
  const r = parse(page([row("    1 15  1200    -8          14    32   212     0.5       9.1   512.5", "1200     -13     25   255    44   320    1 15")]),
    new Date("2027-01-15T20:00:00Z"));
  assert(r.wwTemp === -13 && r.hn24 === null && r.hs === null, "a partial Dogtooth half gives null snow, White Wall still read, got " + JSON.stringify(r));
})();

(function testDecemberReadInJanuaryIsLastYear() {
  const r = parse(page([row("", "2300      -5     10   200    15   100   12 31")]), new Date("2027-01-01T08:00:00Z"));
  assert(r.readingDate === "2026-12-31", "a Dec 31 row read on Jan 1 is last year's, got " + r.readingDate);
})();

(function testBrokenPagesThrow() {
  const threw = html => { try { parse(html, OCT2); return null; } catch (e) { return e.message; } };
  assert(/table not found/.test(threw("<html>nothing here</html>") || ""), "a page without the table throws");
  assert(/No White Wall data rows/.test(threw(page([])) || ""), "a table with no rows throws (the cron logs it, the old reading stays)");
})();

(function testScrapeStoresNullsNotNaN() {
  const fn = worker.slice(worker.indexOf("async function scrapeWeather(env){".replace("){", ") {")), worker.indexOf("function parseKhWeather("));
  assert(/const r = parseKhWeather\(html\);/.test(fn) && !/parseFloat\(/.test(fn), "scrapeWeather binds the parsed values as-is (parseFloat(null) would store NaN)");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
