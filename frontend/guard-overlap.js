/* guard-overlap.js — window.GuardOverlap (2026-10-03)
 *
 * Which chutes / runs overlap a neighbour, for the Fence Editor's ⚙ → "🛡 Guard defaults" list
 * (the author sets an overlapping one Off so it stays off when a rider turns Guard ON).
 *
 * Same rule the 2026-10-03 width shrink used (user's choice): two corridors overlap when their
 * centrelines come closer than (widthA + widthB) / 2 anywhere except the TOP 5% of each line
 * (shared entrances); the bottom counts. The top is the higher end: the drawn start unless the
 * path climbs along its drawn direction (climbM > descentM).
 *
 * Input corridors: { id, name, runType, widthM, path:[[lon,lat],...], descentM?, climbM? }.
 * Output: [{ id, name, runType, widthM, neighbours:[{ id, name, apartM }] }] for every corridor
 * that overlaps at least one other, closest first; neighbours closest first.
 */
(function (root) {
  "use strict";
  var TOP_SKIP = 0.05, STEP_M = 5;

  function prep(c, ref) {
    var mLon = 111320 * Math.cos(ref[1] * Math.PI / 180), mLat = 111320;
    var P = c.path.map(function (q) { return { x: (q[0] - ref[0]) * mLon, y: (q[1] - ref[1]) * mLat }; });
    var cum = [0];
    for (var i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y));
    var L = cum[cum.length - 1];
    var topAtStart = !(c.climbM != null && c.descentM != null && c.climbM > c.descentM);
    var S = [], skip = L * TOP_SKIP;
    for (var k = 1; k < P.length; k++) {
      var A = P[k - 1], B = P[k], l = cum[k] - cum[k - 1];
      for (var s = 0; s < l; s += STEP_M) {
        var at = cum[k - 1] + s, fromTop = topAtStart ? at : L - at;
        if (fromTop >= skip) S.push({ x: A.x + (B.x - A.x) * s / l, y: A.y + (B.y - A.y) * s / l });
      }
    }
    S.push(topAtStart ? P[P.length - 1] : P[0]);   // the bottom end always counts
    var bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    P.forEach(function (p) { bb.x0 = Math.min(bb.x0, p.x); bb.y0 = Math.min(bb.y0, p.y); bb.x1 = Math.max(bb.x1, p.x); bb.y1 = Math.max(bb.y1, p.y); });
    return { c: c, P: P, S: S, bb: bb, w: c.widthM > 0 ? c.widthM : 10 };
  }
  function dist(p, P) {
    var best = Infinity;
    for (var i = 1; i < P.length; i++) {
      var a = P[i - 1], b = P[i], vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
      var t = l2 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(a.x + t * vx - p.x, a.y + t * vy - p.y));
    }
    return best;
  }

  function overlapping(corridors) {
    var cs = (corridors || []).filter(function (c) { return (c.runType === "chute" || c.runType === "run") && c.path && c.path.length >= 2; });
    if (!cs.length) return [];
    var ref = cs[0].path[0];
    var G = cs.map(function (c) { return prep(c, ref); });
    var hits = G.map(function () { return []; });
    for (var i = 0; i < G.length; i++) for (var j = i + 1; j < G.length; j++) {
      var A = G[i], B = G[j], need = (A.w + B.w) / 2;
      if (A.bb.x1 + need < B.bb.x0 || B.bb.x1 + need < A.bb.x0 || A.bb.y1 + need < B.bb.y0 || B.bb.y1 + need < A.bb.y0) continue;
      var d = Infinity, k;
      for (k = 0; k < A.S.length; k++) d = Math.min(d, dist(A.S[k], B.P));
      for (k = 0; k < B.S.length; k++) d = Math.min(d, dist(B.S[k], A.P));
      if (d < need) {
        hits[i].push({ id: B.c.id, name: B.c.name, apartM: Math.round(d) });
        hits[j].push({ id: A.c.id, name: A.c.name, apartM: Math.round(d) });
      }
    }
    var out = [];
    G.forEach(function (g, i) {
      if (!hits[i].length) return;
      hits[i].sort(function (a, b) { return a.apartM - b.apartM; });
      out.push({ id: g.c.id, name: g.c.name, runType: g.c.runType, widthM: g.w, neighbours: hits[i] });
    });
    out.sort(function (a, b) { return a.neighbours[0].apartM - b.neighbours[0].apartM || String(a.name).localeCompare(String(b.name)); });
    return out;
  }

  // Each conflict once: [{ a:{id,name,runType,widthM}, b:{...}, apartM }], closest first.
  function pairs(corridors) {
    var list = overlapping(corridors), byId = {}, seen = {}, out = [];
    list.forEach(function (x) { byId[x.id] = x; });
    list.forEach(function (x) {
      x.neighbours.forEach(function (n) {
        var k = x.id < n.id ? x.id + "|" + n.id : n.id + "|" + x.id;
        if (seen[k]) return;
        seen[k] = true;
        var y = byId[n.id];
        var pick = function (c) { return { id: c.id, name: c.name, runType: c.runType, widthM: c.widthM }; };
        out.push({ a: pick(x), b: pick(y), apartM: n.apartM });
      });
    });
    out.sort(function (p, q) { return p.apartM - q.apartM || String(p.a.name).localeCompare(String(q.a.name)); });
    return out;
  }

  // Widths that stop neighbours overlapping, staying as close to the author's widths as possible
  // (2026-10-04, GPX Editor "Fit widths to neighbours"; same rule as the 2026-10-03 one-off run):
  // for every overlapping pair, both are scaled down by the same factor until their edges just
  // meet (apart >= (wA+wB)/2), repeated until nothing changes; never wider than the author's
  // width; never below floorM (20 m: narrower and normal GPS wobble sets Guard's tone off and on)
  // unless the author drew it narrower. Lines closer than the floor allows simply stay at the
  // floor (they still overlap — Guard defaults handles those).
  // Returns [{ id, name, runType, oldWidthM, newWidthM }] for the ones that change.
  function fitWidths(corridors, floorM) {
    floorM = floorM == null ? 20 : floorM;
    var ps = pairs(corridors);
    var w = {}, orig = {}, names = {}, types = {};
    (corridors || []).forEach(function (c) { var x = c.widthM > 0 ? c.widthM : 10; w[c.id] = x; orig[c.id] = x; names[c.id] = c.name; types[c.id] = c.runType; });
    for (var it = 0; it < 100; it++) {
      var changed = false;
      ps.forEach(function (p) {
        var s = (w[p.a.id] + w[p.b.id]) / 2;
        if (s > p.apartM + 0.01) { var f = p.apartM / s; w[p.a.id] *= f; w[p.b.id] *= f; changed = true; }
      });
      if (!changed) break;
    }
    var out = [];
    Object.keys(w).forEach(function (id) {
      var nw = Math.min(orig[id], Math.max(Math.min(floorM, orig[id]), Math.floor(w[id])));
      if (nw !== orig[id]) out.push({ id: id, name: names[id], runType: types[id], oldWidthM: orig[id], newWidthM: nw });
    });
    out.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    return out;
  }

  var api = { overlapping: overlapping, pairs: pairs, fitWidths: fitWidths };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.GuardOverlap = api;
})(typeof window !== "undefined" ? window : this);
