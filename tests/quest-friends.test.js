// Unit tests for Ridge Quest's "track my friends" feature (backend/worker.js
// friends/share/presence routes, migration 0060).
//
// worker.js is a Cloudflare Worker ES module with no test-friendly export
// surface (same situation tests/quest-stats.test.js and
// tests/record-heatmap.test.js already document) — the small pure helpers
// and the one non-trivial filter (GET /api/presence/friends' strict-mutual
// WHERE clause) are mirrored here VERBATIM in shape. If worker.js's versions
// change, update these mirrors to match.
//
// Run: `node --test tests/quest-friends.test.js` (or the full `node --test tests/`).
"use strict";

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

/* ---- mirrored verbatim from backend/worker.js ---- */
const QUEST_DAY_BUCKET_OFFSET_H = -7;
function questEndOfDay(nowMs) {
  const shifted = new Date(nowMs + QUEST_DAY_BUCKET_OFFSET_H * 3600000);
  const localMidnightUTC = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return localMidnightUTC - QUEST_DAY_BUCKET_OFFSET_H * 3600000 + 24 * 3600000;
}
function friendPair(a, b) { return a < b ? { lo: a, hi: b } : { lo: b, hi: a }; }

// Pure mirror of the GET /api/presence/friends contract: nothing unless the
// CALLER is sharing (strict mutual), then only accepted friends who are also
// sharing AND have a presence row inside the 60s freshness window.
function visibleFriends(callerShareUntil, now, rows) {
  if (!(callerShareUntil && callerShareUntil > now)) return [];
  return rows.filter(r =>
    r.status === "accepted" &&
    r.share_until && r.share_until > now &&
    r.presence_at && r.presence_at > now - 60000
  );
}

// Pure mirror of POST /api/friends/request's existing-row branch: a pending
// request in the OTHER direction + this one => accepted; otherwise unchanged.
function applyRequest(existing, requesterId) {
  if (!existing) return { status: "pending", requested_by: requesterId };
  if (existing.status === "pending" && existing.requested_by !== requesterId) {
    return { ...existing, status: "accepted" };
  }
  return existing;
}

/* ================================ tests ================================ */

(function testFriendPairIsOrderIndependent() {
  const a = friendPair("zzz", "aaa");
  const b = friendPair("aaa", "zzz");
  assert(a.lo === "aaa" && a.hi === "zzz", "pair sorts lexicographically regardless of arg order (a)");
  assert(a.lo === b.lo && a.hi === b.hi, "friendPair(x,y) === friendPair(y,x) — the UNIQUE(lo,hi) index collapses a request and its reverse");
})();

(function testEndOfDayIsNextLocalMidnight() {
  // 2026-09-02T20:00:00Z == 13:00 local Golden (UTC-7). End of that ski day
  // is the next local midnight == 2026-09-03T07:00:00Z.
  const got = questEndOfDay(Date.parse("2026-09-02T20:00:00Z"));
  assert(got === Date.parse("2026-09-03T07:00:00Z"), "afternoon session -> tonight's local midnight, got " + new Date(got).toISOString());
  // 2026-09-02T04:00:00Z == 21:00 local on Sept 1 -> end of day is Sept 2 00:00 local == 2026-09-02T07:00:00Z.
  const late = questEndOfDay(Date.parse("2026-09-02T04:00:00Z"));
  assert(late === Date.parse("2026-09-02T07:00:00Z"), "late-evening session still resolves to that same night's midnight, got " + new Date(late).toISOString());
  assert(questEndOfDay(Date.now()) > Date.now(), "end-of-day is always in the future");
})();

(function testStrictMutualHidesEverythingWhenCallerNotSharing() {
  const now = 1_000_000_000_000;
  const rows = [
    { status: "accepted", share_until: now + 3600000, presence_at: now - 5000 }
  ];
  assert(visibleFriends(null, now, rows).length === 0, "caller not sharing -> sees nothing (no share, no see)");
  assert(visibleFriends(now - 1, now, rows).length === 0, "caller's own share_until in the past -> sees nothing");
  assert(visibleFriends(now + 60000, now, rows).length === 1, "caller sharing -> sees a sharing, fresh, accepted friend");
})();

