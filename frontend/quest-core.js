/* quest-core.js -- Ridge Quest's run engine: what counts as "skied a corridor" and how a pass
   is classified, plus the "one descent, one chute" tie-break. Moved here VERBATIM from
   ridge-quest.html on 2026-10-08 (Gary: "test needs to be a true simulator") so the Fence
   Editor's Test Mode scores with the same code as the phone -- never keep a second copy.

   window.QuestCore = { TUNING, QGeo, passesOverlap, runMethods }

   runMethods is mixed into a host object (Object.assign(host, QuestCore.runMethods)); the host
   provides: states {}, corridors [], _passes [], onCoverage(name, pct, passed, reason)|null,
   riderName(zoneId, officialName), runLog(line)|undefined, and
   _postRun(corridor, run, fixes) -- what to do with a logged run (the phone saves it through
   the offline outbox; Test Mode keeps it in memory). Plain script, no DOM, no network. */
(function (root) {
"use strict";

const QUEST_TUNING = {
  MIN_DURATION_S: 2,       // start-zone -> end-zone time below this is a timestamp glitch, not a run. Was 8 (whole-buffer flicker filter); the pass window is now just the zone-to-zone stretch of a corridor that can be only ~70-110 m long, which a genuine fast run covers in a few seconds
  MAX_DURATION_S: 5400,    // 90 min — something went wrong (GPS stuck in-band), discard
  SKI_SPEED_MIN_MPS: 2.5,  // ~9 km/h; below this while descending a run = skinning/walking it, not skiing it
  COOLDOWN_MS: 4000,       // avoid double-counting a lingering crossing at the band edge
  ACCURACY_CAP_M: 40,      // R2: fixes worse than this don't drive fog reveal — same value/reasoning as geofence-engine.html's TUNING.ACCURACY_CAP_M
  // --- Full-run verification (2026-09-21). Field report: skiing ACROSS a
  // corridor (a traverse) logged it as skied. Root causes, all in the old
  // detector: (1) coverage was "is the track within halfWidth+15m of >=50% of
  // sample points", an UNORDERED nearness test -- on a short or narrow
  // corridor a slow perpendicular crossing satisfied it; (2) nothing required
  // starting at one end and finishing at the other; (3) direction only chose
  // ski-vs-hike, it never rejected; (4) a chute always scored as ski at any
  // speed/direction; (5) vertical came from the authored descent x coverage,
  // so real elevation change was never looked at; (6) hiking UP scored the
  // same points as skiing down (points use |vertical|). A corridor now counts
  // only when QGeo.evaluateTraversal() verifies an ordered end-to-end pass.
  // ACTUAL cause of the field false-positives, from prod quest_run + corridor
  // rows: most Kicking Horse chutes are short and WIDE blobs (After Pride
  // 75m x 111m, Alley 17 50m x 171m, South End Dump Run 50m x 161m; 46 of 70
  // run/chute corridors are under 250m long). The old tolerance was halfWidth
  // + 15m = 40-52m, so a 50-80m traverse through the middle of one was within
  // tolerance of every sample point -> 100% "coverage" -> full authored
  // descent credited, in 8-24 s. Three chutes logged inside one minute.
  // Every value is a starting point, not measured -- tune after field tests.
  RUN_ACC_MAX_M: 35,        // fixes worse than this are ignored entirely (a 200m-accuracy fix must never count as "at the top")
  RUN_TOL_MIN_M: 8,         // a fix is ON the corridor within halfWidth + clamp(fix.acc, MIN, MAX)
  RUN_TOL_MAX_M: 20,
  ENDPOINT_ZONE_M: 40,      // the pass must touch within this arc-length of BOTH ends, in order; capped at 25% of a corridor's length so short corridors stay strict
  COVER_BIN_M: 20,          // the corridor is cut into bins this long; coverage = fraction of bins the track actually passed through
  CORRIDOR_COMPLETION_PCT: 0.8,
  BRIDGE_S: 30,             // consecutive usable fixes further apart than this (GPS dropout) don't bridge the bins between them
  CHORD_SLACK_M: 40,        // a jump in along-corridor position must be explainable by MAX_ALONG_SPEED_MPS x dt + this, else it's a GPS teleport and covers nothing
  OFF_ROUTE_MAX_FRAC: 0.3,  // time-weighted share of the pass spent off the corridor
  RETREAT_MIN_M: 40,        // deepest allowed back-slide along the corridor during the pass: max(this, RETREAT_FRAC x length)
  RETREAT_FRAC: 0.15,
  HEADING_MIN_MOVE_M: 6,    // bearing is measured over displacements at least this long, so GPS jitter can't fake a heading
  HEADING_TOL_DEG: 80,      // a step "agrees" with the corridor when its bearing is within this of the corridor's local bearing
  HEADING_AGREE_MIN: 0.5,   // share of steps that must agree -- a perpendicular traverse agrees ~0%
  ELEV_CHECK_MIN_M: 60,     // elevation is only checked on downhill-run/chute/lift corridors with at least this much authored descent (phone GPS altitude is too noisy to judge small drops). Kicking Horse's short steep chutes lose ~80-110 m
  ELEV_MIN_FRAC: 0.35,      // measured altitude change must reach this share of the authored descent (less ELEV_TOL_M)
  ELEV_TOL_M: 25,
  ELEV_MIN_SAMPLES: 6,      // fewer altitude readings than this = not reliable, elevation check is skipped (never fails a run on missing data)
  MAX_ALONG_SPEED_MPS: 45,  // ~160 km/h along the corridor -- faster is a GPS jump, not a person
  MIN_ALONG_SPEED_MPS: 0.15,
  LIFT_SPEED_MIN_MPS: 1.8,  // walking up a lift line isn't a lift ride (a slow fixed-grip chair is ~2.2 m/s)
  HIKE_SPEED_MAX_MPS: 5,    // faster than a fast trail run = mechanised (lift/vehicle) or skied, not hiked
  CHUTE_SPEED_MIN_MPS: 0.7, // careful chute skiing is slow (side-slipping), but standing still isn't skiing it
  LIFT_BAND_EXTRA_M: 5,     // the lift-ride test counts a fix as "on the lift" up to this far OUTSIDE the lift corridor's own half-width. Kicking Horse's gondola is authored 10 m wide, and phone GPS on a mountain is 5-10 m off, so with the bare band a real gondola ride put only ~40% of fixes inside at 6 m noise and ~0% at 8 m (need LIFT_OVERLAP_FRAC). +5 m catches every simulated ride up to 10 m noise (tests/quest-corridor-detection.test.js pins it); its one cost is a run that sits right beside a chairlift (Ridemption Ridge Speedway beside Stairway Chair, ~15% at 4 m noise), and only when the phone has no usable altitude.
  LIFT_OVERLAP_FRAC: 0.6,   // an "up" pass of a run that is >= this share inside a lift corridor's band was a lift ride, not a hike
  // Run recorder (per corridor, independent of the narration band above):
  // starts when a fix is within halfWidth+REC_HOLD_M, ends REC_GRACE_S after
  // the last such fix. Much wider than the 3m narration band on purpose --
  // the old exit-on-first-fix-outside-the-band chopped a real run into
  // fragments on a narrow chute whenever GPS drifted a few metres.
  REC_HOLD_M: 40,
  PASS_SETTLE_MS: 15000,    // a verified pass waits up to this long for an overlapping chute's pass, then the best fit is logged (Quest._settlePasses)
  // Armed isolation (Guard OFF + armed chutes only): an unarmed chute/run/hike whose band
  // comes within this many metres of an armed corridor's band ignores GPS while that one is
  // armed -- no narration, no recording, no run logged. About phone GPS error.
  ARMED_ADJ_PAD_M: 10,
  REC_GRACE_S: 15,
  REC_MIN_STEP_M: 3,        // recorded fixes are decimated: kept when they moved this far...
  REC_MAX_STEP_S: 10,       // ...or this long has passed, so a long hike's buffer stays small
  REC_MAX_FIXES: 20000,
  FEEDBACK_MIN_COVERAGE: 0.4, // only tell the player "not counted, because..." when they actually covered a meaningful part; a plain traverse stays silent
  // --- Elevation checkpoints (headline vertical, _tickCheckpoints) ---
  CHECKPOINT_RADIUS_M: 20,        // a pass-through spot on a lift/run line — a touch wider than VIEWPOINT_RADIUS_M since you're moving through it, not standing
  CHECKPOINT_COOLDOWN_MS: 60000,  // per-checkpoint: a lingering GPS hit can't re-credit the same lap
  CHECKPOINT_STALE_MS: 1200000    // 20 min — beyond this gap, two checkpoint elevations aren't one trustworthy descent (lunch, lift maze, overnight)
};

const QGeo = {
  R: 6371000,
  mPerDegLat: 111320,
  mPerDegLon(lat){ return 111320*Math.cos(lat*Math.PI/180); },
  toXY(p, ref){ return { x:(p[1]-ref[1])*this.mPerDegLon(ref[0]), y:(p[0]-ref[0])*this.mPerDegLat }; },
  haversineM(a,b){ const p1=a[0]*Math.PI/180,p2=b[0]*Math.PI/180,
            dp=(b[0]-a[0])*Math.PI/180,dl=(b[1]-a[1])*Math.PI/180;
            const x=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
            return 2*this.R*Math.asin(Math.sqrt(x)); },
  segDist(P,A,B){ const vx=B.x-A.x, vy=B.y-A.y, wx=P.x-A.x, wy=P.y-A.y;
            const c1=vx*wx+vy*wy; if(c1<=0) return Math.hypot(wx,wy);
            const c2=vx*vx+vy*vy; if(c2<=c1) return Math.hypot(P.x-B.x,P.y-B.y);
            const t=c1/c2; return Math.hypot(P.x-(A.x+t*vx), P.y-(A.y+t*vy)); },
  // signed distance from p [lat,lon] to a corridor polyline `path` ([lat,lon]
  // pairs), minus half its width — same formula as geofence-engine.html's
  // Geofencer.sd() corridor branch.
  corridorDist(p, corridor, ref){
    const P=this.toXY(p,ref);
    const pts=corridor.path.map(c=>this.toXY(c,ref));
    let best=Infinity;
    for(let i=1;i<pts.length;i++) best=Math.min(best, this.segDist(P,pts[i-1],pts[i]));
    return best - (corridor.widthM||10)/2;
  },
  // True when two corridors' bands touch or come within padM of each other: the shortest
  // distance between the two centrelines (0 where they cross) is at most
  // halfWidthA + halfWidthB + padM. Missing width counts as 10 m, like corridorDist.
  corridorsTouch(a, b, padM){
    const pa=a.path||[], pb=b.path||[];
    if(pa.length<2 || pb.length<2) return false;
    const ref = a.ref || pa[0];
    const lim = (a.widthM||10)/2 + (b.widthM||10)/2 + (padM||0);
    const A = pa.map(c=>this.toXY(c,ref)), B = pb.map(c=>this.toXY(c,ref));
    const box = P=>{ let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
      for(const q of P){ if(q.x<x0)x0=q.x; if(q.x>x1)x1=q.x; if(q.y<y0)y0=q.y; if(q.y>y1)y1=q.y; }
      return {x0,y0,x1,y1}; };
    const ba=box(A), bb=box(B);
    if(ba.x0-lim>bb.x1 || bb.x0-lim>ba.x1 || ba.y0-lim>bb.y1 || bb.y0-lim>ba.y1) return false;
    const cross=(p,q,r)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);
    for(let i=1;i<A.length;i++){
      const a0=A[i-1], a1=A[i];
      const sx0=Math.min(a0.x,a1.x)-lim, sx1=Math.max(a0.x,a1.x)+lim, sy0=Math.min(a0.y,a1.y)-lim, sy1=Math.max(a0.y,a1.y)+lim;
      for(let j=1;j<B.length;j++){
        const b0=B[j-1], b1=B[j];
        if(Math.max(b0.x,b1.x)<sx0 || Math.min(b0.x,b1.x)>sx1 || Math.max(b0.y,b1.y)<sy0 || Math.min(b0.y,b1.y)>sy1) continue;
        const d1=cross(a0,a1,b0), d2=cross(a0,a1,b1), d3=cross(b0,b1,a0), d4=cross(b0,b1,a1);
        if(((d1>0&&d2<0)||(d1<0&&d2>0)) && ((d3>0&&d4<0)||(d3<0&&d4>0))) return true;
        if(Math.min(this.segDist(a0,b0,b1), this.segDist(a1,b0,b1), this.segDist(b0,a0,a1), this.segDist(b1,a0,a1)) <= lim) return true;
      }
    }
    return false;
  },
  // ---- Full-run verification (QUEST_TUNING "Full-run verification") ----
  // Corridor geometry in local metres, computed once per corridor: XY points,
  // cumulative arc-length, per-segment bearing (deg clockwise from north).
  // Cached on the corridor object but revalidated by path/ref identity, so an
  // Object.assign() clone with a different path never reads a stale cache.
  geom(corridor){
    const c = corridor._g;
    if(c && c.path===corridor.path && c.ref===corridor.ref) return c;
    const ref = corridor.ref;
    const xy = corridor.path.map(pt=>this.toXY(pt, ref));
    const cum = [0], brg = [];
    for(let i=1;i<xy.length;i++){
      const dx = xy[i].x-xy[i-1].x, dy = xy[i].y-xy[i-1].y;
      cum.push(cum[i-1] + Math.hypot(dx,dy));
      brg.push((Math.atan2(dx,dy)*180/Math.PI + 360) % 360);
    }
    return (corridor._g = { path:corridor.path, ref, xy, cum, brg, L:cum[cum.length-1] });
  },
  // Projects pt [lat,lon] onto the corridor centreline -> {s: arc-length from
  // path[0] in m, d: perpendicular distance in m, seg: segment index}. On a
  // corridor that doubles back (switchbacks) or loops, several legs can be
  // about equally near; among legs within 8m of the nearest, prefer the one
  // closest to hintS (where the previous on-corridor fix was), or the earliest
  // when there's no hint -- so progress stays continuous instead of jumping
  // between legs.
  projectOnPath(pt, G, hintS){
    const P = this.toXY(pt, G.ref);
    const cands = []; let bestD = Infinity;
    for(let i=1;i<G.xy.length;i++){
      const A = G.xy[i-1], B = G.xy[i];
      const vx = B.x-A.x, vy = B.y-A.y, len2 = vx*vx + vy*vy;
      let t = len2>0 ? ((P.x-A.x)*vx + (P.y-A.y)*vy)/len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(P.x-(A.x+t*vx), P.y-(A.y+t*vy));
      cands.push({ d, s:G.cum[i-1] + t*Math.sqrt(len2), seg:i-1 });
      if(d < bestD) bestD = d;
    }
    let pick = null;
    for(let i=0;i<cands.length;i++){
      const c = cands[i];
      if(c.d > bestD + 8) continue;
      if(!pick) pick = c;
      else if(hintS!=null ? Math.abs(c.s-hintS) < Math.abs(pick.s-hintS) : c.s < pick.s) pick = c;
    }
    return pick;
  },
  _median(a){
    const b = a.slice().sort((x,y)=>x-y), n = b.length;
    return n%2 ? b[(n-1)/2] : (b[n/2-1] + b[n/2])/2;
  },
  // Lateral tolerance (m, beyond half the corridor's width) for calling a fix
  // "on" the corridor: the fix's own reported accuracy, clamped to
  // [RUN_TOL_MIN_M, RUN_TOL_MAX_M] -- and additionally capped at ~8% of the
  // corridor's length. On a ~90m corridor a generous 20m tolerance let a
  // diagonal ski-across sit "on" it at both ends; short corridors get the
  // tight minimum instead (a corridor >= 250m long is unaffected).
  // Mean distance (m) of the fixes from the corridor's centreline: how well a pass fits it.
  meanOffsetM(corridor, fixes){
    const G = this.geom(corridor);
    if(!fixes || !fixes.length || G.xy.length < 2) return Infinity;
    let sum = 0, lastS = null;
    fixes.forEach(f=>{ const pr = this.projectOnPath([f.lat,f.lon], G, lastS); lastS = pr.s; sum += pr.d; });
    return sum / fixes.length;
  },
  fixTol(acc, L, T){
    const cap = Math.min(T.RUN_TOL_MAX_M, Math.max(T.RUN_TOL_MIN_M, L*0.08));
    return Math.max(T.RUN_TOL_MIN_M, Math.min(cap, acc!=null ? acc : 10));
  },
  // Decides whether `buffer` (fixes [{lat,lon,t,acc?,alt?,speed?}]) contains a
  // real END-TO-END pass of `corridor`, and if so measures it. This replaces
  // the old unordered "was the track near half the corridor" coverage test.
  // A pass must, in order:
  //   1. start in the corridor's start zone and later arrive in its far end
  //      zone, on the corridor (start/end point + direction). Top-first is a
  //      "down" pass, bottom-first an "up" pass -- the caller decides which
  //      activities each direction is worth;
  //   2. cover >= CORRIDOR_COMPLETION_PCT of it, bin by bin, with no
  //      teleports (progress along the line must be explainable by speed);
  //   3. stay on it (time off-corridor, deepest back-slide);
  //   4. actually head ALONG it (bearing of movement vs the corridor's local
  //      bearing);
  //   5. take a plausible time / speed for the distance;
  //   6. where the corridor has a real authored descent, show a matching
  //      altitude change (skipped when altitude is missing or unreliable).
  // Returns {ok, reason, coverage, dir, durationS, avgSpeedMps, maxSpeedMps,
  // distanceM, tStart, tEnd, fixes, ...metrics}. `reason` is player-facing.
  evaluateTraversal(corridor, buffer, T){
    const G = this.geom(corridor), L = G.L, ref = corridor.ref;
    const halfW = (corridor.widthM||10)/2;
    const fail = (reason, extra)=>Object.assign({ ok:false, reason, coverage:0, dir:null }, extra||{});
    if(!(L>=20) || !buffer || buffer.length<2) return fail("not enough GPS data to check");

    // 1. Project every usable fix onto the centreline.
    const pts = []; let hint = null;
    for(let i=0;i<buffer.length;i++){
      const f = buffer[i];
      if(f.acc!=null && f.acc > T.RUN_ACC_MAX_M) continue;
      const pr = this.projectOnPath([f.lat,f.lon], G, hint);
      const on = pr.d <= halfW + this.fixTol(f.acc, L, T);
      if(on) hint = pr.s;
      pts.push({ f, t:f.t, s:pr.s, seg:pr.seg, on });
    }
    if(pts.length<2) return fail("GPS accuracy too poor to check");

    const zone = Math.max(10, Math.min(T.ENDPOINT_ZONE_M, L*0.25));
    const nBins = Math.max(1, Math.ceil(L/T.COVER_BIN_M));
    const maxDurationS = Math.max(T.MAX_DURATION_S, (corridor.lengthM||0) / 0.5);

    // Bins of the corridor the track passed through, over pts[i0..i1]. With
    // fillZones, the start/end zones count as covered outright: reaching a zone
    // is what the zone test already proved, and a pass is logged the moment the
    // far zone is entered, so its bins can't have been walked yet.
    const cover = (i0, i1, fillZones)=>{
      const hit = new Uint8Array(nBins);
      const mark = (s0, s1)=>{
        const lo = Math.min(s0,s1), hi = Math.max(s0,s1);
        const b0 = Math.max(0, Math.min(nBins-1, Math.floor(lo/T.COVER_BIN_M)));
        const b1 = Math.max(0, Math.min(nBins-1, Math.floor(hi/T.COVER_BIN_M)));
        for(let k=b0;k<=b1;k++) hit[k] = 1;
      };
      let prev = null;
      for(let i=i0;i<=i1;i++){
        const q = pts[i];
        if(!q.on) continue;
        mark(q.s, q.s);
        if(prev){
          const dt = (q.t-prev.t)/1000, ds = Math.abs(q.s-prev.s);
          if(dt>0 && dt<=T.BRIDGE_S && ds <= T.MAX_ALONG_SPEED_MPS*dt + T.CHORD_SLACK_M) mark(prev.s, q.s);
        }
        prev = q;
      }
      if(fillZones){
        for(let k=0;k<=Math.min(nBins-1, Math.floor(zone/T.COVER_BIN_M));k++) hit[k] = 1;
        for(let k=Math.max(0, Math.floor((L-zone)/T.COVER_BIN_M));k<nBins;k++) hit[k] = 1;
      }
      let n = 0; for(let k=0;k<nBins;k++) n += hit[k];
      return n/nBins;
    };

    // First ordered start-zone -> end-zone pass in direction `dir`. `a` is the
    // LAST start-zone fix before the first end-zone arrival, so time spent
    // hanging around at the top (or an earlier lap) isn't counted as run time.
    const findTrip = dir=>{
      const inStart = q=> dir==="down" ? q.s<=zone : q.s>=L-zone;
      const inEnd = q=> dir==="down" ? q.s>=L-zone : q.s<=zone;
      let a = -1;
      for(let i=0;i<pts.length;i++){
        const q = pts[i];
        if(!q.on) continue;
        if(inStart(q)) a = i;
        else if(a>=0 && inEnd(q)) return { a, b:i };
      }
      return null;
    };

    const judge = (dir, a, b)=>{
      const A = pts[a], B = pts[b];
      const durationS = (B.t-A.t)/1000;
      let pathM = 0, maxStep = 0, gpsMax = 0;
      for(let i=a+1;i<=b;i++){
        const d = this.haversineM([pts[i-1].f.lat,pts[i-1].f.lon], [pts[i].f.lat,pts[i].f.lon]);
        const dt = (pts[i].t-pts[i-1].t)/1000;
        pathM += d;
        if(dt>0) maxStep = Math.max(maxStep, d/dt);
      }
      for(let i=a;i<=b;i++) gpsMax = Math.max(gpsMax, pts[i].f.speed||0);
      const alongM = Math.abs(B.s-A.s);
      const alongSpeed = durationS>0 ? alongM/durationS : Infinity;
      const cov = cover(a, b, true);

      // time-weighted share spent off the corridor
      let offT = 0, totT = 0;
      for(let i=a;i<b;i++){
        const dt = pts[i+1].t-pts[i].t; totT += dt;
        if(!pts[i].on || !pts[i+1].on) offT += dt;
      }
      const offFrac = totT>0 ? offT/totT : 0;

      // deepest back-slide (progress measured in the pass's own direction)
      let runMax = -Infinity, retreatM = 0;
      for(let i=a;i<=b;i++){
        if(!pts[i].on) continue;
        const u = dir==="down" ? pts[i].s : L-pts[i].s;
        if(u>runMax) runMax = u;
        retreatM = Math.max(retreatM, runMax-u);
      }

      // bearing agreement: anchor-based so a step is >= HEADING_MIN_MOVE_M long
      let agree = 0, steps = 0, anchor = pts[a];
      for(let i=a+1;i<=b;i++){
        const q = pts[i];
        const P0 = this.toXY([anchor.f.lat,anchor.f.lon], ref), P1 = this.toXY([q.f.lat,q.f.lon], ref);
        const dx = P1.x-P0.x, dy = P1.y-P0.y;
        if(Math.hypot(dx,dy) < T.HEADING_MIN_MOVE_M) continue;
        anchor = q;
        if(!q.on) continue;
        const mv = (Math.atan2(dx,dy)*180/Math.PI + 360) % 360;
        let cb = G.brg[q.seg]; if(dir==="up") cb = (cb+180) % 360;
        let diff = Math.abs(mv-cb); if(diff>180) diff = 360-diff;
        steps++; if(diff<=T.HEADING_TOL_DEG) agree++;
      }
      const headingAgree = steps>=3 ? agree/steps : null;

      // altitude: median of the first vs last few readings, compared with the
      // authored descent -- only on runs where net descent is what was authored
      const alts = [];
      for(let i=a;i<=b;i++){ const al = pts[i].f.alt; if(al!=null && isFinite(al)) alts.push(al); }
      let altChangeM = null;
      if(alts.length>=T.ELEV_MIN_SAMPLES){
        const k = Math.min(3, Math.floor(alts.length/3));
        altChangeM = this._median(alts.slice(-k)) - this._median(alts.slice(0,k));
      }
      const netDescentRun = corridor.runType==="lift" ||
        ((corridor.runType==="run" || corridor.runType==="chute") &&
         ["xcountry","walking_city","bike","hike"].indexOf(corridor.activityType)<0);
      const need = corridor.descentM;
      let elevChecked = false, elevFail = false;
      if(netDescentRun && need!=null && need>=T.ELEV_CHECK_MIN_M && altChangeM!=null){
        elevChecked = true;
        const signed = dir==="down" ? -altChangeM : altChangeM;
        elevFail = signed < T.ELEV_MIN_FRAC*need - T.ELEV_TOL_M;
      }

      const r = { ok:false, reason:null, dir, coverage:cov, durationS, alongM, alongSpeedMps:alongSpeed,
        pathM, avgSpeedMps: durationS>0 ? pathM/durationS : 0, maxSpeedMps: gpsMax>0 ? gpsMax : maxStep,
        distanceM: Math.min(pathM, L*1.25), tStart:A.t, tEnd:B.t, offFrac, retreatM, headingAgree,
        altChangeM, elevChecked, fixes: pts.slice(a,b+1).map(q=>q.f) };
      if(durationS < T.MIN_DURATION_S) r.reason = "too quick to be a real run";
      else if(durationS > maxDurationS) r.reason = "took too long";
      else if(alongSpeed > T.MAX_ALONG_SPEED_MPS) r.reason = "GPS jumped (impossibly fast)";
      else if(alongSpeed < T.MIN_ALONG_SPEED_MPS) r.reason = "barely moved";
      else if(cov < T.CORRIDOR_COMPLETION_PCT) r.reason = "didn't follow it all the way";
      else if(offFrac > T.OFF_ROUTE_MAX_FRAC) r.reason = "strayed off it";
      else if(retreatM > Math.max(T.RETREAT_MIN_M, T.RETREAT_FRAC*L)) r.reason = "doubled back partway";
      else if(headingAgree!=null && headingAgree < T.HEADING_AGREE_MIN) r.reason = "wasn't heading along it";
      else if(elevFail) r.reason = "elevation didn't change like a real "+(dir==="down" ? "descent" : "climb");
      else r.ok = true;
      return r;
    };

    const cands = ["down","up"].map(dir=>{ const tr = findTrip(dir); return tr ? judge(dir, tr.a, tr.b) : null; }).filter(Boolean);
    const good = cands.find(c=>c.ok);
    if(good) return good;
    if(cands.length) return cands.sort((x,y)=>y.coverage-x.coverage)[0];
    // No ordered start -> finish pass at all: say which end was missed.
    let top = false, bottom = false;
    pts.forEach(q=>{ if(q.on){ if(q.s<=zone) top = true; if(q.s>=L-zone) bottom = true; } });
    const why = (!top && !bottom) ? "didn't run it end to end"
      : !top ? "never reached the top of it"
      : !bottom ? "never reached the bottom of it"
      : "didn't run it end to end";
    return fail(why, { coverage: cover(0, pts.length-1) });
  }
};

// Pure -- two verified passes are "the same descent" when they are of different non-lift corridors
// and overlap in time by at least half of the shorter one (Quest._settlePasses, 2026-10-03).
function passesOverlap(a, b){
  if(a.corridor.zoneId===b.corridor.zoneId) return false;
  if(a.run.activity==="lift" || b.run.activity==="lift") return false;
  const ov = Math.min(a.t1, b.t1) - Math.max(a.t0, b.t0);
  return ov > 0 && ov >= 0.5 * Math.min(a.t1 - a.t0, b.t1 - b.t0);
}

const runMethods = {
  // The run recorder: the second half of ridge-quest.html's Quest._tick (which does the
  // narration first and passes its own st / halfW / dist so nothing is computed twice).
  _record(corridor, p, selectedActivity, st, halfW, dist){
    if(!st) st = this.states[corridor.zoneId] || (this.states[corridor.zoneId] = { phase:"idle", narrCooldownUntil:0, cooldownUntil:0, rec:null });
    if(Date.now() < st.cooldownUntil) return;
    if(halfW==null) halfW = (corridor.widthM||10)/2;
    if(dist==null) dist = QGeo.corridorDist([p.lat,p.lon], corridor, corridor.ref);
    // ---- Run recorder ----
    // Records everything near the corridor, then asks QGeo.evaluateTraversal
    // (via _classifyAndLog) whether it was a real end-to-end pass. A pass is
    // logged the moment the far end zone is reached -- not when the player
    // eventually wanders off -- so lingering at a lift base can't delay or
    // fold laps together. When the player leaves without completing, one final
    // check runs purely to report WHY it didn't count.
    const R = QUEST_TUNING;
    const near = (dist + halfW) <= halfW + R.REC_HOLD_M;
    let rec = st.rec;
    if(!rec){
      if(!near) return;
      rec = st.rec = { buf:[], lastNearT:p.t, lastS:null, sawTop:false, sawBottom:false };
    }
    if(near) rec.lastNearT = p.t;
    const lastRec = rec.buf[rec.buf.length-1];
    if(!lastRec || p.t-lastRec.t >= R.REC_MAX_STEP_S*1000 || QGeo.haversineM([lastRec.lat,lastRec.lon],[p.lat,p.lon]) >= R.REC_MIN_STEP_M){
      rec.buf.push({ lat:p.lat, lon:p.lon, acc:p.acc, t:p.t, speed:p.speed, alt:p.alt });
      if(rec.buf.length > R.REC_MAX_FIXES) rec.buf.shift();
    }
    if(near && (p.acc==null || p.acc <= R.RUN_ACC_MAX_M)){
      const G = QGeo.geom(corridor);
      const pr = QGeo.projectOnPath([p.lat,p.lon], G, rec.lastS);
      if(pr.d <= halfW + QGeo.fixTol(p.acc, G.L, R)){
        rec.lastS = pr.s;
        const zone = Math.max(10, Math.min(R.ENDPOINT_ZONE_M, G.L*0.25));
        const atTop = pr.s <= zone, atBottom = pr.s >= G.L - zone;
        // Only worth a full evaluation when an end zone is reached having
        // already visited the OTHER one (the flags are set after the probe so
        // a fix never counts as its own opposite end).
        if((atBottom && rec.sawTop) || (atTop && rec.sawBottom)){
          const r = this._classifyAndLog(corridor, rec.buf, selectedActivity, false);
          if(r===true || r==="rejected"){
            st.rec = null; st.cooldownUntil = Date.now()+R.COOLDOWN_MS;
            return;
          }
        }
        if(atTop) rec.sawTop = true;
        if(atBottom) rec.sawBottom = true;
      }
    }
    if(!near && p.t - rec.lastNearT > R.REC_GRACE_S*1000){
      this._classifyAndLog(corridor, rec.buf, selectedActivity, true);
      st.rec = null;
    }
  },

  // Verifies `buffer` is a real end-to-end pass of `corridor`, classifies it
  // (ski/hike/bike/...), and logs it. Returns true when logged, "rejected"
  // when the pass was genuine but isn't creditable (consumed -- don't re-try),
  // false when it isn't a completed pass (yet). `isFinal` is true only when
  // the player has left the corridor: that's the one time a failure is
  // explained to them via onCoverage; mid-recording probes stay silent.
  _classifyAndLog(corridor, buffer, selectedActivity, isFinal){
    const S = QUEST_TUNING;
    const trip = QGeo.evaluateTraversal(corridor, buffer, S);
    if(!trip.ok){
      if(isFinal && this.onCoverage && trip.coverage >= S.FEEDBACK_MIN_COVERAGE) this.onCoverage(corridor.name, trip.coverage, false, trip.reason);
      return false;
    }
    const coverage = trip.coverage, durationS = trip.durationS;
    const first = trip.fixes[0], last = trip.fixes[trip.fixes.length-1];
    // Direction comes from the verified ORDER of the pass (start zone first,
    // then the far end zone), not from which endpoint the first/last fix
    // happened to be nearer -- the old nearest-endpoint test called any run
    // that merely ended in the lower half "descending".
    const descending = trip.dir==="down", ascending = trip.dir==="up";
    const distanceM = trip.distanceM, avgSpeedMps = trip.avgSpeedMps, maxSpeedMps = trip.maxSpeedMps;
    // Genuine pass, not creditable: tell the player why, and consume it.
    const reject = (why)=>{ if(this.onCoverage) this.onCoverage(this.riderName(corridor.zoneId, corridor.name), coverage, false, why); return "rejected"; };
    // verticalM (which feeds POINTS) is assigned after the activity block
    // below -- it depends on the classified activity.

    // Ridge Quest is ski-only (2026-09-30): there is no activity choice, so the corridor and
    // the direction/pace decide. A lift is mechanized transport, detected by ascending a
    // runType:"lift" corridor. ONLY a corridor the author marked runType:"hike" is a boot pack
    // (stored as "hike") -- 2026-10-01. A chute (runType:"chute", expert ski terrain) counts as
    // ski when DESCENDED at any pace (2026-09-17: the speed heuristic used to downgrade a
    // cautiously skied or side-slipped chute); going up it is ignored. Any other run is ski when
    // descended at ski pace; going up it is ignored, too slow down it is not counted.
    // `selectedActivity` is always "ski" now; the parameter stays so callers keep their shape.
    // Elevation gained in the direction travelled ("down" = along the drawn path): the path's
    // climb going along it, its descent going against it. null when the corridor's elevation
    // isn't known. Feeds a lift ride's or boot pack's vertical (2026-09-30).
    const gainM = descending ? corridor.climbM : corridor.descentM;
    let activity;
    if(corridor.runType==="lift"){
      // A lift ride is a pass in the lift's UPHILL direction. Which way that is comes from the
      // corridor's elevation, not from how it was drawn: the Kicking Horse lifts are drawn
      // bottom-to-top, and the old "only against the drawn direction" rule rejected every real
      // ride up them (2026-09-30). No elevation at all -> the old rule (drawn top-to-bottom).
      const uphillAlong = corridor.climbM!=null && corridor.descentM!=null ? corridor.climbM > corridor.descentM
        : corridor.descentM!=null ? corridor.descentM < 10
        : false;
      if(uphillAlong ? !descending : !ascending) return "rejected"; // downhill lift-line foot traffic isn't a lift ride (silent, as before)
      activity="lift";
    } else if(corridor.runType==="hike"){
      // Only a corridor the author marked as a boot pack counts as a boot pack (2026-10-01).
      activity="hike";
    } else if(corridor.runType==="chute"){
      // Going UP a chute is ignored -- not a boot pack, not a run (2026-10-01; it used to log
      // as a boot pack). Silent, like downhill foot traffic on a lift line.
      if(!descending) return "rejected";
      activity = "ski";
    } else {
      // Any other run: ski when descended at ski pace. Climbing it is ignored (silent); a
      // descent too slow to be skiing it is not counted, and the rider is told why.
      if(!descending) return "rejected";
      if(avgSpeedMps < S.SKI_SPEED_MIN_MPS) return reject("too slow to count as skiing it");
      activity = "ski";
    }

    // Speed plausibility, on the verified pass's own pace: riding a chair up a boot-pack
    // route must not score as a boot pack.
    if(activity==="lift" && avgSpeedMps < S.LIFT_SPEED_MIN_MPS) return reject("too slow to be a lift ride");
    if(activity==="hike" && avgSpeedMps > S.HIKE_SPEED_MAX_MPS) return reject("too fast to be on foot");
    if(corridor.runType==="chute" && descending && avgSpeedMps < S.CHUTE_SPEED_MIN_MPS) return reject("too slow to count as skiing it");
    // A pass of a run that is really a lift line overhead (gondola over a
    // run) isn't a run at all: mostly inside a lift corridor's band = a lift
    // ride. Two ways in:
    //   1. an ascending "hike" — the original case, kept unconditional;
    //   2. ANY pass whose elevation check never ran (trip.elevChecked false).
    // Case 2 is a field report (2026-09-23): riding the gondola up credited
    // the runs underneath as SKIED. Direction here comes purely from the
    // corridor's own geometry (which end zone was reached first), so a run
    // whose "top" end the gondola reaches first — e.g. one authored
    // bottom->top — reads as a DOWN pass, takes the ski branch above at
    // gondola speed, and sailed straight past the old hike-only guard. Phone
    // GPS altitude is usually too poor to contradict it, and the elevation
    // check is SKIPPED (never failed) when altitude is missing, so nothing
    // else caught it either.
    // Deliberately NOT applied when trip.elevChecked is true: real altitude
    // evidence already confirmed a genuine descent/climb and beats this 2D
    // overlap test, so a run legitimately skied directly under a gondola
    // still scores on a device with usable altitude. Only the ambiguous
    // no-altitude case lets the lift band decide.
    // Depends on the resort's lift/gondola line being authored as its own
    // runType:"lift" corridor — same prerequisite Corridor Guard's lift
    // suppression already has (see CLAUDE.md). With no lift corridor
    // recorded, there's nothing to test against and this can't fire.
    if(corridor.runType!=="lift" && ((activity==="hike" && ascending) || !trip.elevChecked)){
      const lifts = ((this && this.corridors) || []).filter(c=>c.runType==="lift" && c.zoneId!==corridor.zoneId);
      if(lifts.length){
        let onLift = 0;
        trip.fixes.forEach(f=>{ if(lifts.some(l=>QGeo.corridorDist([f.lat,f.lon], l, l.ref) < S.LIFT_BAND_EXTRA_M)) onLift++; });
        if(onLift/trip.fixes.length >= S.LIFT_OVERLAP_FRAC){
          return reject(activity==="hike" ? "that was a lift ride, not a boot pack" : "that was a lift ride, not a run");
        }
      }
    }

    // Vertical for scoring. Ski/hike score on descent, so use the corridor's
    // AUTHORED descent (corridor.descentM, the library's elev_loss_m) scaled
    // by how much of the run was actually covered -- deterministic, GPS-
    // altitude-independent, and never null when the run has an authored
    // descent (which killed the old "no altitude fix => 0 points" bug). Sign
    // is negative to match every Math.abs() consumer downstream. Falls back
    // to the legacy smoothed-GPS-altitude delta only for corridors with no
    // authored descent yet. lift = transport (0 pts regardless).
    let verticalM;
    // A boot pack's vertical is what it CLIMBED: the elevation gained in its direction of
    // travel -- the path's climb going along it ("down" = the drawn direction), its descent
    // going against it. Only used when that is known and > 0; otherwise the old rule below.
    const bootPackClimbM = activity==="hike" ? gainM : null;
    if(activity==="lift"){
      // A lift ride's vertical is the elevation it carried you up (the day's total vertical is
      // lifts + boot packs). Unknown elevation -> the phone's own altitude change, else null.
      // Lifts still score 0 points.
      verticalM = (gainM != null && gainM > 0) ? -Math.round(gainM * coverage)
        : (first.alt!=null && last.alt!=null && last.alt > first.alt) ? -Math.round(last.alt-first.alt) : null;
    } else if(bootPackClimbM != null && bootPackClimbM > 0){
      verticalM = -Math.round(bootPackClimbM * coverage);
    } else if(corridor.descentM != null){
      verticalM = -Math.round(corridor.descentM * coverage);
    } else {
      verticalM = (first.alt!=null && last.alt!=null) ? (last.alt-first.alt) : null;
    }

    const run = {
      zoneId: corridor.zoneId, runName: corridor.name, difficulty: corridor.difficulty, runType: corridor.runType,
      activity, startedAt: new Date(trip.tStart).toISOString(), endedAt: new Date(trip.tEnd).toISOString(),
      durationS, verticalM, distanceM: Math.round(distanceM), avgSpeedMps, maxSpeedMps
    };
    return this._offerPass(corridor, run, trip);
  },
  // ---- One descent, one chute (2026-10-03) ----
  // Kicking Horse chutes are drawn 50-100 m wide and many overlap, so one descent could verify
  // two of them (12 pairs on the live map, e.g. Legs Right / Legs Left, Darwin 2 / Darwin 3).
  // A verified pass is a CANDIDATE: when passes of different corridors overlap in time (at least
  // half of the shorter one), only the best fit is logged -- the one whose centreline the track
  // stayed closest to on average (QGeo.meanOffsetM) -- and the rest are reported "not counted,
  // you were on X". A candidate is logged at once when no other chute/run is mid-recording
  // (the usual case: the toast is instant); otherwise it waits up to PASS_SETTLE_MS for a
  // rival to finish. A pass that overlaps one already logged is never logged too. Lifts are
  // never part of this. Pure overlap rule: passesOverlap().
  _offerPass(corridor, run, trip){
    const cand = { corridor, run, fixes:trip.fixes, coverage:trip.coverage, t0:trip.tStart, t1:trip.tEnd,
                   fitM:QGeo.meanOffsetM(corridor, trip.fixes), at:Date.now(), state:"pending" };
    this._passes.push(cand);
    this._settlePasses(false);
    if(cand.state==="pending") setTimeout(()=>{ try{ this._settlePasses(false); }catch(e){} }, QUEST_TUNING.PASS_SETTLE_MS + 100);
    return cand.state==="dropped" ? "rejected" : true;
  },
  _settlePasses(force){
    const now = Date.now();
    this._passes = this._passes.filter(p=>p.state==="pending" || now - p.at < 10*60000);
    for(const c of this._passes){
      if(c.state!=="pending") continue;
      const rivals = this._passes.filter(o=>o!==c && o.state!=="dropped" && passesOverlap(o, c));
      const counted = rivals.find(o=>o.state==="logged");
      if(counted){ this._dropPass(c, counted); continue; }
      const better = rivals.find(o=>o.fitM < c.fitM);
      if(better){ this._dropPass(c, better); continue; }
      if(!force && now < c.at + QUEST_TUNING.PASS_SETTLE_MS && this._rivalRecording(c.corridor.zoneId)) continue;
      c.state = "logged";
      if(this.onCoverage) this.onCoverage(this.riderName(c.corridor.zoneId, c.corridor.name), c.coverage, true);
      this._postRun(c.corridor, c.run, c.fixes);
    }
  },
  _dropPass(c, winner){
    c.state = "dropped";
    if(this.runLog) this.runLog("RUN not counted: \""+c.corridor.name+"\" (off by "+c.fitM.toFixed(1)+" m) -- same descent as \""+winner.corridor.name+"\" ("+winner.fitM.toFixed(1)+" m)");
    if(this.onCoverage) this.onCoverage(this.riderName(c.corridor.zoneId, c.corridor.name), c.coverage, false, "not counted, you were on "+this.riderName(winner.corridor.zoneId, winner.corridor.name));
  },
  // Another chute/run is part-way through a pass right now (its recorder has seen one end).
  _rivalRecording(zoneId){
    return (this.corridors||[]).some(c=>c.zoneId!==zoneId && c.runType!=="lift"
      && this.states[c.zoneId] && this.states[c.zoneId].rec && (this.states[c.zoneId].rec.sawTop || this.states[c.zoneId].rec.sawBottom));
  },
};

root.QuestCore = { TUNING: QUEST_TUNING, QGeo: QGeo, passesOverlap: passesOverlap, runMethods: runMethods };
})(typeof window !== "undefined" ? window : globalThis);
