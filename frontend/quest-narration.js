/* quest-narration.js — window.QuestNarration (2026-10-02)
 *
 * When Ridge Quest speaks a corridor's line, shared by ridge-quest.html (live) and
 * fence-editor.html Test Mode so Test Mode is exactly like live (user: "test mode has to
 * be exactly like live").
 *
 *  - Chutes, runs and boot packs: announced once per approach when the rider comes within
 *    PASS_ANNOUNCE_M of the corridor's band, as "<say>, on your left|right". The side is
 *    the nearest centreline point relative to the rider's travel heading (riders only go
 *    down, so the heading is reliable). Within SIDE_MIN_DEG of straight ahead/behind, or
 *    with no heading yet, it waits; already on the corridor, the line is said with no side.
 *    Silent while the rider is on a lift (chutes under the gondola).
 *  - Lifts: announced on entering the band (Schmitt-trigger hysteresis, see step()).
 *  - Re-armed only after the rider is REARM_M from the band (GPS wander can't repeat it).
 *  - Both side variants (or the lift line) are prefetched at PREFETCH_M.
 *
 * Positions are [lat, lon]; corridor.path is [[lat, lon], ...] (the published bundle's
 * layout). No DOM, no audio: the host speaks the returned text.
 */
(function (root) {
  "use strict";

  var TUNING = {
    NARRATE_HYSTERESIS_M: 3, // lift band: entering needs dist < -margin, leaving dist >= margin
    PASS_ANNOUNCE_M: 30,     // chute/run/boot pack: announce within this many m of the band
    SIDE_MIN_DEG: 20,        // within this of straight ahead/behind there is no honest side
    REARM_M: 40,             // re-arm beyond this many m from the band (= Ridge Quest REC_HOLD_M)
    PREFETCH_M: 200,         // fetch the audio this far out (first /api/tts took 1762 ms)
    COOLDOWN_MS: 4000        // lift band: no re-entry within this after leaving
  };
  var M_PER_DEG_LAT = 111320;

  function mPerDegLon(lat) { return 111320 * Math.cos(lat * Math.PI / 180); }
  function toXY(p, ref) { return { x: (p[1] - ref[1]) * mPerDegLon(ref[0]), y: (p[0] - ref[0]) * M_PER_DEG_LAT }; }

  // Nearest centreline point to pt: { d: metres to the centreline, v: rider -> that point (x east, y north) }.
  function nearest(pt, corridor) {
    var path = corridor.path || [];
    if (path.length < 2) return null;
    var ref = corridor.ref || path[0];
    var P = toXY(pt, ref), best = null;
    for (var i = 1; i < path.length; i++) {
      var A = toXY(path[i - 1], ref), B = toXY(path[i], ref);
      var vx = B.x - A.x, vy = B.y - A.y, len2 = vx * vx + vy * vy;
      var t = len2 > 0 ? ((P.x - A.x) * vx + (P.y - A.y) * vy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      var qx = A.x + t * vx - P.x, qy = A.y + t * vy - P.y, d = Math.hypot(qx, qy);
      if (!best || d < best.d) best = { d: d, v: { x: qx, y: qy } };
    }
    return best;
  }

  // Signed distance to the corridor's band edge (negative inside), same formula as Ridge Quest's
  // QGeo.corridorDist: centreline distance minus half the width (missing width = 10 m).
  function bandDist(pt, corridor) {
    var n = nearest(pt, corridor);
    return n ? n.d - (corridor.widthM || 10) / 2 : Infinity;
  }

  // "left" | "right" | null for a rider at pt travelling on headingDeg (0 = north).
  function sideOf(pt, corridor, headingDeg) {
    if (typeof headingDeg !== "number" || !isFinite(headingDeg)) return null;
    var n = nearest(pt, corridor);
    if (!n) return null;
    var len = Math.hypot(n.v.x, n.v.y);
    if (!(len > 0)) return null;
    var h = headingDeg * Math.PI / 180, hx = Math.sin(h), hy = Math.cos(h);
    var cross = hx * n.v.y - hy * n.v.x;
    if (Math.abs(cross) / len < Math.sin(TUNING.SIDE_MIN_DEG * Math.PI / 180)) return null;
    return cross > 0 ? "left" : "right";
  }

  // "This is Big Dumper" + "left" -> "This is Big Dumper, on your left". No side -> unchanged.
  function passingSay(say, side) {
    if (!side) return say;
    return String(say).trim().replace(/[.!,;:]+$/, "") + ", on your " + side;
  }

  // One fix for one corridor. st = per-corridor state object (kept by the host, starts {}).
  // corridor = { runType, widthM, say, path, ref? }. ctx = { headingDeg, narrOk, onLift,
  // now, canSay, canPrefetch } (canSay/canPrefetch: the host has somewhere to send them).
  // Returns { say: text | null, prefetch: [texts] }.
  function step(st, corridor, pt, ctx) {
    var out = { say: null, prefetch: [] };
    var now = ctx.now != null ? ctx.now : Date.now();
    var halfW = (corridor.widthM || 10) / 2;
    var dist = bandDist(pt, corridor);
    var isLift = corridor.runType === "lift";
    var say = corridor.say;
    if (!st.phase) st.phase = "idle";
    if (st.narrCooldownUntil == null) st.narrCooldownUntil = 0;

    if (dist > TUNING.REARM_M) st.narrArmed = true;

    if (ctx.narrOk && say && ctx.canPrefetch && !st.sayPrefetched && dist <= TUNING.PREFETCH_M) {
      st.sayPrefetched = true;
      out.prefetch = isLift ? [say] : [passingSay(say, "left"), passingSay(say, "right")];
    }

    if (!isLift && ctx.narrOk && say && ctx.canSay && st.narrArmed !== false && !ctx.onLift && dist <= TUNING.PASS_ANNOUNCE_M) {
      var side = dist > 0 ? sideOf(pt, corridor, ctx.headingDeg) : null;
      if (side || dist <= 0) {
        st.narrArmed = false;
        out.say = passingSay(say, side);
      }
    }

    // Lift band. The margin is capped at half the half-width so even a 4 m corridor can be entered.
    var margin = Math.min(TUNING.NARRATE_HYSTERESIS_M, halfW * 0.5);
    var inBand = st.phase === "inRun" ? dist < margin : dist < -margin;
    if (st.phase === "idle" && inBand) {
      if (now >= st.narrCooldownUntil) {
        st.phase = "inRun";
        if (isLift && ctx.narrOk && say && ctx.canSay && st.narrArmed !== false) {
          st.narrArmed = false;
          out.say = say;
        }
      }
    } else if (st.phase === "inRun" && !inBand) {
      st.phase = "idle";
      st.narrCooldownUntil = now + TUNING.COOLDOWN_MS;
    }
    return out;
  }

  var api = { TUNING: TUNING, bandDist: bandDist, sideOf: sideOf, passingSay: passingSay, step: step };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.QuestNarration = api;
})(typeof window !== "undefined" ? window : this);
