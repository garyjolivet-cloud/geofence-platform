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
    MAX_LEVEL: 3,
    ESCALATE_AFTER_MS: [0, 5000, 12000],  // time-since-first-alert ladder -> level (index+1)
    ESCALATE_EXCESS_M: [0, 10, 25],       // peak-excess-so-far ladder -> level (index+1); actual level is the more urgent of the two ladders
    COMMIT_STREAK_MS: 4000,      // excess growing continuously (no intervening narrowing) for at least this long...
    COMMIT_GROWTH_M: 15,         // ...or the excess has grown at least this much past its value at the first alert, with no intervening fix narrowing it back...
    MAX_ALERT_DURATION_MS: 15000, // ...or the alarm has simply been sounding this long with no return inside at all (holding at a roughly constant excess, neither growing nor narrowing) -> any of the three conclude "not coming back, stop nagging"
    COMMIT_JITTER_M: 0.5,        // a change in excess smaller than this between fixes counts as neither growth nor a correction (GPS noise floor)
    SAMPLE_STEP_M: 20,           // corridor resampling step for the coverage gate
    NEAR_PAD_M: 10,              // GPS-jitter pad when marking a resampled point "covered"
    MAX_RELEVANT_PAD_M: 60,      // beyond half-width+buffer+this, treat as "not near this corridor at all" rather than "way outside it" — prevents a stale/previously-covered corridor from warning while the player is somewhere else entirely
    ACCURACY_CAP_M: 30,          // ignore fixes worse than this
    STALE_MS: 5000               // getActiveAlarm() treats state older than this as untrustworthy (no fix has landed recently) and reports "no alarm," regardless of whatever level/committed state a corridor was last left in — see getActiveAlarm()'s own comment
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
  function sweptOppositeSideCrossing(prevLatLon, latLon, segA, segB, ref, edgeM){
    if(!prevLatLon) return false;
    const A=toXY(segA, ref), B=toXY(segB, ref);
    const sCur = signedDistToLineXY(toXY(latLon, ref), A, B);
    const sPrev = signedDistToLineXY(toXY(prevLatLon, ref), A, B);
    return Math.abs(sCur) > edgeM && Math.abs(sPrev) > edgeM && (sCur>0) !== (sPrev>0);
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
  let stateByCorridor=new Map();
  let cb={};
  let lastTickAtWall=0;         // real Date.now() at the last tick() call — see getActiveAlarm()
  let prevFixLatLon=null;       // [lat,lon] of the last ACCEPTED fix — see nearestOnPathSwept()

  function freshState(){
    return {
      level:0, firstAlertAt:null, excessAtFirstAlert:0,
      maxExcessM:0, prevExcessM:null, growthStreakStartAt:null, committed:false,
      alertCount:0, lastDebugAt:0, lastEmittedLevel:0, everInside:false
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

  function unload(){ corridors=[]; stateByCorridor=new Map(); cb={}; lastTickAtWall=0; prevFixLatLon=null; }

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
    if(!corridors.length || fix==null || (fix.acc!=null && fix.acc>TUNING.ACCURACY_CAP_M)) return;
    lastTickAtWall = Date.now(); // real wall clock, independent of fix.t — see getActiveAlarm()
    const latLon=[fix.lat, fix.lon];
    const now = fix.t || Date.now();
    const prevLatLon = prevFixLatLon; // captured before this tick updates it, below
    prevFixLatLon = latLon;

    for(const c of corridors){
      const ref=c.path[0];
      const near=nearestOnPath(latLon, c.path, ref); // current true distance — unaffected by the crossing check below
      const halfW=c.widthM/2;
      const st=stateByCorridor.get(c.id);

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
      if(near.distM <= halfW) st.everInside = true; // still tracked for onDebug only, see below
      // "Hard line in space" requirement, 2026-09-19: the user explicitly
      // asked for the corridor's edge to be a pure function of CURRENT
      // position — outside the width+buffer means the alarm is on, inside
      // means it's off, full stop, no history and no heading/speed
      // requirement deciding whether that's "trustworthy enough." `engaged`
      // and `everInside` used to also have to be satisfied before a FRESH
      // excursion could start (to avoid false-alarming on a mere
      // perpendicular crossing, or an approach that hadn't reached the
      // corridor yet) — removed from this decision entirely per that
      // explicit request; they're computed above/below only so onDebug's
      // existing log format keeps showing them for diagnostic purposes.
      // The one exception the user explicitly chose to KEEP: the
      // committed-exit detector further down can still silence an active,
      // still-outside excursion once it concludes the departure is
      // deliberate — otherwise skiing/riding away on purpose would alarm
      // forever with no way to stop it short of returning.
      const outsideNow = excessM > 0 && near.distM <= maxRelevantM && !crossedOppositeSide;

      // Debug hook — Test Mode wires this into its log panel so an author
      // can see exactly which gate is blocking a warning (coverage/heading/
      // speed/distance) instead of a silent "nothing happened." Throttled
      // per-corridor so a held drag doesn't flood the log. Not wired by the
      // production engine/sim — diagnostic only.
      if(cb.onDebug && now-(st.lastDebugAt||0)>=500){
        st.lastDebugAt=now;
        cb.onDebug(c.id, c.name, { coverage, engaged, distM:near.distM, halfW,
          bufferM:TUNING.OUTSIDE_BUFFER_M, maxRelevantM, everInside:st.everInside,
          headingDeg, speed:fix.speed, excessM, level:st.level, committed:st.committed,
          lat:fix.lat, lon:fix.lon }); // raw position — lets an exported log be checked against exactly where a crossing happened
      }

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
        const levelAtReset = st.level;
        const maxExcessAtReset = st.maxExcessM;
        Object.assign(st, freshState());
        // A genuine "gone away" (out of relevant range) is the only case
        // that should require re-earning entry on the next approach —
        // everything else (still inside/buffered, or still approaching
        // pre-entry within relevant range) keeps whatever entry status it
        // already had.
        if(!outOfRelevantRange) st.everInside = everInside;
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
        // 12s the way a gradual drift would.
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
  function getActiveAlarm(){
    if(!lastTickAtWall || (Date.now()-lastTickAtWall) > TUNING.STALE_MS) return null;
    let best=null;
    for(const c of corridors){
      const st = stateByCorridor.get(c.id);
      if(st && st.level>0 && !st.committed){
        if(!best || st.level>best.level) best = { corridorId:c.id, name:c.name, level:st.level, maxExcessM:st.maxExcessM };
      }
    }
    return best;
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

  window.ChuteGuard = { load, tick, unload, getActiveAlarm, TUNING };
})();
