// Corridor Guard — continuous "you've drifted outside the corridor" alarm.
//
// Watches every corridor in a project and tells the host, once per GPS fix,
// whether the tracked player is currently outside its width band. Evaluates
// EVERY corridor regardless of run_type/activityType (ski/hike/bike/drive
// all treated the same) EXCEPT run_type:"lift" — a chairlift line isn't
// something you meaningfully "drift outside of," and unloading + skiing
// away roughly parallel to the line would otherwise false-alert.
//
// The host is responsible for turning the per-fix onWarn signal into a
// continuous, uninterrupted alarm — this module has no timer/audio of its
// own and GPS fixes can be several seconds apart, so it cannot make the
// alert *feel* continuous by itself; it only tells the host "still outside,
// here's the current level" on every tick while that's true.
//
// Self-contained (its own local-planar geometry, no dependency on a host
// page's Geo/QGeo/nearestOnPath) — same "shared module, callback injection,
// no DOM/Audio/Vibration calls of its own" pattern as kalman-filter.js and
// guidance-bot.js.
//
// "Hard line in space" (2026-09-19, explicit user requirement): whether the
// alarm is on is a pure function of CURRENT position against the corridor's
// edge (half-width plus OUTSIDE_BUFFER_M's small "riding the line on
// purpose" tolerance) — outside means on, inside means off, on every single
// tick, with no history and no heading/speed requirement deciding whether a
// crossing "counts." The first alert fires on the very GPS fix that crosses
// the edge; there is no separate "must be N meters past it" or "must stay
// outside for N seconds/fixes" delay. `engaged` (heading/speed/coverage) is
// still computed and reported via onDebug for diagnostic purposes, but no
// longer gates anything — an earlier version required it before a fresh
// excursion could start, specifically to reject a mere perpendicular
// crossing, but the user explicitly asked for that removed in favor of
// predictability: any geometrically-outside fix counts, every time.
//
// No "approach ping" (removed 2026-09-20, explicit user requirement): a
// corridor the player has never actually been inside NEVER alerts, no matter
// how close or how long it sits within range — `everInside` (true the
// instant near.distM<=halfW, real position only, never via predictNow()'s
// dead reckoning) gates the very first alert. An earlier version alerted at
// a capped level 1 for a "nearby but never entered" corridor as a quiet
// approach warning; a real field test found this fired a full, sustained
// alarm well before the player had ever set foot in the corridor, which read
// as a false alarm rather than a helpful heads-up. Simpler and safer: no
// alert at all until you've genuinely been inside at least once.
//
// Committed-exit detection: while alerting, this module also tracks whether
// the player's distance from the corridor is trending back down (a real
// correction attempt) or growing steadily with no narrowing in between
// (they've decided to go a different way — a skier traversing out of a
// chute to exit onto another run, a biker peeling off onto a branch trail).
// Once the excess distance has grown enough this way — OR the alarm has
// simply been sounding continuously for MAX_ALERT_DURATION_MS (15s) with no
// return inside at all, even at a roughly constant distance — chute-guard.js
// concludes they're not coming back and fires onDisengage once instead of
// continuing to warn, so the alarm doesn't nag someone who has clearly left
// on purpose (or just isn't near a phone/isn't going to correct). It stays
// quiet for the rest of that excursion.
//
// Usage (mirrors GuidanceBot's lifecycle):
//   ChuteGuard.load(zones, {
//     onWarn(corridorId, name, info) {...},       // still outside — info: {level, levelChanged, alertCount, excessM, maxExcessM, msOutside, widthM, t}
//     onClear(corridorId, name) {...},             // back inside the width band
//     onDisengage(corridorId, name, info) {...},   // concluded they left on purpose — info: {level, maxExcessM, excessM, widthM, t}
//     onDebug(corridorId, name, info) {...}        // optional, diagnostic only
//   });
//   // once per GPS fix, after GPSFilter.push()/TravelHeading.update():
//   ChuteGuard.tick({ lat, lon, acc, speed, t }, TravelHeading.heading);
//   ChuteGuard.unload();
//
// `zones` is the bundle's zone array (BUNDLE.zones / simBundle.zones) — each
// zone's corridor geometry is read from its corridor target layer
// (zone.layers[].geometry.type==="corridor"), the same {path,widthM} shape
// Geofencer.sd()'s own corridor branch already reads, in [lat,lon] pairs.
(function(){
  "use strict";

  const TUNING = {
    ENGAGE_COVERAGE_PCT: 0.15,   // fraction of the corridor's own length that must already be tracked to count as "traveling it," not just clipping it
    ENGAGE_COVERAGE_MAX_M: 150,  // ...or this many meters of it, whichever is SMALLER — keeps a long trail/road from requiring kilometers of travel to arm
    ENGAGE_HEADING_TOL_DEG: 55,  // max angle off parallel/anti-parallel to the corridor's local bearing to still count as "along it"
    ENGAGE_MIN_SPEED_MPS: 1.5,   // fallback floor when a corridor has no/unrecognized activityType
    ENGAGE_MIN_SPEED_BY_ACTIVITY: {   // per-activity floor — 1.5 m/s (5.4km/h) is faster than typical hiking pace, so a single fixed floor silently excluded hike/walk corridors
      hike: 0.7, walking_city: 0.7, xcountry: 1.2, bike: 1.5, ski_chute: 1.5, drive: 3.0
    },
    OUTSIDE_BUFFER_M: 0.5,       // small margin past the nominal half-width — float/GPS-geometry noise tolerance right at the line ONLY, not a "wait before alerting/clearing" delay. Shared symmetrically by both the alert-trigger edge and the back-inside/clear edge (see the first-alert comment and backInside below), so this is also how close to the TRUE authored width the alarm has to get before it stops — field feedback (2026-09) was that the previous 2m value cleared the alarm well before the avatar visually re-entered a narrow corridor's drawn line, which read as "not turning off fast enough." Kept nonzero only because an exact 0 boundary can flicker on floating-point noise alone.
    MAX_LEVEL: 2,
    ESCALATE_AFTER_MS: [0, Infinity],  // time never escalates (2026-09-21): a level-2 that appeared exactly 5 s after leaving read as random, since it said nothing about how far out you were. Kept as an array so a host could re-enable a time ladder
    ESCALATE_EXCESS_M: [0, 10],           // level 1 = just past the edge; level 2 = clearly outside (10 m+ past it). Distance only, so the pitch change always means "you're further out"
    COMMIT_STREAK_MS: 4000,      // excess growing continuously (no intervening narrowing) for at least this long...
    COMMIT_GROWTH_M: 15,         // ...or the excess has grown at least this much past its value at the first alert, with no intervening fix narrowing it back...
    MAX_ALERT_DURATION_MS: 15000, // ...or the alarm has simply been sounding this long with no return inside at all (holding at a roughly constant excess, neither growing nor narrowing) -> any of the three conclude "not coming back, stop nagging"

    COMMIT_JITTER_M: 0.5,        // a change in excess smaller than this between fixes counts as neither growth nor a correction (GPS noise floor)
    SAMPLE_STEP_M: 20,           // corridor resampling step for the coverage gate
    NEAR_PAD_M: 10,              // GPS-jitter pad when marking a resampled point "covered"
    MAX_RELEVANT_PAD_M: 60,      // beyond half-width+buffer+this, treat as "not near this corridor at all" rather than "way outside it" — prevents a stale/previously-covered corridor from warning while the player is somewhere else entirely
    ACCURACY_CAP_M: 30,          // ignore fixes worse than this
    LIFT_SUPPRESS_PAD_M: 25,     // real field bug (2026-09-20): a gondola/lift line commonly runs horizontally close to (or over) a chute's centerline, and this module's distance check has no altitude axis at all — nearAnyLift() uses this pad on top of a lift corridor's own half-width to decide "currently riding a lift" and fully suppresses alerting (see tick()'s lift gate). Deliberately generous: a recorded lift line is only an approximation of the cable, cabin GPS has its own slack, and missing a real chute alert near a lift's boarding/unloading area (false negative) is far cheaper than a loud alarm while airborne (the actual bug report).
    STALE_MS: 5000,              // getActiveAlarm() treats state older than this as untrustworthy (no fix has landed recently) and reports "no alarm," regardless of whatever level/committed state a corridor was last left in — see getActiveAlarm()'s own comment
    MAX_CROSSING_JUMP_M: 30,     // sweptOppositeSideCrossing()'s own, tighter bound — a genuine single-tick lateral "skip" over a corridor's width realistically spans tens of meters near its OWN edge, not the full MAX_RELEVANT_PAD_M "still worth alerting" range; keeps a distant, unrelated corridor's infinite line from being coincidentally "crossed" by an unrelated movement 50+ meters away
    DR_MIN_SPEED_MPS: 0.3,       // dead-reckoning floor — below this, heading is noise (a near-stationary fix's travel heading swings wildly) and extrapolating position from it would too; see getActiveAlarm()'s DR comment
    DR_MAX_S: 3.0,               // dead-reckoning ceiling — only bridge the gap between real fixes for this long before falling back to "no prediction, use the last real fix as-is." Doubled from 1.5s (2026-09-20) once DR_CONFIRM_MARGIN_M (below) existed as a safety net — the earlier incident at 3.75s (a stale, no-longer-true velocity reading "coasting" through a narrow corridor and back out the other side with zero real movement, since nothing was correcting it) was a real bug, but the fix that actually closed it was the confirmation margin, not the ceiling itself; a longer ceiling still increases how far a stale coast CAN travel before that margin catches it, so if a future log shows the same phantom-drift shape again, shrink this first before touching the margin. STALE_MS (5000ms) remains the ultimate backstop if fixes stop arriving altogether
    // ---- Responsive (fused) path — only when the host supplies fix.velE/fix.velN ----
    // 2026-09-21 field report: "2s is not acceptable." Measured (250 randomised
    // step-outs, real kalman-filter.js): feeding the guard the EKF-smoothed
    // position put the alarm ON a median 1.2-1.75 s (p90 2-2.75 s) after a real
    // exit and OFF a median 2.1-2.7 s (p90 3.5-4.6 s) after a real re-entry --
    // the EKF's smoothing lag stacked on the 1 Hz fix cadence, and the old DR
    // only ran at >=0.3 m/s with a heading and needed a further 1 m margin.
    // The fused path instead takes the RAW fix plus the phone's own Doppler
    // velocity (low-noise, no smoothing lag): a complementary filter advances
    // the last estimate with that velocity and corrects toward each new fix,
    // then the alarm is decided on the position extrapolated to "now + lead".
    // Measured: ON median ~0 s (p90 ~0.8-1 s), OFF median 0-0.5 s (p90 ~1.2-1.9 s).
    // What's left is the 1 Hz GPS itself -- the floor no software removes.
    RESP_FUSE_K: 0.5,            // gain toward each new raw fix (1 = trust the fix outright, 0 = trust only velocity dead-reckoning)
    RESP_FIX_LATENCY_S: 0.3,     // a fix describes where the player WAS this long ago; the correction compares against the estimate at that earlier time
    RESP_LEAD_S: 0.4,            // look-ahead = known pipeline delay (~0.3 s fix age + ~0.1 s audio start), not a tuned number: alarm at where the player is when the sound actually arrives
    RESP_MAX_GAP_S: 5,           // a longer gap between fixes restarts the fused estimate from the raw fix
    RESP_MARGIN_M: 0.0,          // the predicted position IS the decision (no extra margin either way) -- DR_CONFIRM_MARGIN_M below exists for the slower, less trustworthy velocity of the non-fused path
    // ---- Offset cancelling (responsive path only) ----
    // Cars keep a lane by MEASURING it (camera) rather than trusting an
    // absolute position; GPS-only lane-level work calibrates the sensor's
    // offset against the map while the vehicle is known to be on the road.
    // Same idea here: while the rider is moving and clearly on the corridor,
    // learn the slowly-drifting lateral offset between where GPS says they are
    // and the authored centreline (GPS bias + the recorded line's own error,
    // both slowly varying / constant) and subtract it, so only a DEPARTURE
    // relative to that baseline alarms. Simulated 4 m bike path: false alarms
    // 4.1/min -> 1.1/min at good-sky GPS, 2.2 -> 0.1/min on dual-frequency GPS
    // (no help at poor 3 m GPS). KNOWN LIMIT: a very slow drift outward over
    // ~30 s+ is absorbed (bounded by BIAS_MAX_M) -- fine for "left the path",
    // not for "gradually wandered off".
    BIAS_TAU_S: 30,              // learning time constant
    BIAS_MAX_M: 3,               // the correction can never exceed this, so a genuine departure beyond it still alarms
    BIAS_GATE_M: 1.0,            // learn only while within (edge + this) of the baseline -- never while actually outside
    BIAS_MIN_SPEED_MPS: 0.5,     // learn only while moving along the corridor, not while standing at its edge
    DR_CONFIRM_MARGIN_M: 1.0     // a dead-reckoned excess has to clear the edge by at least this much (in whichever direction) before it's trusted enough to override the real state's on/off decision — a prediction that only barely grazes zero is exactly the noisy, low-confidence case a stale/coasting velocity produces, and shouldn't be allowed to flip the tone on its own
  };

  const EARTH_R = 6371000;
  const M_PER_DEG_LAT = 111320;
  function mPerDegLon(lat){ return M_PER_DEG_LAT * Math.cos(lat*Math.PI/180); }
  function toXY(p, ref){ return { x:(p[1]-ref[1])*mPerDegLon(ref[0]), y:(p[0]-ref[0])*M_PER_DEG_LAT }; }
  function haversineM(a,b){
    const p1=a[0]*Math.PI/180, p2=b[0]*Math.PI/180, dp=(b[0]-a[0])*Math.PI/180, dl=(b[1]-a[1])*Math.PI/180;
    const x=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    return 2*EARTH_R*Math.asin(Math.sqrt(x));
  }
  function bearing(a,b){
    const y=Math.sin((b[1]-a[1])*Math.PI/180)*Math.cos(b[0]*Math.PI/180);
    const x=Math.cos(a[0]*Math.PI/180)*Math.sin(b[0]*Math.PI/180)-
            Math.sin(a[0]*Math.PI/180)*Math.cos(b[0]*Math.PI/180)*Math.cos((b[1]-a[1])*Math.PI/180);
    return (Math.atan2(y,x)*180/Math.PI+360)%360;
  }
  // 0..90 — distance to the nearest of {same direction, opposite direction}.
  // 0 = travelling parallel or anti-parallel to the corridor; 90 = perpendicular.
  function parallelness(headingDeg, segBearingDeg){
    const raw=Math.abs(((headingDeg-segBearingDeg+540)%360)-180); // 0..180
    return Math.min(raw, 180-raw);
  }
  // Nearest point on a [lat,lon] polyline, in local-planar XY relative to
  // path[0]. Returns the winning segment's index so the caller can read that
  // segment's own bearing. A self-contained copy (not a call into whichever
  // host happens to have its own nearestOnPath()) — this module has no
  // dependency on which page loads it.
  function nearestOnPath(latLon, pathLatLon, ref){
    const P=toXY(latLon, ref);
    let bestD=Infinity, bestI=0;
    for(let i=1;i<pathLatLon.length;i++){
      const A=toXY(pathLatLon[i-1],ref), B=toXY(pathLatLon[i],ref);
      const vx=B.x-A.x, vy=B.y-A.y, wx=P.x-A.x, wy=P.y-A.y;
      const c2=vx*vx+vy*vy;
      let t = c2>0 ? (vx*wx+vy*wy)/c2 : 0;
      t=Math.max(0,Math.min(1,t));
      const qx=A.x+t*vx, qy=A.y+t*vy;
      const d=Math.hypot(P.x-qx, P.y-qy);
      if(d<bestD){ bestD=d; bestI=i-1; }
    }
    return { distM:bestD, segIdx:bestI };
  }
  // Signed perpendicular distance from P to the INFINITE line through A,B —
  // sign indicates which side of the line P is on, magnitude is the true
  // perpendicular distance. Used only by sweptOppositeSideCrossing() below;
  // nearestOnPath()'s own segment-clamped, unsigned distance is unaffected
  // and still what drives the actual excess/level/escalation math.
  function signedDistToLineXY(P, A, B){
    const vx=B.x-A.x, vy=B.y-A.y;
    const len=Math.hypot(vx,vy);
    if(len===0) return 0;
    return (vx*(P.y-A.y) - vy*(P.x-A.x)) / len;
  }
  // Signed lateral offset of latLon from the corridor centreline (m, sign =
  // side of the nearest segment's line), or null when the nearest point is a
  // segment END rather than a perpendicular foot (past the corridor's end,
  // where "lateral" isn't meaningful).
  function lateralOffsetM(c, latLon, near){
    const ref=c.path[0];
    const A=toXY(c.path[near.segIdx], ref), B=toXY(c.path[Math.min(near.segIdx+1, c.path.length-1)], ref);
    const s=signedDistToLineXY(toXY(latLon, ref), A, B);
    return Math.abs(s) >= near.distM - 0.05 ? s : null;
  }
  // Responsive path only: learn/apply the corridor's lateral offset (see
  // TUNING.BIAS_*) and rewrite near.distM as the distance from the CORRECTED
  // centreline. Everything downstream (excess, everInside, levels, debug)
  // then works off the corrected distance unchanged.
  function applyBias(c, latLon, near, fix, everInside, edgeM){
    const s=lateralOffsetM(c, latLon, near);
    near.biasM=0;
    if(s==null) return;
    const tw=Date.now();
    let b=biasByCorridor.get(c.id);
    if(!b){ b={v:0, tWall:tw}; biasByCorridor.set(c.id, b); }
    const dt=Math.max(0, Math.min(5, (tw-b.tWall)/1000)); b.tWall=tw;
    if(everInside && fix.speed!=null && fix.speed>=TUNING.BIAS_MIN_SPEED_MPS && Math.abs(s-b.v) < edgeM+TUNING.BIAS_GATE_M){
      b.v += Math.min(1, dt/TUNING.BIAS_TAU_S)*(s-b.v);
      b.v = Math.max(-TUNING.BIAS_MAX_M, Math.min(TUNING.BIAS_MAX_M, b.v));
    }
    near.biasM=b.v;
    near.distM=Math.abs(s-b.v);
  }
  // "Hard line in space" (2026-09-19, second real gap found under the same
  // requirement): checking only the CURRENT fix's distance to the corridor
  // means two consecutive fixes far enough apart (a fast rider, sparse GPS,
  // or Test Mode's own random jitter) can straddle a narrow corridor
  // entirely — one fix reads "6m right of center," the next reads "6m left
  // of center," and NEITHER ever lands inside the width band, even though
  // the true continuous path between them plainly crossed it. Confirmed via
  // a real field report: "if I exit right and reenter, the tone stays on
  // until I exit left" — exactly this skip, since near.distM is unsigned
  // and the excursion never saw a tick with excessM<=0 while crossing.
  //
  // A first attempt used the UNSIGNED minimum distance between the swept
  // (previous-fix -> current-fix) segment and the corridor, but that breaks
  // the single most common tick of all: "was inside, just stepped outside."
  // That segment necessarily starts ON/near the corridor (its previous
  // endpoint), so its unsigned swept distance is always ~0 too — genuinely
  // indistinguishable from a real opposite-side crossing using distance
  // alone. The correct signal is SIGN, not distance: did the straight path
  // go from clearly outside on one side to clearly outside on the other
  // side (both perpendicular offsets bigger than the edge, with opposite
  // signs)? A normal single-sided crossing never satisfies this, because
  // its "previous" endpoint sits inside the edge, not clearly outside it.
  // Evaluated against the CURRENT point's own nearest segment (near.segIdx)
  // — correct for the narrow/local jump this guards against; a corridor
  // curved enough for the previous fix to truly belong to a different
  // segment is beyond what this check needs to handle.
  //
  // Real bug found 2026-09-19 (field report: "I hear two tones, a low and
  // higher pitch, at times" — a DIFFERENT, distant, unrelated corridor's
  // tone briefly competing with the intended one): signedDistToLineXY
  // measures against the segment's INFINITE line, with no bound on how far
  // from the segment itself that's still meaningful. A corridor 30-60m away
  // that the player never came anywhere near could still have its nearest
  // segment's infinite line happen to cross the player's actual, unrelated
  // walking path — falsely satisfying "opposite sides" purely by
  // coincidental line geometry, un-committing that distant corridor and
  // letting it re-fire a fresh (often high-level, since maxExcessM is huge)
  // alert that briefly stole the alarm slot at a different pitch. Bounded by
  // TUNING.MAX_CROSSING_JUMP_M rather than the full maxRelevantM pad — a
  // real single-tick "skip" over a corridor's own width realistically spans
  // tens of meters, not the much larger "still worth alerting" range, and a
  // corridor sitting continuously 30-65m away (well within maxRelevantM)
  // needs the tighter bound to actually be excluded here.
  function sweptOppositeSideCrossing(prevLatLon, latLon, segA, segB, ref, edgeM){
    if(!prevLatLon) return false;
    const A=toXY(segA, ref), B=toXY(segB, ref);
    const sCur = signedDistToLineXY(toXY(latLon, ref), A, B);
    const sPrev = signedDistToLineXY(toXY(prevLatLon, ref), A, B);
    const bound = edgeM + TUNING.MAX_CROSSING_JUMP_M;
    return Math.abs(sCur) > edgeM && Math.abs(sPrev) > edgeM &&
      Math.abs(sCur) <= bound && Math.abs(sPrev) <= bound &&
      (sCur>0) !== (sPrev>0);
  }
  // Resample a polyline every stepM (same technique as ridge-quest.html's
  // QGeo.resamplePath) — used once at load() to build each corridor's
  // coverage-sample points.
  function resample(path, stepM){
    const out=[path[0]];
    let carry=0;
    for(let i=1;i<path.length;i++){
      const segLen=haversineM(path[i-1],path[i]);
      let done=0;
      while(segLen-done+carry >= stepM){
        const t=(done+(stepM-carry))/segLen;
        out.push([ path[i-1][0]+(path[i][0]-path[i-1][0])*t, path[i-1][1]+(path[i][1]-path[i-1][1])*t ]);
        done+=stepM-carry; carry=0;
      }
      carry+=segLen-done;
    }
    return out;
  }

  let corridors=[];             // [{id,name,sig,path,widthM,activityType,runType,minSpeed,samples,covered:Set<int>}]
  let liftCorridors=[];         // [{id,path,widthM}] — runType:"lift" zones, kept separately (not alertable themselves, see load()) purely so nearAnyLift() can suppress OTHER corridors' alerts while a lift line is being ridden
  let stateByCorridor=new Map();
  let cb={};
  let lastTickAtWall=0;         // real Date.now() at the last tick() call — see getActiveAlarm()
  let prevFixLatLon=null;       // [lat,lon] of the last ACCEPTED fix — see nearestOnPathSwept()
  let biasByCorridor=new Map(); // corridorId -> {v: learned lateral offset (m, signed), tWall} — see applyBias()
  let fused=null;               // {lat,lon,velE,velN,tWall} — responsive-path estimate, see fuseFix()
  let lastRealFix=null;         // {lat,lon,speed,headingDeg,tWall} from the last real tick() — see predictNow()/getActiveAlarm()
  let currentlyOnLift=false;    // cached nearAnyLift() result from the most recent tick() — see isOnLift()

  // Dead reckoning between real fixes (2026-09-19): a real phone's GPS fix
  // arrives roughly once a second (sometimes much less often), so even a
  // perfectly-instant state machine can only react on whichever fix happens
  // to land after the player actually crossed the line — up to a full fix
  // interval of pure sensor latency, unrelated to anything in this module's
  // own logic (confirmed clean in every Test Mode log this bug chain
  // produced). Real automotive lane-keeping systems bridge exactly this gap
  // by extrapolating position from the last known velocity vector between
  // sensor samples, then correcting the instant a new sample lands —
  // predictNow() is that same technique, kept deliberately narrow: it only
  // ever answers "where is the player probably RIGHT NOW," never mutates any
  // of tick()'s own persistent state (level/committed/growth-streak/etc.),
  // so a wrong guess can't corrupt anything — the very next real tick() call
  // re-derives the correct state from scratch regardless of what prediction
  // said in between.
  function destPointLocal(lat, lon, distM, bearingDeg){
    const brg = bearingDeg*Math.PI/180;
    const dy = Math.cos(brg)*distM, dx = Math.sin(brg)*distM;
    return [ lat + dy/M_PER_DEG_LAT, lon + dx/mPerDegLon(lat) ];
  }
  // Complementary filter for the responsive path (see TUNING.RESP_*). Advances
  // the previous estimate with the previous Doppler velocity, then corrects
  // toward the new raw fix by RESP_FUSE_K -- comparing against where the
  // estimate was RESP_FIX_LATENCY_S ago, since that's the instant the fix
  // describes. Returns the new estimate as of this tick.
  function fuseFix(fix){
    const tw = Date.now();
    let lat = fix.lat, lon = fix.lon;
    if(fused){
      const dt = (tw - fused.tWall)/1000;
      if(dt>0 && dt<=TUNING.RESP_MAX_GAP_S){
        const pLat = fused.lat + fused.velN*dt/M_PER_DEG_LAT;
        const pLon = fused.lon + fused.velE*dt/mPerDegLon(fused.lat);
        const oLat = pLat - fix.velN*TUNING.RESP_FIX_LATENCY_S/M_PER_DEG_LAT;
        const oLon = pLon - fix.velE*TUNING.RESP_FIX_LATENCY_S/mPerDegLon(pLat);
        lat = pLat + TUNING.RESP_FUSE_K*(fix.lat - oLat);
        lon = pLon + TUNING.RESP_FUSE_K*(fix.lon - oLon);
      }
    }
    fused = { lat, lon, velE:fix.velE, velN:fix.velN, tWall:tw };
    return [lat, lon];
  }
  function predictNow(){
    if(lastRealFix && lastRealFix.responsive){
      const elapsedS = (Date.now()-lastRealFix.tWall)/1000;
      if(elapsedS<0 || elapsedS>TUNING.DR_MAX_S) return null;
      const sp = Math.hypot(lastRealFix.velE, lastRealFix.velN);
      if(sp < TUNING.DR_MIN_SPEED_MPS) return [lastRealFix.lat, lastRealFix.lon]; // effectively stationary: velocity is noise, but the fused position itself is still the best answer
      const ahead = elapsedS + TUNING.RESP_LEAD_S;
      return [ lastRealFix.lat + lastRealFix.velN*ahead/M_PER_DEG_LAT, lastRealFix.lon + lastRealFix.velE*ahead/mPerDegLon(lastRealFix.lat) ];
    }
    if(!lastRealFix || lastRealFix.speed==null || lastRealFix.headingDeg==null) return null;
    if(lastRealFix.speed < TUNING.DR_MIN_SPEED_MPS) return null; // near-stationary — heading is noise, nothing meaningful to extrapolate
    const elapsedS = (Date.now()-lastRealFix.tWall)/1000;
    if(elapsedS<=0 || elapsedS>TUNING.DR_MAX_S) return null;     // no time to bridge, or too stale to trust — use the last real fix as-is
    return destPointLocal(lastRealFix.lat, lastRealFix.lon, lastRealFix.speed*elapsedS, lastRealFix.headingDeg);
  }

  function freshState(){
    return {
      level:0, firstAlertAt:null, excessAtFirstAlert:0,
      maxExcessM:0, prevExcessM:null, growthStreakStartAt:null, committed:false,
      alertCount:0, lastDebugAt:0, lastEmittedLevel:0, everInside:false, lastOutsideNow:null
    };
  }

  function load(zones, callbacks){
    cb = callbacks || {};
    const prevById = new Map(corridors.map(c=>[c.id, c]));
    const prevStateBy = stateByCorridor;

    corridors = (zones||[]).map(z=>{
      if(z.runType==="lift") return null; // not a travel corridor you can drift outside of
      const target = (z.layers||[]).find(l=>l.geometry && l.geometry.type==="corridor");
      const path = target && target.geometry.path;
      if(!path || path.length<2) return null;
      const w = Number(target.geometry.widthM);
      const widthM = (isFinite(w) && w>0) ? w : 10;
      const sig = z.id+":"+path.length+":"+widthM;
      const prev = prevById.get(z.id);
      const reuse = prev && prev.sig===sig;
      return {
        id: z.id, name: z.name || "corridor", sig, path, widthM,
        activityType: z.activityType || null,
        runType: z.runType || null,
        samples: reuse ? prev.samples : resample(path, TUNING.SAMPLE_STEP_M),
        covered: reuse ? prev.covered : new Set(),
        minSpeed: TUNING.ENGAGE_MIN_SPEED_BY_ACTIVITY[z.activityType] ?? TUNING.ENGAGE_MIN_SPEED_MPS
      };
    }).filter(Boolean);

    // Lift lines aren't alertable (see the runType==="lift" skip above), but
    // their own geometry is exactly what nearAnyLift() needs to tell "rider
    // is on the gondola" from "rider is near a chute" — same {path,widthM}
    // extraction, just keyed the opposite way.
    liftCorridors = (zones||[]).map(z=>{
      if(z.runType!=="lift") return null;
      const target = (z.layers||[]).find(l=>l.geometry && l.geometry.type==="corridor");
      const path = target && target.geometry.path;
      if(!path || path.length<2) return null;
      const w = Number(target.geometry.widthM);
      const widthM = (isFinite(w) && w>0) ? w : 10;
      return { id:z.id, path, widthM };
    }).filter(Boolean);

    // Reuse a corridor's live excursion state across a reload of the SAME
    // corridor (ridge-quest.html calls load() on every Home render) — the
    // old code wiped `covered`/state unconditionally, which was harmless
    // when state was just coverage tracking but would silently kill a live
    // alarm/escalation now that state carries alert level and timing.
    stateByCorridor = new Map(corridors.map(c=>{
      const prev = prevStateBy.get(c.id);
      const prevZone = prevById.get(c.id);
      const keep = prev && prevZone && prevZone.sig===c.sig;
      return [c.id, keep ? prev : freshState()];
    }));
  }

  function unload(){ corridors=[]; liftCorridors=[]; stateByCorridor=new Map(); cb={}; lastTickAtWall=0; prevFixLatLon=null; lastRealFix=null; fused=null; biasByCorridor=new Map(); currentlyOnLift=false; }

  // Whether the most recent tick() found the fix on/near a recorded lift
  // corridor — see nearAnyLift() and tick()'s own lift gate. Exposed so a
  // host (Ridge Quest's "My map") can build a battery-saver "lift mode" off
  // the same single geometry check, rather than a second copy of it.
  function isOnLift(){ return currentlyOnLift; }

  // True if latLon is currently within suppression range of ANY recorded
  // lift corridor — see LIFT_SUPPRESS_PAD_M's comment and tick()'s lift gate.
  function nearAnyLift(latLon){
    for(const lc of liftCorridors){
      const near = nearestOnPath(latLon, lc.path, lc.path[0]);
      if(near.distM <= lc.widthM/2 + TUNING.LIFT_SUPPRESS_PAD_M) return true;
    }
    return false;
  }

  function emitWarn(c, st, now, excessM){
    st.alertCount++;
    const levelChanged = st.alertCount===1 || st.lastEmittedLevel!==st.level;
    st.lastEmittedLevel = st.level;
    if(cb.onWarn) cb.onWarn(c.id, c.name, {
      level: st.level, levelChanged, alertCount: st.alertCount,
      excessM, maxExcessM: st.maxExcessM,
      msOutside: st.firstAlertAt!=null ? now-st.firstAlertAt : 0,
      widthM: c.widthM, t: now
    });
  }

  // fix: {lat,lon,acc,speed,t}. headingDeg: smoothed travel heading in
  // degrees, or null (sticky-null before the visitor has moved at all —
  // treated as "not engaged," same "no data = don't act" convention as
  // TravelHeading's other consumers).
  function tick(fix, headingDeg){
    if(fix==null || (fix.acc!=null && fix.acc>TUNING.ACCURACY_CAP_M)) return;
    // Responsive path: only when the host passes the phone's own velocity
    // (fix.velE/fix.velN, m/s) alongside a RAW position. Otherwise the fix is
    // used exactly as given -- every other host is unchanged.
    const responsive = fix.velE!=null && fix.velN!=null && isFinite(fix.velE) && isFinite(fix.velN);
    const latLon = responsive ? fuseFix(fix) : [fix.lat, fix.lon];
    if(!responsive) fused = null;
    // Cached ahead of the corridors.length check below so isOnLift() works
    // even for a project with zero *alertable* corridors (e.g. a summer
    // sightseeing gondola with no ski chutes authored) — lift detection
    // shouldn't depend on there being anything else for this module to
    // guard. See isOnLift()'s own comment for why a host reads this instead
    // of re-deriving it from Quest.corridors' own lift entries.
    currentlyOnLift = nearAnyLift(latLon);
    if(!corridors.length) return;
    lastTickAtWall = Date.now(); // real wall clock, independent of fix.t — see getActiveAlarm()
    lastRealFix = { lat:latLon[0], lon:latLon[1], speed:fix.speed, headingDeg, tWall:lastTickAtWall, responsive, velE:responsive?fix.velE:null, velN:responsive?fix.velN:null }; // see predictNow()
    const now = fix.t || Date.now();
    const prevLatLon = prevFixLatLon; // captured before this tick updates it, below
    prevFixLatLon = latLon;

    // Real field bug (2026-09-20): a gondola/lift line commonly runs
    // horizontally close to (or over) a chute's centerline, and every check
    // below is 2D-only — it has no altitude axis to tell "close on the map"
    // from "close on the map AND on the ground." Rather than add one (new
    // plumbing through GPSFilter/the EKF, and phone GPS altitude is usually
    // noisier than horizontal), reuse the lift corridor's own recorded line:
    // if the current fix is on a known lift, this module has nothing
    // meaningful to say about any OTHER corridor right now — clear whatever
    // was already sounding and skip evaluation entirely for this tick, same
    // as if no corridors were relevant at all.
    if(currentlyOnLift){
      for(const c of corridors){
        const st = stateByCorridor.get(c.id);
        if(st.level>0){
          if(cb.onClear) cb.onClear(c.id, c.name);
          const everInside = st.everInside; // not "gone out of relevant range" — just airborne; don't make them re-earn entry once they're back on the ground
          Object.assign(st, freshState());
          st.everInside = everInside;
        }
      }
      return;
    }

    for(const c of corridors){
      const ref=c.path[0];
      const near=nearestOnPath(latLon, c.path, ref); // current true distance — unaffected by the crossing check below
      const halfW=c.widthM/2;
      const st=stateByCorridor.get(c.id);
      if(responsive) applyBias(c, latLon, near, fix, st.everInside, halfW+TUNING.OUTSIDE_BUFFER_M);

      // Coverage — mark any resampled point currently within the band as
      // "tracked," same idea as QGeo.corridorCoverage but incremental.
      for(let i=0;i<c.samples.length;i++){
        if(c.covered.has(i)) continue;
        if(haversineM(latLon, c.samples[i]) <= halfW+TUNING.NEAR_PAD_M) c.covered.add(i);
      }
      const coverage = c.samples.length ? c.covered.size/c.samples.length : 0;
      const coveredM  = c.covered.size * TUNING.SAMPLE_STEP_M;
      const lengthM   = c.samples.length * TUNING.SAMPLE_STEP_M;
      const needM     = Math.min(TUNING.ENGAGE_COVERAGE_PCT*lengthM, TUNING.ENGAGE_COVERAGE_MAX_M);
      const covered   = coveredM >= needM;

      // Engaged? all three gates — this is what rejects a mere traverse.
      let engaged=false;
      if(covered && headingDeg!=null && fix.speed!=null && fix.speed>=c.minSpeed){
        const A=c.path[near.segIdx], B=c.path[Math.min(near.segIdx+1, c.path.length-1)];
        engaged = parallelness(headingDeg, bearing(A,B)) <= TUNING.ENGAGE_HEADING_TOL_DEG;
      }

      const edgeM        = halfW + TUNING.OUTSIDE_BUFFER_M;
      const excessM       = near.distM - edgeM;                // >0 == outside
      const maxRelevantM = edgeM + TUNING.MAX_RELEVANT_PAD_M;
      // See sweptOppositeSideCrossing()'s own comment — catches a fast
      // lateral movement that skips clean over a narrow corridor's inside
      // zone between two consecutive fixes (both fixes still read
      // "outside," just on opposite sides), which the point-only distance
      // above can't see on its own.
      const crossedOppositeSide = sweptOppositeSideCrossing(
        prevLatLon, latLon, c.path[near.segIdx], c.path[Math.min(near.segIdx+1, c.path.length-1)], ref, edgeM
      );

      // Field bug found 2026-09: the guard fired while a player was still
      // APPROACHING a corridor, before ever having entered it this time —
      // `covered` (which the `engaged` gate above needs) persists across
      // the whole page session, not just the current approach, so a second
      // lap of a corridor already partly walked earlier could satisfy
      // engage/coverage/heading/speed while still outside on the way IN,
      // firing a "you left" alert before ever having "been in." Fixed with
      // an explicit "have you actually been inside (no buffer) at least
      // once this approach" latch — true the instant near.distM<=halfW,
      // and only cleared when the player leaves relevant range entirely
      // (a genuine "gone away," not just "currently between the true edge
      // and the buffer/relevant-range boundary").
      if(near.distM <= halfW) st.everInside = true; // gates whether an alert can ever start at all — see the "no approach ping" doc comment at the top of the file
      // "Hard line in space" requirement, 2026-09-19: the user explicitly
      // asked for the corridor's edge to be a pure function of CURRENT
      // position — outside the width+buffer means the alarm is on, inside
      // means it's off, full stop, no history and no heading/speed
      // requirement deciding whether that's "trustworthy enough." `engaged`
      // used to also have to be satisfied before a FRESH excursion could
      // start (to avoid false-alarming on a mere perpendicular crossing) —
      // removed from this decision entirely per that explicit request; it's
      // computed above only so onDebug's existing log format keeps showing
      // it for diagnostic purposes. `everInside` DOES still gate the alert
      // (see the "no approach ping" doc comment at the top of the file) —
      // that's the one requirement the user asked to reinstate after a real
      // field test found the un-gated approach case produced a real false
      // alarm well before the corridor was ever entered.
      // The one exception the user explicitly chose to KEEP from the
      // original "hard line" change: the committed-exit detector further
      // down can still silence an active, still-outside excursion once it
      // concludes the departure is deliberate — otherwise skiing/riding away
      // on purpose would alarm forever with no way to stop it short of
      // returning.
      const outsideNow = excessM > 0 && near.distM <= maxRelevantM && !crossedOppositeSide;

      // Debug hook — Test Mode wires this into its log panel so an author
      // can see exactly which gate is blocking a warning (coverage/heading/
      // speed/distance) instead of a silent "nothing happened." Throttled
      // per-corridor so a held drag doesn't flood the log — EXCEPT on the
      // exact tick outsideNow flips (a genuine exit or entry), which always
      // gets logged regardless of the throttle. Added 2026-09-19: the
      // throttle could otherwise skip the precise crossing tick, so a user
      // comparing "how far past the edge did it turn on" vs. "how far past
      // the edge did it turn off" from an exported log could see two
      // different-looking numbers even though both directions use the
      // exact same edgeM threshold internally — this makes that threshold
      // directly verifiable from the log itself, not just from reading the
      // source. Not wired by the production engine/sim — diagnostic only.
      //
      // Routine (non-crossing) emission is further gated to corridors
      // actually within maxRelevantM (2026-09-20, real perf report: a
      // project with dozens of corridors — e.g. Kicking Horse's ~60 named
      // runs — made every tick log ALL of them every 500ms regardless of
      // how far away the player actually was, since this throttle alone
      // doesn't care about relevance. Because every corridor's lastDebugAt
      // starts at the same value, those bursts land in the SAME tick across
      // every corridor, and each one does a real DOM append (simLogEv's
      // createElement+prepend+toLocaleTimeString in fence-editor.html) —
      // measured at ~15-20ms for a ~50-corridor burst, enough on its own to
      // blow a 60fps frame budget and read as "very very slow." A corridor
      // hundreds of meters away can never be mid-crossing (outsideNow
      // itself already requires near.distM<=maxRelevantM), so restricting
      // the throttled branch to in-range corridors only drops routine
      // volume to whichever handful the player is actually near, with zero
      // effect on which crossings get logged or on the real alarm state
      // machine (onWarn/onClear/onDisengage/getActiveAlarm untouched).
      const outsideNowChanged = st.lastOutsideNow!=null && st.lastOutsideNow!==outsideNow;
      if(cb.onDebug && (outsideNowChanged || (near.distM<=maxRelevantM && now-(st.lastDebugAt||0)>=500))){
        st.lastDebugAt=now;
        cb.onDebug(c.id, c.name, { coverage, engaged, distM:near.distM, halfW,
          bufferM:TUNING.OUTSIDE_BUFFER_M, maxRelevantM, everInside:st.everInside,
          headingDeg, speed:fix.speed, excessM, level:st.level, committed:st.committed,
          lat:latLon[0], lon:latLon[1], responsive, biasM:near.biasM||0, crossing:outsideNowChanged }); // raw position + a "crossing" flag marking the exact tick outsideNow flipped
      }
      st.lastOutsideNow = outsideNow;

      if(!outsideNow){
        // Only a genuine return inside the width band (not just "no longer
        // engaged" while still geometrically outside, e.g. stopped moving,
        // or still approaching pre-entry) counts as "back on track" — a
        // committed-exit that later wanders out of relevant range entirely
        // resets silently, same as before.
        const wasActive = st.level>0;
        const backInside = excessM<=0 || crossedOppositeSide;
        const outOfRelevantRange = near.distM > maxRelevantM;
        const everInside = st.everInside;
        // Field bug found 2026-09-19 (real Test Mode report: "tone never
        // turned off, had to exit Test Mode to kill it" — the excursion had
        // walked straight past a corridor's END, well beyond maxRelevantM):
        // wandering out of relevant range while STILL actively alerting but
        // not yet committed hit this exact reset with neither onClear (they
        // never came back inside) nor onDisengage (only fired by the
        // separate commit-detection branch below, which this code path
        // bypasses entirely) — the host's already-started alarm was
        // orphaned with no stop signal at all, and since the corridor id
        // stays "the one playing" on the host side, a later re-approach
        // just updates the stale alarm in place instead of restarting it,
        // so it plays uninterrupted indefinitely. Capture pre-reset level/
        // maxExcessM so a genuinely-still-active excursion always gets a
        // stop signal one way or another before its state is wiped.
        const wasCommitted = st.committed;
        if(outOfRelevantRange) biasByCorridor.delete(c.id); // gone away: the learned offset described THAT pass, start fresh next approach
        const levelAtReset = st.level;
        const maxExcessAtReset = st.maxExcessM;
        Object.assign(st, freshState());
        // A genuine "gone away" (out of relevant range) is the only case
        // that should require re-earning entry on the next approach —
        // everything else (still inside/buffered, or still approaching
        // pre-entry within relevant range) keeps whatever entry status it
        // already had.
        if(!outOfRelevantRange){
          st.everInside = everInside;
          // Also preserve lastOutsideNow (same reasoning) — without this,
          // it gets wiped to null on EVERY tick while genuinely inside
          // (this branch runs every such tick), so by the time the player
          // exits again, outsideNowChanged above would always read false
          // for that tick — the crossing marker would only ever catch the
          // entry transition, never the exit one.
          st.lastOutsideNow = outsideNow;
        }
        if(wasActive && backInside && cb.onClear){
          cb.onClear(c.id, c.name);
        }else if(wasActive && outOfRelevantRange && !wasCommitted && cb.onDisengage){
          cb.onDisengage(c.id, c.name, {level:levelAtReset, maxExcessM:maxExcessAtReset, excessM, widthM:c.widthM, t:now});
        }
        continue;
      }

      if(st.committed){
        // Already concluded this excursion is a deliberate departure — stay
        // silent until they either come back inside (handled above) or
        // drift out of relevant range (also handled above).
        st.prevExcessM = excessM;
        continue;
      }

      if(excessM > st.maxExcessM) st.maxExcessM = excessM;

      if(!st.everInside){
        // No approach ping (2026-09-20) — a corridor the player has never
        // once actually been inside never alerts, full stop. See the "no
        // approach ping" doc comment at the top of the file. maxExcessM
        // above is still tracked so onDebug stays informative, but nothing
        // here ever escalates or emits — this state resets to fresh the
        // instant the player leaves relevant range (see the !outsideNow
        // branch above), and once they genuinely enter, everInside flips
        // true and the normal alert flow below applies from then on.
        st.prevExcessM = excessM;
        continue;
      }

      if(st.level===0){
        // Fires on the very fix that crosses the edge — no extra distance or
        // accuracy-scaled delay stacked on top of OUTSIDE_BUFFER_M's small
        // tolerance. `excessM > 0` against `near.distM` IS the edge check, a
        // genuine perpendicular-distance-past-the-boundary crossing — a pure
        // function of current position (see the "hard line" comment above),
        // not a time/distance-accumulated guess at one.
        st.firstAlertAt = now;
        st.excessAtFirstAlert = excessM;
        st.prevExcessM = excessM;
        // The escalation ladder applies from the very first alert too — a
        // single large excursion (e.g. 30m past the edge) starts at level 3
        // immediately, rather than easing in through 1->2->3 over the next
        // 12s the way a gradual drift would. Only reachable at all once
        // everInside is true (see the guard above), so there's no longer a
        // "capped at level 1" case to special-case here.
        st.level = ladderLevel(0, st.maxExcessM);
        emitWarn(c, st, now, excessM);
        continue;
      }

      // Already alerting — track the excess-distance trend for the
      // committed-exit detector before anything else. Time-based (how LONG
      // it's been growing), not fix-count-based — a fix-count threshold is
      // silently tick-rate-dependent: Test Mode's simulated walk can fire
      // several fixes per real second, so a "4 consecutive fixes" rule
      // would commit in under a second there but take ~4 real seconds on
      // an actual phone at ~1Hz GPS, making the simulator behave nothing
      // like a real device for this exact mechanism (found via a real
      // Test Mode log: growth-streak commits fired within ~1s of real time
      // during sim playback). Using elapsed wall-clock time since growth
      // started makes this consistent regardless of fix cadence.
      if(st.prevExcessM!=null){
        if(excessM > st.prevExcessM + TUNING.COMMIT_JITTER_M){
          if(st.growthStreakStartAt==null) st.growthStreakStartAt = now;
        }else if(excessM < st.prevExcessM - TUNING.COMMIT_JITTER_M){
          st.growthStreakStartAt = null;
        }
        // a roughly-flat change neither starts nor resets the streak
      }
      st.prevExcessM = excessM;

      const grownEnough = (excessM - st.excessAtFirstAlert) >= TUNING.COMMIT_GROWTH_M;
      const growingTooLong = st.growthStreakStartAt!=null && (now - st.growthStreakStartAt) >= TUNING.COMMIT_STREAK_MS;
      const tooLong = (now - st.firstAlertAt) >= TUNING.MAX_ALERT_DURATION_MS;
      if(growingTooLong || grownEnough || tooLong){
        st.committed = true;
        if(cb.onDisengage) cb.onDisengage(c.id, c.name, {
          level:st.level, maxExcessM:st.maxExcessM, excessM, widthM:c.widthM, t:now
        });
        continue;
      }

      // Still trying (or at least not yet proven otherwise) — escalate and
      // re-emit on every tick. The host is responsible for turning this
      // per-fix signal into a continuous alarm; this module just reports
      // "still outside, here's the level" as often as it has a fix to check.
      const msOut = now - st.firstAlertAt;
      st.level = Math.max(st.level, ladderLevel(msOut, st.maxExcessM));
      emitWarn(c, st, now, excessM);
    }
  }

  // Pull-based, level-triggered alternative to the onWarn/onClear/onDisengage
  // event stream above. Added 2026-09-19 after a string of field/Test-Mode
  // reports ("tone never turns off") that each traced back to the SAME root
  // shape: an edge-triggered event (onClear/onDisengage) that was supposed
  // to fire exactly once, silently didn't, and the host's alarm was left
  // with no way to notice. Three separate fixes closed three separate ways
  // that could happen (an engaged-gate flicker, wandering out of relevant
  // range, and a GPS/sim tick gap defeating the time-based commit checks)
  // — but the pattern kept recurring because *any* event-sourced design has
  // more ways to lose an event than a reviewer can enumerate in advance.
  //
  // Real automotive lane-departure/collision-warning systems don't drive
  // their alarm output from a stream of enter/exit events at all — they run
  // a fixed-rate control loop that re-derives "should the alarm be on right
  // now" from the latest sensor state on every cycle, and force-applies
  // that answer unconditionally. There is nothing to "miss," because
  // nothing is edge-triggered: a lost cycle just means the very next cycle
  // (milliseconds later) re-asks the same question from scratch and gets it
  // right again. Stale sensor input is its own independent fail-safe check,
  // not a special case bolted onto the alarm logic.
  //
  // getActiveAlarm() is that same shape here: a stateless (from the
  // caller's perspective) query of "what should be sounding right now,"
  // meant to be called on a host-owned fixed-rate timer (every ~150-250ms —
  // far more often than GPS/sim fixes arrive) and have its answer applied
  // to the alarm UNCONDITIONALLY every time, not just on a transition. If a
  // fix hasn't landed inside STALE_MS, the answer is always "no alarm,"
  // regardless of whatever level/committed state a corridor was last left
  // in — this is what makes a stalled walk / GPS dropout self-heal within
  // STALE_MS instead of depending on a separate watchdog timer bolted onto
  // each host (the pattern this replaces). onWarn/onClear/onDisengage still
  // fire as before, for hosts that only want log/toast text — they are no
  // longer the source of truth for whether the alarm itself is sounding.
  //
  // `isEligible(corridorId)` (optional, 2026-09-20): lets a host restrict
  // which corridors are allowed to actually sound the alarm, WITHOUT
  // touching what this module tracks — added for "press and hold a chute on
  // the map to arm/disarm just that one," where a rider typically only wants
  // one or two corridors watched at a time on a project with dozens. tick()
  // keeps computing every corridor's real state regardless (same reasoning
  // as the Battery Saver precedent below: filtering load()'s INPUT instead
  // of the alarm OUTPUT broke isOnLift()/lift detection for a lift-only
  // project — this is the same lesson applied to a second case), so a
  // corridor's escalation/commit history isn't lost or reset by toggling
  // eligibility on and off. Applied INSIDE the loop below, not as a filter
  // on the single returned `best` — this function only ever returns the one
  // loudest active alarm across every corridor, so filtering after the fact
  // could wrongly report "no alarm" when an eligible corridor IS alerting
  // but a louder ineligible one also is. Omit entirely for unchanged
  // behavior (every corridor eligible) — existing hosts that alert on every
  // corridor need no changes.
  function getActiveAlarm(isEligible){
    if(!lastTickAtWall || (Date.now()-lastTickAtWall) > TUNING.STALE_MS) return null;
    // The last real tick found the fix on/near a lift line — tick() itself
    // already cleared every corridor's level for exactly this reason (see
    // its own lift-gate comment), but predictNow()'s dead reckoning below
    // extrapolates purely from lastRealFix's speed/heading and has no idea
    // about lift proximity at all. Without this check, DR could bridge a
    // corridor's `everInside` state back to "audible" moments after tick()
    // just cleared it (e.g. a still-outside-the-chute lastRealFix with a
    // near-zero elapsed time), silently reopening the exact gondola false
    // alarm the lift gate exists to close. currentlyOnLift is itself only
    // ever refreshed by a real tick(), so this is "was the last real fix on
    // a lift," the same recency guarantee the staleness check above gives
    // every other field this function reads.
    if(currentlyOnLift) return null;
    const predicted = predictNow(); // null when DR isn't trustworthy right now — see its own comment
    const drMargin = (lastRealFix && lastRealFix.responsive) ? TUNING.RESP_MARGIN_M : TUNING.DR_CONFIRM_MARGIN_M;
    let best=null;
    for(const c of corridors){
      if(isEligible && !isEligible(c.id)) continue;
      const st = stateByCorridor.get(c.id);
      if(!st || st.committed) continue;
      const predExcessM = predicted!=null ? predictedExcessM(c, predicted) : null;
      let audible, level;
      if(st.level>0){
        // Real fixes say this corridor is currently alerting. DR can only
        // silence it EARLY (predicted CLEARLY already back inside, past
        // DR_CONFIRM_MARGIN_M — not just barely grazing zero, which is
        // exactly what a stale/coasting velocity guess produces) — it never
        // raises the level or invents urgency tick() itself hasn't earned.
        // Wrong in the "silence early" direction self-corrects within one
        // real fix: tick() never mutated st.level/committed here, so if the
        // player is genuinely still outside, the very next real fix sees
        // outsideNow again and re-emits onWarn, resuming the alarm.
        audible = !(predExcessM!=null && predExcessM <= -drMargin);
        level = st.level;
      }else if(st.everInside){
        // Real fixes say this corridor is currently quiet, but the player
        // HAS been inside it before (just not right now — e.g. reset after
        // going out of relevant range, or mid-approach again). DR can start
        // it EARLY (predicted CLEARLY already outside, past the same
        // margin) at a flat level 1, since there's no real
        // firstAlertAt/maxExcessM history yet to compute a proper ladder
        // position from. The moment a real fix confirms it, tick()'s own
        // st.level===0 branch takes over authoritatively and escalates
        // normally from there; this is purely a bridge until it does.
        audible = predExcessM!=null && predExcessM>=drMargin && predExcessM>0 && predExcessM<=TUNING.MAX_RELEVANT_PAD_M;
        level = 1;
      }else{
        // Never been inside this corridor — no approach ping, not even a
        // dead-reckoned one. See the "no approach ping" doc comment at the
        // top of the file; tick() itself won't start an alert here either,
        // so DR must not invent one on its own.
        audible = false;
        level = 0;
      }
      if(audible && (!best || level>best.level)) best = { corridorId:c.id, name:c.name, level, maxExcessM:st.maxExcessM };
    }
    return best;
  }
  // Predicted excess distance (same edgeM threshold tick() itself uses) at a
  // dead-reckoned position — read-only, no state mutation. See predictNow().
  function predictedExcessM(c, predictedLatLon){
    const ref=c.path[0];
    const near=nearestOnPath(predictedLatLon, c.path, ref);
    if(lastRealFix && lastRealFix.responsive){
      const b=biasByCorridor.get(c.id), s=b ? lateralOffsetM(c, predictedLatLon, near) : null;
      if(s!=null) near.distM=Math.abs(s-b.v);
    }
    const edgeM = c.widthM/2 + TUNING.OUTSIDE_BUFFER_M;
    return near.distM - edgeM;
  }

  // Escalation level from the more urgent of the two ladders — how long
  // they've been outside, or how far outside they've gotten. Used both for
  // the very first alert (msOut=0, so only the distance ladder can bite —
  // see its call site above) and for every subsequent tick.
  function ladderLevel(msOut, maxExcessM){
    let lvl = 1;
    for(let i=TUNING.MAX_LEVEL-1;i>=1;i--){
      if(msOut>=TUNING.ESCALATE_AFTER_MS[i] || maxExcessM>=TUNING.ESCALATE_EXCESS_M[i]){ lvl=i+1; break; }
    }
    return Math.min(lvl, TUNING.MAX_LEVEL);
  }

  window.ChuteGuard = { load, tick, unload, getActiveAlarm, isOnLift, TUNING };
})();
