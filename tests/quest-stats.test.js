// Unit tests for Ridge Quest R3-core's points/day-bucket/season/leaderboard
// helpers (backend/worker.js) and the client-side streak derivation
// (frontend/ridge-quest.html).
//
// worker.js is a Cloudflare Worker ES module with no test-friendly export
// surface (same situation tests/record-heatmap.test.js already documents
// for this codebase's other worker.js-side logic) — questDateBucket/
// questSeasonId/questPoints/questSnowBonus are mirrored here VERBATIM
// rather than imported. If worker.js's versions change, update these
// mirrors to match.
//
// The streak walk in ridge-quest.html's refreshStats() is presentational
// glue around a real GPS-tick loop and a live `new Date()` call, not a
// closed-form algorithm — reimplemented locally rather than extracted,
// same reasoning tests/gpsfilter-trigger-comparison.test.js already
// documents for its own local reimplementation. questDateBucketClient(),
// the one piece of real date-bucketing math it depends on, IS extracted
// verbatim from the shipped file below, so the streak test still exercises
// the actual bucketing code that ships.
//
// Run: `node --test tests/quest-stats.test.js` (or as part of the full
// `node --test tests/` suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

/* ---- mirrored verbatim from backend/worker.js ---- */
const QUEST_DAY_BUCKET_OFFSET_H = -7;
function questDateBucket(iso) {
  return new Date(new Date(iso).getTime() + QUEST_DAY_BUCKET_OFFSET_H * 3600000).toISOString().slice(0, 10);
}
function questSeasonId(iso) {
  const d = new Date(new Date(iso).getTime() + QUEST_DAY_BUCKET_OFFSET_H * 3600000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  return m >= 9 ? (y + "-" + (y + 1)) : ((y - 1) + "-" + y);
}
const QUEST_DIFFICULTY_POINTS_PER_VERT_M = { green: 1, blue: 1.5, black: 2, "double-black": 3 };
const QUEST_RUNTYPE_POINTS_MULTIPLIER = { run: 1, chute: 1.4, bowl: 1.2, ridge: 1.3, hike: 1.1 };
const QUEST_ACTIVITY_DISTANCE_POINTS_PER_M = { bike: 0.18, drive: 0.06, xcski: 0.065 };
const QUEST_BIKE_DIFFICULTY_MULTIPLIER = { green: 1, blue: 1.4, black: 1.8, "double-black": 2.4 };
const QUEST_XCSKI_DIFFICULTY_MULTIPLIER = { green: 1, blue: 1.15, black: 1.3 };
function questPoints(activity, difficulty, runType, verticalM, distanceM, snowBonus) {
  if (activity === "lift") return 0;
  if (activity === "ski" || activity === "hike") {
    if (verticalM == null) return 0;
    const w = (QUEST_DIFFICULTY_POINTS_PER_VERT_M[difficulty] || 1) * (QUEST_RUNTYPE_POINTS_MULTIPLIER[runType] || 1) * (snowBonus || 1);
    return Math.round(Math.abs(verticalM) * w);
  }
  if (activity === "bike" || activity === "drive" || activity === "xcski") {
    if (distanceM == null) return 0;
    const perM = QUEST_ACTIVITY_DISTANCE_POINTS_PER_M[activity] || 0;
    const diffMult = activity === "bike" ? (QUEST_BIKE_DIFFICULTY_MULTIPLIER[difficulty] || 1)
      : activity === "xcski" ? (QUEST_XCSKI_DIFFICULTY_MULTIPLIER[difficulty] || 1)
      : 1;
    return Math.round(Math.abs(distanceM) * perM * diffMult);
  }
  return 0;
}
const QUEST_SNOW_BONUS_TIERS = [[30, 1.5], [15, 1.25], [5, 1.1]];
function questSnowBonus(hn24Cm) {
  if (hn24Cm == null) return 1;
  for (const [threshold, mult] of QUEST_SNOW_BONUS_TIERS) if (hn24Cm >= threshold) return mult;
  return 1;
}

/* ---- questDateBucketClient extracted verbatim from ridge-quest.html ---- */
const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");
const bucketM = html.match(/function questDateBucketClient\(date\)\{[\s\S]*?\n\}/);
if (!bucketM) { console.log("FAIL: could not extract questDateBucketClient from ridge-quest.html"); process.exit(1); }
// eslint-disable-next-line no-new-func
const questDateBucketClient = new Function("date", bucketM[0].slice(bucketM[0].indexOf("{") + 1, -1));

/* ---- questDateBucket ---- */

(function testDateBucketNormalCase() {
  assert(questDateBucket("2026-01-15T20:00:00.000Z") === "2026-01-15", "8pm UTC minus 7h is still the same UTC calendar day, got " + questDateBucket("2026-01-15T20:00:00.000Z"));
})();

(function testDateBucketCrossesUtcMidnightBackward() {
  // 2am UTC Jan 16 minus 7h = 7pm UTC Jan 15 — a real run just after
  // midnight UTC (e.g. 7pm local in Golden BC) must bucket into the
  // PREVIOUS UTC calendar day, not the naive date(started_at) day.
  assert(questDateBucket("2026-01-16T02:00:00.000Z") === "2026-01-15", "a fix just after UTC midnight buckets into the previous day under the -7h rule, got " + questDateBucket("2026-01-16T02:00:00.000Z"));
})();

(function testDateBucketClientMirrorsServer() {
  const iso = "2026-01-16T02:00:00.000Z";
  assert(questDateBucketClient(new Date(iso)) === questDateBucket(iso), "client and server date-bucket agree on the same instant, got client=" + questDateBucketClient(new Date(iso)) + " server=" + questDateBucket(iso));
})();

/* ---- questSeasonId ---- */

(function testSeasonIdBeforeRollover() {
  assert(questSeasonId("2026-03-15T12:00:00.000Z") === "2025-2026", "March 2026 is in the 2025-2026 season, got " + questSeasonId("2026-03-15T12:00:00.000Z"));
})();

(function testSeasonIdAfterRollover() {
  assert(questSeasonId("2026-11-15T12:00:00.000Z") === "2026-2027", "November 2026 is in the 2026-2027 season, got " + questSeasonId("2026-11-15T12:00:00.000Z"));
})();

(function testSeasonIdAtRolloverMonth() {
  assert(questSeasonId("2026-09-01T12:00:00.000Z") === "2026-2027", "September 1 itself rolls into the new season, got " + questSeasonId("2026-09-01T12:00:00.000Z"));
})();

/* ---- questPoints ---- */

(function testPointsWeightedByDifficultyAndRunType() {
  const p = questPoints("ski", "black", "chute", 300, null, 1);
  assert(p === Math.round(300 * 2 * 1.4), "black chute: 300m * 2 (black) * 1.4 (chute), got " + p);
})();

(function testPointsDefaultWeightsForUnknownValues() {
  const p = questPoints("ski", "unknown-difficulty", "unknown-runtype", 100, null, 1);
  assert(p === 100, "unrecognized difficulty/runType both default to weight 1, got " + p);
})();

(function testLiftAlwaysZeroPoints() {
  assert(questPoints("lift", "black", "run", 500, 2000, 1.5) === 0, "a lift ride always earns 0 points regardless of other inputs");
})();

(function testNoVerticalZeroPoints() {
  assert(questPoints("ski", "black", "run", null, null, 1) === 0, "a run with no altitude reading earns 0 points");
})();

(function testSnowBonusMultiplies() {
  const base = questPoints("ski", "blue", "run", 200, null, 1);
  const withBonus = questPoints("ski", "blue", "run", 200, null, 1.5);
  assert(withBonus === Math.round(base * 1.5), "a 1.5x snow bonus multiplies the final points, got base=" + base + " withBonus=" + withBonus);
})();

/* ---- questPoints: bike/drive (R6, distance-based) ---- */

(function testBikeWeightedByDistanceAndDifficulty() {
  const p = questPoints("bike", "black", null, null, 2000, 1);
  assert(p === Math.round(2000 * 0.18 * 1.8), "black MTB trail: 2000m * 0.18 (per-m) * 1.8 (black), got " + p);
})();

(function testDriveIgnoresDifficulty() {
  const withDiff = questPoints("drive", "black", null, null, 8000, 1);
  const noDiff = questPoints("drive", null, null, null, 8000, 1);
  assert(withDiff === noDiff, "drive's difficulty multiplier is always 1 regardless of the corridor's difficulty field, got withDiff=" + withDiff + " noDiff=" + noDiff);
  assert(withDiff === Math.round(8000 * 0.06), "8km drive: 8000m * 0.06 (per-m), got " + withDiff);
})();

(function testBikeNoDistanceZeroPoints() {
  assert(questPoints("bike", "blue", null, null, null, 1) === 0, "a bike run with no distance reading earns 0 points");
})();

(function testDriveNoDistanceZeroPoints() {
  assert(questPoints("drive", null, null, null, null, 1) === 0, "a drive with no distance reading earns 0 points");
})();

(function testBikeIgnoresVerticalAndSnowBonus() {
  // bike/drive dispatch entirely on distanceM — verticalM/snowBonus (both
  // ski/hike-only concepts) must have zero effect on the result.
  const a = questPoints("bike", "green", null, 500, 1000, 1.5);
  const b = questPoints("bike", "green", null, null, 1000, 1);
  assert(a === b, "vertical/snowBonus don't affect bike scoring at all, got a=" + a + " b=" + b);
})();

(function testLiftZeroRegardlessOfDistance() {
  assert(questPoints("lift", "black", "run", null, 5000, 1) === 0, "a lift ride earns 0 points even with a distance reading present");
})();

/* ---- questPoints: xcski (R12, distance-based like bike/drive, but with
   its own difficulty multiplier — real Nordic centres genuinely grade
   trails green/blue/black, unlike a road) ---- */

(function testXcskiWeightedByDistanceAndDifficulty() {
  const p = questPoints("xcski", "blue", null, null, 10000, 1);
  assert(p === Math.round(10000 * 0.065 * 1.15), "blue 10km xc loop: 10000m * 0.065 (per-m) * 1.15 (blue), got " + p);
})();

(function testXcskiUnknownDifficultyDefaultsToWeight1() {
  const p = questPoints("xcski", "unknown-difficulty", null, null, 1000, 1);
  assert(p === Math.round(1000 * 0.065), "an unrecognized difficulty defaults to a 1x multiplier, got " + p);
})();

(function testXcskiNoDistanceZeroPoints() {
  assert(questPoints("xcski", "green", null, null, null, 1) === 0, "an xcski outing with no distance reading earns 0 points");
})();

(function testXcskiIgnoresVerticalAndSnowBonus() {
  const a = questPoints("xcski", "green", null, 300, 5000, 1.5);
  const b = questPoints("xcski", "green", null, null, 5000, 1);
  assert(a === b, "vertical/snowBonus don't affect xcski scoring at all, got a=" + a + " b=" + b);
})();

(function testXcskiDoesNotUseBikeDifficultyScale() {
  // xcski and bike must each look up difficulty in their OWN multiplier
  // table — same distance/difficulty inputs must NOT produce the same
  // points, since bike's black is 1.8x but xcski's black is 1.3x.
  const bike = questPoints("bike", "black", null, null, 4000, 1);
  const xc = questPoints("xcski", "black", null, null, 4000, 1);
  assert(bike !== xc, "bike and xcski use distinct difficulty scales, so identical inputs must score differently, got bike=" + bike + " xc=" + xc);
})();

/* ---- questSnowBonus ---- */

(function testSnowBonusTiers() {
  assert(questSnowBonus(35) === 1.5, "35cm hits the top tier, got " + questSnowBonus(35));
  assert(questSnowBonus(30) === 1.5, "exactly 30cm hits the top tier (inclusive), got " + questSnowBonus(30));
  assert(questSnowBonus(20) === 1.25, "20cm hits the mid tier, got " + questSnowBonus(20));
  assert(questSnowBonus(7) === 1.1, "7cm hits the low tier, got " + questSnowBonus(7));
  assert(questSnowBonus(2) === 1, "2cm (below all tiers) gets no bonus, got " + questSnowBonus(2));
})();

(function testSnowBonusNullIsNoBonusNotPenalty() {
  assert(questSnowBonus(null) === 1, "no snow_history snapshot yet is a neutral 1x, not a penalty, got " + questSnowBonus(null));
})();

/* ---- streak (reimplements refreshStats()'s walk-backward loop, using the
   REAL extracted questDateBucketClient — see file header for why the loop
   itself isn't extracted verbatim) ---- */
function computeStreak(days, now) {
  const byDate = {}; days.forEach(d => { byDate[d.date] = d; });
  let streak = 0, cursor = now;
  for (;;) {
    const key = questDateBucketClient(cursor);
    const row = byDate[key];
    if (!row || (row.runs_count <= 0 && row.lift_rides <= 0 && row.hikes <= 0)) break;
    streak++;
    cursor = new Date(cursor.getTime() - 24 * 3600000);
  }
  return streak;
}

(function testStreakConsecutiveDays() {
  const now = new Date("2026-01-16T02:00:00.000Z"); // buckets to 2026-01-15
  const days = [
    { date: "2026-01-15", runs_count: 2, lift_rides: 1, hikes: 0 },
    { date: "2026-01-14", runs_count: 1, lift_rides: 0, hikes: 0 },
    { date: "2026-01-13", runs_count: 0, lift_rides: 0, hikes: 1 },
    { date: "2026-01-12", runs_count: 0, lift_rides: 0, hikes: 0 } // breaks the streak
  ];
  assert(computeStreak(days, now) === 3, "three consecutive played days, got " + computeStreak(days, now));
})();

(function testStreakZeroWhenTodayMissing() {
  const now = new Date("2026-01-16T02:00:00.000Z");
  const days = [{ date: "2026-01-14", runs_count: 1, lift_rides: 0, hikes: 0 }];
  assert(computeStreak(days, now) === 0, "no row for today's bucket means a zero streak even if earlier days played, got " + computeStreak(days, now));
})();

(function testStreakZeroWhenTodayRowIsAllZero() {
  const now = new Date("2026-01-16T02:00:00.000Z");
  const days = [{ date: "2026-01-15", runs_count: 0, lift_rides: 0, hikes: 0 }];
  assert(computeStreak(days, now) === 0, "an all-zero day (a fog-reveal-only session with no classified run) doesn't count as played, got " + computeStreak(days, now));
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
