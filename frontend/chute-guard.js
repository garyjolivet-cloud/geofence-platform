// Chute Guard — subtle "you've drifted outside the chute" warning.
//
// Fires only while a skier is actively skiing a chute (tracked most of its
// length, moving roughly along its own direction) and has drifted past its
// authored width band for a sustained moment — never while merely
// traversing across the mountain and clipping through a chute at an angle.
// Gated end-to-end by the app-level `chuteGuardEnabled` flag (bundle-level
// once published); this module itself has no opinion on that flag, the
// host decides whether to load()/tick() it at all.
//
// Self-contained (its own local-planar geometry, no dependency on a host
// page's Geo/QGeo/nearestOnPath) — same "shared module, callback injection,
// no DOM/Audio/Vibration calls of its own" pattern as kalman-filter.js and
// guidance-bot.js. The host owns actually alerting the user (vibration /
// tone / visual) via the onWarn callback; this module only decides WHEN.
//
// Scoped to runType:"chute" corridors specifically (not every run) — a
// chute is narrow and typically flanked by rock/cliff, where drifting off
// line matters in a way it doesn't on a wide groomed run. Broaden the
// filter in load() below if that's ever wanted for other run types.
//
// Usage (mirrors GuidanceBot's lifecycle):
//   ChuteGuard.load(zones, { onWarn(corridorId, name) {...} });
//   // once per GPS fix, after GPSFilter.push()/TravelHeading.update():
//   ChuteGuard.tick({ lat, lon, acc, speed, t }, TravelHeading.heading);
//   ChuteGuard.unload();
//
// `zones` is the bundle's zone array (BUNDLE.zones / simBundle.zones) — each
// chute zone's geometry is read from its corridor target layer
// (zone.layers[].geometry.type==="corridor"), the same {path,widthM} shape
// Geofencer.sd()'s own corridor branch already reads, in [lat,lon] pairs.
(function(){
  "use strict";

  const TUNING = {
    ENGAGE_COVERAGE_PCT: 0.15,   // fraction of the chute's own length that must already be tracked to count as "skiing it," not just clipping it
    ENGAGE_HEADING_TOL_DEG: 55,  // max angle off parallel/anti-parallel to the chute's local bearing to still count as "along it"
    ENGAGE_MIN_SPEED_MPS: 1.5,   // below this, treat as standing/scoping the line, not skiing
    OUTSIDE_BUFFER_M: 4,         // extra margin past the nominal half-width before counting as "outside" (riding the edge on purpose shouldn't nag)
    OUTSIDE_SUSTAIN_MS: 1300,    // must be continuously outside this long before warning — debounces a single noisy GPS fix
    WARN_COOLDOWN_MS: 20000,     // per-corridor cooldown after a warning fires; also single-edge-triggered (re-arms only after returning inside)
    SAMPLE_STEP_M: 20,           // corridor resampling step for the coverage gate
    NEAR_PAD_M: 10,              // GPS-jitter pad when marking a resampled point "covered" (mirrors ridge-quest.html's CORRIDOR_GPS_TOLERANCE_M)
    MAX_RELEVANT_PAD_M: 60,      // beyond half-width+buffer+this, treat as "not near this corridor at all" rather than "way outside it" — prevents a stale/previously-covered corridor from warning while skiing somewhere else entirely
    ACCURACY_CAP_M: 30           // ignore fixes worse than this (mirrors TUNING.ACCURACY_CAP_M elsewhere)
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

  let corridors=[];      // [{id,name,path,widthM,samples,covered:Set<int>}]
  let stateByCorridor=new Map(); // id -> {outsideSince, lastWarnAt}
  let cb={};

  function load(zones, callbacks){
    cb = callbacks || {};
    corridors = (zones||[]).map(z=>{
      if(z.runType!=="chute") return null; // scoped to chutes only, see header comment
      const target = (z.layers||[]).find(l=>l.geometry && l.geometry.type==="corridor");
      const path = target && target.geometry.path;
      if(!path || path.length<2) return null;
      return {
        id: z.id, name: z.name || "chute",
        path, widthM: target.geometry.widthM || 10,
        samples: resample(path, TUNING.SAMPLE_STEP_M),
        covered: new Set()
      };
    }).filter(Boolean);
    stateByCorridor = new Map(corridors.map(c=>[c.id, { outsideSince:null, lastWarnAt:0 }]));
  }

  function unload(){ corridors=[]; stateByCorridor=new Map(); cb={}; }

  // fix: {lat,lon,acc,speed,t}. headingDeg: smoothed travel heading in
  // degrees, or null (sticky-null before the visitor has moved at all —
  // treated as "not engaged," same "no data = don't act" convention as
  // TravelHeading's other consumers).
  function tick(fix, headingDeg){
    if(!corridors.length || fix==null || (fix.acc!=null && fix.acc>TUNING.ACCURACY_CAP_M)) return;
    const latLon=[fix.lat, fix.lon];
    const now = fix.t || Date.now();
    for(const c of corridors){
      const ref=c.path[0];
      const near=nearestOnPath(latLon, c.path, ref);
      const halfW=(c.widthM||10)/2;
      const st=stateByCorridor.get(c.id);

      // Coverage — mark any resampled point currently within the band as
      // "tracked," same idea as QGeo.corridorCoverage but incremental.
      for(let i=0;i<c.samples.length;i++){
        if(c.covered.has(i)) continue;
        if(haversineM(latLon, c.samples[i]) <= halfW+TUNING.NEAR_PAD_M) c.covered.add(i);
      }
      const coverage = c.samples.length ? c.covered.size/c.samples.length : 0;

      // Engaged? all three gates — this is what rejects a traverse.
      let engaged=false;
      if(coverage>=TUNING.ENGAGE_COVERAGE_PCT && headingDeg!=null && fix.speed!=null && fix.speed>=TUNING.ENGAGE_MIN_SPEED_MPS){
        const A=c.path[near.segIdx], B=c.path[Math.min(near.segIdx+1, c.path.length-1)];
        engaged = parallelness(headingDeg, bearing(A,B)) <= TUNING.ENGAGE_HEADING_TOL_DEG;
      }

      // Debug hook — Test Mode wires this into its log panel so an author
      // can see exactly which gate is blocking a warning (coverage/heading/
      // speed/distance) instead of a silent "nothing happened." Throttled
      // per-corridor so a held drag doesn't flood the log. Not wired by the
      // production engine/sim — diagnostic only.
      if(cb.onDebug && now-(st.lastDebugAt||0)>=500){
        st.lastDebugAt=now;
        cb.onDebug(c.id, c.name, { coverage, engaged, distM:near.distM, halfW,
          bufferM:TUNING.OUTSIDE_BUFFER_M, maxRelevantM:halfW+TUNING.OUTSIDE_BUFFER_M+TUNING.MAX_RELEVANT_PAD_M,
          headingDeg, speed:fix.speed });
      }

      const maxRelevantM = halfW+TUNING.OUTSIDE_BUFFER_M+TUNING.MAX_RELEVANT_PAD_M;
      const outsideNow = engaged && near.distM>halfW+TUNING.OUTSIDE_BUFFER_M && near.distM<=maxRelevantM;
      if(!outsideNow){ st.outsideSince=null; continue; }

      if(st.outsideSince==null) st.outsideSince=now;
      if(now-st.outsideSince>=TUNING.OUTSIDE_SUSTAIN_MS && now-st.lastWarnAt>=TUNING.WARN_COOLDOWN_MS){
        st.lastWarnAt=now;
        st.outsideSince=null; // single edge-trigger per excursion
        if(cb.onWarn) cb.onWarn(c.id, c.name);
      }
    }
  }

  window.ChuteGuard = { load, tick, unload, TUNING };
})();
