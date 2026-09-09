// Unit tests for Ridge Quest's checkpoint-measured daily vertical
// (Quest._tickCheckpoints in frontend/ridge-quest.html) — the guarded
// "last known elevation" running total that replaces noisy GPS-altitude
// deltas for the headline "Vertical today" / "This season" numbers.
//
// Extracts _tickCheckpoints straight out of the shipped file via the same
// brace-depth slice tests/quest-viewpoint-grant.test.js uses. Free
// variables the method closes over in the real <script> scope (QGeo,
// QUEST_TUNING, questDateBucketClient, setCheckpointVert) are injected as
// trailing params; this.onCheckpointVertical / this._reportCheckpointVertical
// are stubbed on the mock Quest.
//
// Run: `node tests/quest-checkpoint-vertical.test.js` (or as part of the
// full `node --test tests/` suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");

const qgeoM = html.match(/const QGeo = \{[\s\S]*?\n\};/);
if (!qgeoM) { console.log("FAIL: could not extract QGeo from ridge-quest.html"); process.exit(1); }
const QGeo = eval("(" + qgeoM[0].replace(/^const QGeo = /, "").replace(/;$/, "") + ")");

const tuningM = html.match(/const QUEST_TUNING = \{[\s\S]*?\n\};/);
if (!tuningM) { console.log("FAIL: could not extract QUEST_TUNING from ridge-quest.html"); process.exit(1); }
const QUEST_TUNING = eval("(" + tuningM[0].replace(/^const QUEST_TUNING = /, "").replace(/;$/, "") + ")");

const bucketM = html.match(/function questDateBucketClient\(date\)\{[\s\S]*?\n\}/);
if (!bucketM) { console.log("FAIL: could not extract questDateBucketClient from ridge-quest.html"); process.exit(1); }
// eslint-disable-next-line no-new-func
const questDateBucketClient = new Function("date", bucketM[0].slice(bucketM[0].indexOf("{") + 1, -1));

function extractMethodBody(startTag) {
  const startIdx = html.indexOf(startTag);
  if (startIdx < 0) throw new Error("could not find " + startTag + " in ridge-quest.html");
  let depth = 0, i = html.indexOf("{", startIdx);
  const bodyStart = i + 1;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(bodyStart, i);
}

// eslint-disable-next-line no-new-func
const tickCheckpointsBody = new Function(
  "p", "QGeo", "QUEST_TUNING", "questDateBucketClient", "setCheckpointVert",
  extractMethodBody("_tickCheckpoints(p){")
);

