/* Corridor Guard boundary lines — the TRUE trigger boundary, smooth (window.GuardEdge).

   Why this exists: the yellow "you're about to cross the line" lines used to be
   the corridor centreline pushed sideways with MapLibre's `line-offset`. That
   shifts every vertex along its own normal, so on a wide chute (50-100 m) that
   bends, the INSIDE of each bend folds over itself into loops and the outside
   grows spikes at every kink in the recorded GPS track — "any change in
   direction causes a weird line". A Bézier through those offset vertices would
   just smooth the loops, so the fix is trim first, then smooth:

     1. Offset each side of the centreline by edgeM (= widthM/2 + the guard's
        outside buffer, the exact distance chute-guard.js decides the tone at),
        with a ROUND join (an arc) on the outside of every bend.
     2. Trim: drop every point closer than edgeM to any part of the centreline —
        that is the folded-over inside-of-bend loop; what remains is exactly the
        boundary of the region the guard treats as "on the corridor".
     3. Stitch the surviving pieces back into one continuous line.
     4. Smooth with Catmull-Rom expressed as cubic Béziers through points ~5 m
        apart, sampled every ~1.5 m, then Douglas-Peucker thin it to 0.2 m.

   Measured on all 87 Kicking Horse corridors: one continuous line per side for
   every one, and the drawn line is within 0.23 m of the true trigger distance
   for 99% of points (worst 0.94 m — GPS itself is good to 5-10 m).

   Pure geometry, no DOM/MapLibre — unit-tested in tests/guard-edge.test.js. */