(function testFriendMustBeAcceptedSharingAndFresh() {
  const now = 1_000_000_000_000;
  const caller = now + 3600000;
  assert(visibleFriends(caller, now, [{ status: "pending", share_until: caller, presence_at: now }]).length === 0, "a pending request is not visible");
  assert(visibleFriends(caller, now, [{ status: "accepted", share_until: null, presence_at: now }]).length === 0, "an accepted friend who isn't sharing today is not visible");
  assert(visibleFriends(caller, now, [{ status: "accepted", share_until: caller, presence_at: now - 61000 }]).length === 0, "a stale presence row (>60s) is not visible");
  assert(visibleFriends(caller, now, [{ status: "accepted", share_until: caller, presence_at: now - 59000 }]).length === 1, "a fresh (<60s) sharing accepted friend IS visible");
})();

(function testReverseDirectionRequestAutoAccepts() {
  // B already requested A; now A requests B.
  const existing = { status: "pending", requested_by: "B" };
  assert(applyRequest(existing, "A").status === "accepted", "both sides asked -> friendship is accepted, no explicit Accept tap needed");
  // A requests B again while A's own request is still pending -> unchanged.
  assert(applyRequest({ status: "pending", requested_by: "A" }, "A").status === "pending", "re-sending your own pending request is a no-op");
  // Already friends -> unchanged.
  assert(applyRequest({ status: "accepted", requested_by: "B" }, "A").status === "accepted", "an existing accepted row is left alone");
  // No row yet -> a fresh pending request from the requester.
  assert(applyRequest(null, "A").status === "pending" && applyRequest(null, "A").requested_by === "A", "first request creates a pending row owned by the requester");
})();

(function testNoEnumerationContract() {
  // The email branch of POST /api/friends/request returns { ok:true } and
  // creates NO row when the email matches no account in this resort — same
  // rule as POST /api/players/forgot-password. This is a spec assertion:
  // the handler's `if (!row) return json({ ok: true, status: "pending" })`
  // path must not be reachable-only-after an INSERT.
  const fs = require("fs");
  const path = require("path");
  const worker = fs.readFileSync(path.join(__dirname, "..", "backend", "worker.js"), "utf8");
  const block = worker.slice(worker.indexOf('path === "/api/friends/request"'));
  const handler = block.slice(0, block.indexOf("\n  if (path ==="));
  const noRowIdx = handler.indexOf("No account enumeration");
  const insertIdx = handler.indexOf("INSERT INTO player_friend");
  assert(noRowIdx > -1, "friends/request keeps the no-enumeration comment/branch");
  assert(noRowIdx < insertIdx, "the unknown-email early return sits BEFORE the INSERT (no row is ever created for a miss)");
})();

(function testPresenceRequiresLiveShareUntil() {
  // Spec assertion mirroring POST /api/presence's guard.
  const fs = require("fs");
  const path = require("path");
  const worker = fs.readFileSync(path.join(__dirname, "..", "backend", "worker.js"), "utf8");
  const block = worker.slice(worker.indexOf('path === "/api/presence" && method === "POST"'));
  const handler = block.slice(0, block.indexOf("\n  // GET /api/presence/friends"));
  assert(/share_until\s*&&\s*acct\.share_until\s*>\s*Date\.now\(\)/.test(handler.replace(/\s+/g, " ")) ||
         /acct && acct\.share_until && acct\.share_until > Date\.now\(\)/.test(handler),
         "POST /api/presence refuses to store a position unless share_until is in the future (403)");
  assert(handler.includes('json({ error: "location sharing is off" }, 403'), "the refusal is a 403 with a clear message");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