// Sanity: the persistence + season helpers this rework adds really exist.
assert(/function setCheckpointVert\(o\)\{/.test(html), "setCheckpointVert() helper exists in ridge-quest.html");
assert(/rq\.checkpointVert/.test(html), "the rq.checkpointVert localStorage key is used");
assert(/checkpoint_vertical_m/.test(html), "refreshStats reads checkpoint_vertical_m");

// Golden-BC-ish coordinates. Two checkpoints ~1.1 km apart N-S, 300 m apart
// in elevation (resortFullVerticalM = 300).
const TOP = { zoneId: "cp-top", name: "Gondola top", center: [51.310, -117.05], elevM: 2400 };
const MID = { zoneId: "cp-mid", name: "Mid station", center: [51.305, -117.05], elevM: 2250 };
const BASE = { zoneId: "cp-base", name: "Base", center: [51.300, -117.05], elevM: 2100 };

function mkQuest(checkpoints, extra) {
  const persisted = [];
  const q = Object.assign({
    checkpoints,
    resortFullVerticalM: (() => {
      const e = checkpoints.map(c => c.elevM);
      return e.length >= 2 ? Math.max.apply(null, e) - Math.min.apply(null, e) : 0;
    })(),
    checkpointVert: null,
    _cpCooldownUntil: {},
    _persisted: persisted,
    _reports: [],
    onCheckpointVertical: null,
    _reportCheckpointVertical(total, force) { this._reports.push({ total, force: !!force }); },
    tick(p) {
      return tickCheckpointsBody.call(this, p, QGeo, QUEST_TUNING,
        questDateBucketClient,
        (o) => { this.checkpointVert = o; persisted.push(JSON.parse(JSON.stringify(o))); });
    }
  }, extra || {});
  return q;
}
// A fix at checkpoint `cp` at wall-clock offset `tOffMs` from a fixed base.
const T0 = Date.UTC(2026, 11, 20, 18, 0, 0); // a fixed instant, mid-afternoon Golden time
function at(cp, tOffMs) { return { lat: cp.center[0], lon: cp.center[1], t: T0 + (tOffMs || 0) }; }
function away(tOffMs) { return { lat: 51.32, lon: -117.05, t: T0 + (tOffMs || 0) }; }

/* ---- seeding: the first checkpoint of the day credits nothing ---- */

(function testFirstCheckpointSeedsOnly() {
  const q = mkQuest([TOP, BASE]);
  q.tick(at(TOP, 0));
  assert(q.checkpointVert && q.checkpointVert.total === 0, "first checkpoint seeds lastElevM, credits 0, got total " + (q.checkpointVert && q.checkpointVert.total));
  assert(q.checkpointVert.lastElevM === 2400 && q.checkpointVert.lastZoneId === "cp-top", "lastElevM/lastZoneId anchored to the seeded checkpoint");
})();

/* ---- descent between two checkpoints credits the exact drop ---- */

(function testDescentCredited() {
  const q = mkQuest([TOP, BASE]);
  q.tick(at(TOP, 0));
  q.tick(at(BASE, 5 * 60000)); // 5 min later, at the base
  assert(q.checkpointVert.total === 300, "top(2400) -> base(2100) credits a 300 m descent, got " + q.checkpointVert.total);
  assert(q.checkpointVert.lastZoneId === "cp-base", "re-anchored to the base checkpoint");
})();

(function testTwoLapsAccumulate() {
  const q = mkQuest([TOP, BASE]);
  q.tick(at(TOP, 0));
  q.tick(at(BASE, 5 * 60000));
  // ride back up past the cooldown window, ski down again
  q.tick(at(TOP, 20 * 60000));
  q.tick(at(BASE, 25 * 60000));
  assert(q.checkpointVert.total === 600, "two full laps accumulate to 600 m, got " + q.checkpointVert.total);
})();

/* ---- ascent (lift / bootpack) credits nothing ---- */

(function testAscentCreditsNothing() {
  const q = mkQuest([TOP, BASE]);
  q.tick(at(BASE, 0));           // seed at base
  q.tick(at(TOP, 8 * 60000));    // ride the lift up to the top
  assert(q.checkpointVert.total === 0, "base -> top is an ascent, credits 0, got " + q.checkpointVert.total);
  assert(q.checkpointVert.lastElevM === 2400, "still re-anchors to the top for the next (downhill) leg");
})();

/* ---- single-delta cap = missed-checkpoint guard ---- */

(function testSingleDeltaCappedAtResortVertical() {
  // Two checkpoints 1000 m apart in elevation would be the whole mountain;
  // put a phantom third far below so resortFullVerticalM is only 300, then
  // jump top->deep-base in one hop (a middle checkpoint was missed).
  const DEEP = { zoneId: "cp-deep", name: "Deep", center: [51.300, -117.05], elevM: 1000 };
  const q = mkQuest([TOP, MID, DEEP]); // elevs 2400/2250/1000 -> resortFullVerticalM = 1400
  // Force a small cap for the assertion by overriding:
  q.resortFullVerticalM = 300;
  q.tick(at(TOP, 0));
  q.tick({ lat: DEEP.center[0], lon: DEEP.center[1], t: T0 + 3 * 60000 });
  assert(q.checkpointVert.total === 300, "a single delta bigger than resortFullVerticalM is capped to it (missed-checkpoint guard), got " + q.checkpointVert.total);
})();

/* ---- staleness: a gap over CHECKPOINT_STALE_MS re-anchors, credits 0 ---- */

(function testStaleGapDoesNotCredit() {
  const q = mkQuest([TOP, BASE]);
  q.tick(at(TOP, 0));
  q.tick(at(BASE, QUEST_TUNING.CHECKPOINT_STALE_MS + 60000)); // > 20 min later (lunch)
  assert(q.checkpointVert.total === 0, "a checkpoint pair more than CHECKPOINT_STALE_MS apart isn't one descent, credits 0, got " + q.checkpointVert.total);
  assert(q.checkpointVert.lastZoneId === "cp-base", "still re-anchors so the next timely leg credits");
})();

/* ---- per-checkpoint cooldown: a lingering hit can't re-credit ---- */

(function testCooldownPreventsDoubleCredit() {
  const q = mkQuest([TOP, BASE]);
  q.tick(at(TOP, 0));
  q.tick(at(BASE, 5 * 60000));           // credits 300
  q.tick(at(BASE, 5 * 60000 + 3000));    // still standing at the base 3 s later
  q.tick(at(BASE, 5 * 60000 + 8000));
  assert(q.checkpointVert.total === 300, "lingering at a checkpoint within its cooldown doesn't re-credit, got " + q.checkpointVert.total);
})();

(function testSameZoneIdReHitDoesNotCredit() {
  const q = mkQuest([TOP, BASE]);
  q.tick(at(TOP, 0));
  // come back to the SAME checkpoint after the cooldown — lastZoneId guard
  // means drop = lastElevM - sameElev = 0, no credit, no negative.
  q.tick(at(TOP, (QUEST_TUNING.CHECKPOINT_COOLDOWN_MS + 1000)));
  assert(q.checkpointVert.total === 0, "re-hitting the same checkpoint credits nothing (lastZoneId guard), got " + q.checkpointVert.total);
})();

/* ---- day rollover resets the total ---- */

(function testDayRolloverResets() {
  const q = mkQuest([TOP, BASE]);
  q.tick(at(TOP, 0));
  q.tick(at(BASE, 5 * 60000)); // total 300, day D1
  const dayOne = q.checkpointVert.day;
  // next tick a full day later — new questDateBucketClient bucket
  q.tick({ lat: TOP.center[0], lon: TOP.center[1], t: T0 + 26 * 3600000 });
  assert(q.checkpointVert.day !== dayOne, "the day-bucket rolled");
  assert(q.checkpointVert.total === 0, "the running total resets on a new ski day, got " + q.checkpointVert.total);
})();

/* ---- persistence: the total survives a simulated reload ---- */

(function testPersistedTotalRestored() {
  const q1 = mkQuest([TOP, BASE]);
  q1.tick(at(TOP, 0));
  q1.tick(at(BASE, 5 * 60000));
  const saved = q1._persisted[q1._persisted.length - 1];
  assert(saved && saved.total === 300, "the running total is persisted, got " + JSON.stringify(saved));
  // a fresh session on the SAME day restores it and keeps accumulating
  const q2 = mkQuest([TOP, BASE], { checkpointVert: JSON.parse(JSON.stringify(saved)) });
  q2.tick(at(TOP, 20 * 60000));
  q2.tick(at(BASE, 25 * 60000));
  assert(q2.checkpointVert.total === 600, "a reload mid-day resumes the total (300 restored + 300 new), got " + q2.checkpointVert.total);
})();

/* ---- callbacks + report throttling ---- */

(function testCreditFiresCallbackAndForcedReport() {
  const q = mkQuest([TOP, BASE]);
  const ticks = [];
  q.onCheckpointVertical = (t) => ticks.push(t);
  q.tick(at(TOP, 0));
  q.tick(at(BASE, 5 * 60000));
  assert(ticks.length === 1 && ticks[0] === 300, "onCheckpointVertical fires with the new total on a credit, got " + JSON.stringify(ticks));
  const forced = q._reports.filter(r => r.force);
  assert(forced.length >= 1 && forced[forced.length - 1].total === 300, "a credit forces a report of the running total, got " + JSON.stringify(q._reports));
})();

(function testNoCheckpointsIsInert() {
  const q = mkQuest([TOP]); // only one -> resortFullVerticalM = 0
  q.tick(at(TOP, 0));
  q.tick(away(60000));
  assert(q.checkpointVert === null, "with <2 checkpoints authored, _tickCheckpoints does nothing at all");
  assert(q._reports.length === 0, "no report posted when Layer 2 is inert");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