(function(){
  "use strict";
  const M_LAT = 111320;
  const TUNING = {
    ARC_STEP_DEG: 8,     // round-join arc resolution on the outside of a bend
    DENSIFY_M: 1.5,      // sampling of the raw offset curve before trimming
    TRIM_TOL_M: 0.25,    // a point counts as "inside" only if closer than edgeM - this
    STITCH_GAP_M: 8,     // pieces whose ends are this close are joined into one line
    DECIMATE_M: 5,       // Bézier control points this far apart
    SAMPLE_M: 1.5,       // Bézier sampling
    SIMPLIFY_M: 0.2,     // Douglas-Peucker tolerance on the final line
    DEFAULT_BUFFER_M: 0.5 // chute-guard.js TUNING.OUTSIDE_BUFFER_M
  };

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function distToSeg(p, a, b){
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx*dx + dy*dy;
    if(!L2) return dist(p, a);
    let t = ((p.x - a.x)*dx + (p.y - a.y)*dy) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(p.x - (a.x + t*dx), p.y - (a.y + t*dy));
  }
  function distToPoly(p, P){
    let m = Infinity;
    for(let i = 0; i < P.length - 1; i++){ const d = distToSeg(p, P[i], P[i+1]); if(d < m) m = d; }
    return m;
  }

  // Offset one side of the centreline by d, with a round join on the OUTSIDE of each bend.
  // side = +1 (left of travel) or -1 (right). The inside of a bend is left to fold over
  // itself on purpose — trim() removes exactly that.
  function rawOffset(P, d, side){
    const out = [];
    let pux = 0, puy = 0, pnx = 0, pny = 0, have = false;
    for(let i = 0; i < P.length - 1; i++){
      const a = P[i], b = P[i+1], L = dist(a, b);
      if(L < 1e-6) continue;
      const ux = (b.x - a.x)/L, uy = (b.y - a.y)/L, nx = side * -uy, ny = side * ux;
      if(have && (pux*uy - puy*ux) * side < 0){          // outside of the bend: arc from the previous normal to this one
        const a0 = Math.atan2(pny, pnx);
        let da = Math.atan2(ny, nx) - a0;
        while(da >  Math.PI) da -= 2*Math.PI;
        while(da < -Math.PI) da += 2*Math.PI;
        const n = Math.max(1, Math.ceil(Math.abs(da) * 180 / Math.PI / TUNING.ARC_STEP_DEG));
        for(let k = 1; k < n; k++){ const t = a0 + da*k/n; out.push({ x: a.x + Math.cos(t)*d, y: a.y + Math.sin(t)*d }); }
      }
      out.push({ x: a.x + nx*d, y: a.y + ny*d });
      out.push({ x: b.x + nx*d, y: b.y + ny*d });
      pux = ux; puy = uy; pnx = nx; pny = ny; have = true;
    }
    return out;
  }
  function densify(pts, step){
    const o = [];
    for(let i = 0; i < pts.length - 1; i++){
      const a = pts[i], b = pts[i+1], n = Math.max(1, Math.ceil(dist(a, b) / step));
      for(let k = 0; k < n; k++) o.push({ x: a.x + (b.x - a.x)*k/n, y: a.y + (b.y - a.y)*k/n });
    }
    if(pts.length) o.push(pts[pts.length - 1]);
    return o;
  }
  // Keep only points that are NOT inside the buffer; return the contiguous runs.
  function trim(dense, P, d){
    const runs = []; let cur = [];
    dense.forEach(p => {
      if(distToPoly(p, P) >= d - TUNING.TRIM_TOL_M) cur.push(p);
      else { if(cur.length > 1) runs.push(cur); cur = []; }
    });
    if(cur.length > 1) runs.push(cur);
    return runs;
  }
  function stitch(runs){
    const out = [];
    runs.forEach(r => {
      const last = out[out.length - 1];
      if(last && dist(last[last.length - 1], r[0]) <= TUNING.STITCH_GAP_M) last.push.apply(last, r);
      else out.push(r.slice());
    });
    return out;
  }
  // Catmull-Rom → cubic Bézier through decimated points; passes THROUGH them, so it stays on the boundary.
  function bezierSmooth(pts){
    if(pts.length < 3) return pts;
    const D = [pts[0]]; let acc = 0;
    for(let i = 1; i < pts.length - 1; i++){
      acc += dist(pts[i-1], pts[i]);
      if(acc >= TUNING.DECIMATE_M){ D.push(pts[i]); acc = 0; }
    }
    D.push(pts[pts.length - 1]);
    if(D.length < 3) return pts;
    const out = [];
    for(let i = 0; i < D.length - 1; i++){
      const p0 = D[Math.max(0, i-1)], p1 = D[i], p2 = D[i+1], p3 = D[Math.min(D.length-1, i+2)];
      const c1x = p1.x + (p2.x - p0.x)/6, c1y = p1.y + (p2.y - p0.y)/6;
      const c2x = p2.x - (p3.x - p1.x)/6, c2y = p2.y - (p3.y - p1.y)/6;
      const n = Math.max(2, Math.ceil(dist(p1, p2) / TUNING.SAMPLE_M));
      for(let k = 0; k < n; k++){
        const t = k/n, u = 1 - t;
        out.push({ x: u*u*u*p1.x + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*p2.x,
                   y: u*u*u*p1.y + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*p2.y });
      }
    }
    out.push(D[D.length - 1]);
    return out;
  }
  function simplify(pts, tol){                                   // Douglas-Peucker, iterative
    if(pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length-1] = 1;
    const stack = [[0, pts.length - 1]];
    while(stack.length){
      const [s, e] = stack.pop(); let maxD = 0, idx = -1;
      for(let i = s + 1; i < e; i++){ const d = distToSeg(pts[i], pts[s], pts[e]); if(d > maxD){ maxD = d; idx = i; } }
      if(idx > -1 && maxD > tol){ keep[idx] = 1; stack.push([s, idx], [idx, e]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // pathLatLon: [[lat,lon],...]  edgeM: metres from the centreline to the trigger boundary.
  // Returns { left:[polyline,...], right:[polyline,...] }, each polyline [[lon,lat],...] (GeoJSON order).
  function outline(pathLatLon, edgeM){
    const empty = { left: [], right: [] };
    if(!pathLatLon || pathLatLon.length < 2 || !(edgeM > 0)) return empty;
    const lat0 = pathLatLon[0][0], lon0 = pathLatLon[0][1], mLon = M_LAT * Math.cos(lat0 * Math.PI / 180);
    const P = pathLatLon.map(p => ({ x: (p[1] - lon0) * mLon, y: (p[0] - lat0) * M_LAT }));
    const toLL = q => [ +(lon0 + q.x / mLon).toFixed(7), +(lat0 + q.y / M_LAT).toFixed(7) ];
    const side = s => stitch(trim(densify(rawOffset(P, edgeM, s), TUNING.DENSIFY_M), P, edgeM))
      .map(r => simplify(bezierSmooth(r), TUNING.SIMPLIFY_M))
      .filter(r => r.length > 1)
      .map(r => r.map(toLL));
    return { left: side(1), right: side(-1) };
  }

  // corridors: [{ zoneId|id, path:[[lat,lon],...], widthM, runType }]. Lifts are never alertable, so skipped.
  // Mirrors chute-guard.js: a missing/invalid width counts as 10 m.
  function featureCollection(corridors, bufferM){
    const buf = bufferM != null ? bufferM : TUNING.DEFAULT_BUFFER_M;
    const features = [];
    (corridors || []).forEach(c => {
      if(c.runType === "lift" || !c.path || c.path.length < 2) return;
      const w = Number(c.widthM), widthM = (isFinite(w) && w > 0) ? w : 10;
      const o = outline(c.path, widthM/2 + buf);
      const lines = o.left.concat(o.right);
      if(!lines.length) return;
      features.push({ type: "Feature", properties: { id: c.zoneId != null ? c.zoneId : c.id },
        geometry: { type: "MultiLineString", coordinates: lines } });
    });
    return { type: "FeatureCollection", features };
  }

  // The one layer that draws them: solid yellow, round caps/joins, visible only where feature-state
  // `guardEdges` is true (so a Guard toggle never reloads data — see ridge-quest.html applyGuardState).
  function layer(id, source){
    return { id, type: "line", source,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#ffe600",
        "line-opacity": ["case", ["boolean", ["feature-state", "guardEdges"], false], 1, 0],
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2, 15, 2.6, 18, 3.2]
      } };
  }

  window.GuardEdge = { outline, featureCollection, layer, TUNING };
})();
