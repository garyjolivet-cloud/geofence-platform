/* quest-narration.js — window.QuestNarration (2026-10-02)
 *
 * When Ridge Quest speaks a corridor's line, shared by ridge-quest.html (live) and
 * fence-editor.html Test Mode so Test Mode is exactly like live (user: "test mode has to
 * be exactly like live").
 *
 *  - Chutes, runs and boot packs are announced once per approach when the rider comes within
 *    PASS_ANNOUNCE_M of the band (or is in it) — but only while the rider is skiing inside a
 *    chute or run themselves (ctx.inRun, see insideRun()). User 2026-10-02/03: 30 m was "too far
 *    out", "try 5 meters", "only when in chute or run"; the left/right side that was added to the
 *    line for a day was removed ("remove code for right and left detection").
 *  - A chute / run / boot pack with no authored line says "This is <name>" (user: "make it
 *    automatic"). A lift with no line stays silent.
 *  - Lifts: announced on entering the band (Schmitt-trigger hysteresis, see step()).
 *  - Quiet while the rider is on a lift (chutes under the gondola), except the lift itself.
 *  - Re-armed only after the rider is REARM_M from the band (GPS wander can't repeat it).
 *  - The line is prefetched at PREFETCH_M.
 *
 * Positions are [lat, lon]; corridor.path is [[lat, lon], ...] (the published bundle's
 * layout). No DOM, no audio: the host speaks the returned text.
 */
(function (root) {
  "use strict";

  var TUNING = {
    NARRATE_HYSTERESIS_M: 3, // lift band: entering needs dist < -margin, leaving dist >= margin
    PASS_ANNOUNCE_M: 5,      // chute/run/boot pack: announce within this many m of the band
    REARM_M: 40,             // re-arm beyond this many m from the band (= Ridge Quest REC_HOLD_M)
    PREFETCH_M: 200,         // fetch the audio this far out (first /api/tts took 1762 ms)
    COOLDOWN_MS: 4000        // lift band: no re-entry within this after leaving
  };
  var M_PER_DEG_LAT = 111320;

  function mPerDegLon(lat) { return 111320 * Math.cos(lat * Math.PI / 180); }
  function toXY(p, ref) { return { x: (p[1] - ref[1]) * mPerDegLon(ref[0]), y: (p[0] - ref[0]) * M_PER_DEG_LAT }; }

  // Signed distance to the corridor's band edge (negative inside), same formula as Ridge Quest's
  // QGeo.corridorDist: centreline distance minus half the width (missing width = 10 m).
  function bandDist(pt, corridor) {
    var path = corridor.path || [];
    if (path.length < 2) return Infinity;
    var ref = corridor.ref || path[0];
    var P = toXY(pt, ref), best = Infinity;
    for (var i = 1; i < path.length; i++) {
      var A = toXY(path[i - 1], ref), B = toXY(path[i], ref);
      var vx = B.x - A.x, vy = B.y - A.y, len2 = vx * vx + vy * vy;
      var t = len2 > 0 ? ((P.x - A.x) * vx + (P.y - A.y) * vy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(A.x + t * vx - P.x, A.y + t * vy - P.y));
    }
    return best - (corridor.widthM || 10) / 2;
  }

  // True when pt is inside any chute or run (the gate for passing announcements).
  function insideRun(pt, corridors) {
    for (var i = 0; i < corridors.length; i++) {
      var c = corridors[i];
      if ((c.runType === "chute" || c.runType === "run") && bandDist(pt, c) <= 0) return true;
    }
    return false;
  }

  // The line spoken for a corridor: its authored say, else "This is <name>" for a chute / run /
  // boot pack. null = nothing to say.
  function lineFor(corridor) {
    if (corridor.say && String(corridor.say).trim()) return corridor.say;
    var name = (corridor.name || "").trim();
    return corridor.runType !== "lift" && name ? "This is " + name : null;
  }

  // One fix for one corridor. st = per-corridor state object (kept by the host, starts {}).
  // corridor = { runType, widthM, say, name, path, ref? }. ctx = { inRun, narrOk,
  // onLift, now, canSay, canPrefetch } (inRun: insideRun() for this fix; canSay/canPrefetch:
  // the host has somewhere to send them). Returns { say: text | null, prefetch: [texts] }.
  function step(st, corridor, pt, ctx) {
    var out = { say: null, prefetch: [] };
    var now = ctx.now != null ? ctx.now : Date.now();
    var halfW = (corridor.widthM || 10) / 2;
    var dist = bandDist(pt, corridor);
    var isLift = corridor.runType === "lift";
    var say = lineFor(corridor);
    if (!st.phase) st.phase = "idle";
    if (st.narrCooldownUntil == null) st.narrCooldownUntil = 0;

    if (dist > TUNING.REARM_M) st.narrArmed = true;

    if (ctx.narrOk && say && ctx.canPrefetch && !st.sayPrefetched && dist <= TUNING.PREFETCH_M) {
      st.sayPrefetched = true;
      out.prefetch = [say];
    }

    // Passing / entering a chute, run or boot pack: only while skiing inside a chute or run.
    if (!isLift && ctx.narrOk && say && ctx.canSay && st.narrArmed !== false && !ctx.onLift && ctx.inRun
        && dist <= TUNING.PASS_ANNOUNCE_M) {
      st.narrArmed = false;
      out.say = say;
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

  var api = { TUNING: TUNING, bandDist: bandDist, insideRun: insideRun, lineFor: lineFor, step: step };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.QuestNarration = api;
})(typeof window !== "undefined" ? window : this);
