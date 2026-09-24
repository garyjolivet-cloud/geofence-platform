/* Ridge Quest visuals (2026-09-24): today's ski track, "skied" stripe, completion moment,
   time-of-day light. Everything here is deliberately light on the GPU and free of any
   speed or turn metric — riders are shown WHERE they skied and HOW MANY chutes, never how fast.

   window.RidgeVisuals = {
     TRACK, createTrack(storage, dayKey),      today's breadcrumb (decimated, persisted per day)
     trackFeatureCollection(segs),             one MultiLineString for a single tiny source
     trackLayer(id, source), skiedLayer(id, source),
     completion(run, skiedSet, corridors),     { text, sub, isNew, n, total } for the toast
     sunPosition(date, lat, lon), hillshadeLight(date, lat, lon),
     celebrate(doc, {text, sub})               fading overlay, pointer-events none
     CHUTE_LINE, smoothLine(lonlats),          saved chute lines: jitter-smoothed S-curves
     chuteLineColors(lines), chuteLinesFeatureCollection(lines, colors, smoothed), chuteLinesLayer(id, source)
   }
*/
(function (root) {
  "use strict";

  var TRACK = {
    MIN_STEP_M: 8,          // fixes closer than this to the last kept point add nothing but map work
    ACCURACY_CAP_M: 40,     // same cap Ridge Quest uses for fog reveal
    MAX_POINTS: 4000,       // a long day; beyond this every second point is dropped
    GAP_MS: 90000,          // no accepted fix for this long (phone asleep, tunnel) -> start a new segment
    SAVE_EVERY_MS: 30000
  };

  function haversineM(a, b) {
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (b[1] - a[1]) * toRad, dLon = (b[0] - a[0]) * toRad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function totalPoints(segs) { return segs.reduce(function (n, s) { return n + s.length; }, 0); }

  function thin(segs) {
    return segs.map(function (s) {
      return s.filter(function (_, i) { return i % 2 === 0 || i === s.length - 1; });
    });
  }

  // storage: {getItem,setItem} (localStorage-like, may throw); dayKey: () => "YYYY-MM-DD".
  function createTrack(storage, dayKey) {
    var KEY = "rq.track";
    var state = { day: dayKey(), segs: [] };
    var lastT = 0, lastSave = 0, open = false;

    function load() {
      try {
        var raw = JSON.parse(storage.getItem(KEY) || "null");
        if (raw && raw.day === dayKey() && Array.isArray(raw.segs)) state = { day: raw.day, segs: raw.segs };
      } catch (e) {}
      open = false;
    }
    function save(force) {
      var now = Date.now();
      if (!force && now - lastSave < TRACK.SAVE_EVERY_MS) return;
      lastSave = now;
      try { storage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    }
    // fix: {lat, lon, acc, t}; onLift: true while riding a lift (those fixes are not "skiing").
    function add(fix, onLift) {
      if (!fix || fix.lat == null || fix.lon == null) return false;
      if (state.day !== dayKey()) state = { day: dayKey(), segs: [] };
      if (onLift) { open = false; return false; }
      if (fix.acc != null && fix.acc > TRACK.ACCURACY_CAP_M) return false;
      var pt = [fix.lon, fix.lat];
      var seg = open ? state.segs[state.segs.length - 1] : null;
      if (seg && fix.t - lastT > TRACK.GAP_MS) seg = null;
      if (seg) {
        if (haversineM(seg[seg.length - 1], pt) < TRACK.MIN_STEP_M) return false;
        seg.push(pt);
      } else {
        state.segs.push([pt]);
        open = true;
      }
      lastT = fix.t;
      if (totalPoints(state.segs) > TRACK.MAX_POINTS) state.segs = thin(state.segs);
      save(false);
      return true;
    }
    return {
      load: load, add: add, save: save,
      segments: function () { return state.segs; },
      clear: function () { state = { day: dayKey(), segs: [] }; open = false; save(true); }
    };
  }

  function trackFeatureCollection(segs) {
    var lines = (segs || []).filter(function (s) { return s.length >= 2; });
    return { type: "FeatureCollection", features: lines.length ? [{
      type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: lines }
    }] : [] };
  }

  // One calm colour, thin, under the run lines — where you skied, nothing about how fast.
  function trackLayer(id, source) {
    return {
      id: id, type: "line", source: source,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#8fe3ff", "line-opacity": 0.8,
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.4, 16, 2.4, 18, 3.4]
      }
    };
  }

  // A light stripe down the middle of a chute you have skied today. Drawn from the same
  // source as the run lines, keyed by feature-state (never setData), so it costs one layer.
  // `flash` (set for ~2 s on completion) turns it gold and fat. ONE zoom curve only.
  function skiedLayer(id, source) {
    var skied = ["boolean", ["feature-state", "skied"], false];
    var flash = ["boolean", ["feature-state", "flash"], false];
    function w(base) { return ["case", flash, base * 2.6, base]; }
    return {
      id: id, type: "line", source: source,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["case", flash, "#ffd23c", "#f4fbff"],
        "line-opacity": ["case", skied, 0.95, 0],
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, w(1), 15, w(1.5), 18, w(2.2)]
      }
    };
  }

  function label(runType) {
    return runType === "chute" ? "Chute" : runType === "hike" ? "Hike" : "Run";
  }

  // Toast content when a run has just been logged. skiedSet holds zone ids ALREADY skied
  // today (before this run); corridors is Quest.corridors. Lifts return null.
  function completion(run, skiedSet, corridors) {
    if (!run || run.runType === "lift" || run.activity === "lift") return null;
    var type = run.runType || "run";
    var total = (corridors || []).filter(function (c) { return c.runType === type; }).length;
    var isNew = !skiedSet.has(run.zoneId);
    var n = skiedSet.size + (isNew ? 1 : 0);
    if (type !== "chute") {
      // Only chutes are tracked as a "N of M" day list; other runs just get their name.
      return { text: label(type) + " complete", sub: run.runName || "", isNew: isNew, n: null, total: null };
    }
    return {
      text: isNew ? label(type) + " " + n + " of " + total : label(type) + " again",
      sub: run.runName || "", isNew: isNew, n: n, total: total
    };
  }

  // NOAA-style low-precision solar position. azimuth: degrees clockwise from north.
  function sunPosition(date, lat, lon) {
    var rad = Math.PI / 180;
    var d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
    var g = (357.529 + 0.98560028 * d) % 360;
    var q = (280.459 + 0.98564736 * d) % 360;
    var L = q + 1.915 * Math.sin(g * rad) + 0.02 * Math.sin(2 * g * rad);
    var e = 23.439 - 0.00000036 * d;
    var RA = Math.atan2(Math.cos(e * rad) * Math.sin(L * rad), Math.cos(L * rad)) / rad;
    var dec = Math.asin(Math.sin(e * rad) * Math.sin(L * rad)) / rad;
    var gmstDeg = ((18.697374558 + 24.06570982441908 * d) % 24) * 15;
    var H = ((gmstDeg + lon - RA) % 360 + 540) % 360 - 180;   // hour angle, -180..180
    var latR = lat * rad, decR = dec * rad, HR = H * rad;
    var alt = Math.asin(Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(HR)) / rad;
    var az = Math.atan2(Math.sin(HR), Math.cos(HR) * Math.sin(latR) - Math.tan(decR) * Math.cos(latR)) / rad + 180;
    return { altitude: alt, azimuth: ((az % 360) + 360) % 360 };
  }

  // Hillshade paint that follows the real sun: light from the sun's azimuth (anchored to the
  // MAP so it doesn't swing as the phone rotates the view), longer/deeper shading when the
  // sun is low, a warm highlight near sunrise/sunset. Below the horizon: the default look.
  function hillshadeLight(date, lat, lon) {
    var s = sunPosition(date, lat, lon);
    if (s.altitude <= 0) {
      return { direction: 335, exaggeration: 0.45, highlight: "#ffffff", altitude: s.altitude };
    }
    var low = Math.max(0, Math.min(1, 1 - s.altitude / 40));      // 0 high sun .. 1 sun on the horizon
    return {
      direction: Math.round(s.azimuth),
      exaggeration: Math.round((0.35 + 0.35 * low) * 100) / 100,
      highlight: low > 0.7 ? "#ffe9c7" : "#ffffff",
      altitude: s.altitude
    };
  }

  // Brief overlay: text fades in, holds, fades out, removes itself. Never blocks touches.
  function celebrate(doc, c) {
    if (!doc || !c) return null;
    var el = doc.createElement("div");
    el.setAttribute("role", "status");
    el.style.cssText = "position:fixed;left:50%;top:22%;transform:translateX(-50%) scale(.94);z-index:2000;" +
      "pointer-events:none;text-align:center;padding:14px 22px;border-radius:14px;opacity:0;" +
      "background:rgba(10,16,24,.92);border:1px solid rgba(255,210,60,.7);color:#f4fbff;" +
      "transition:opacity .35s ease, transform .35s ease;max-width:86vw";
    var t = doc.createElement("div");
    t.style.cssText = "font:400 26px 'Black Han Sans',system-ui,sans-serif;color:#ffd23c;letter-spacing:.3px";
    t.textContent = c.text;
    el.appendChild(t);
    if (c.sub) {
      var s = doc.createElement("div");
      s.style.cssText = "font:600 14px system-ui,sans-serif;margin-top:4px;color:#dbe7f4";
      s.textContent = c.sub;
      el.appendChild(s);
    }
    doc.body.appendChild(el);
    root.setTimeout(function () { el.style.opacity = "1"; el.style.transform = "translateX(-50%) scale(1)"; }, 30);
    root.setTimeout(function () { el.style.opacity = "0"; }, 2100);
    root.setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2600);
    return el;
  }

  // ---- Saved chute lines (2026-09-24) ----
  // A rider's stored line for a chute is the raw verified pass (~1 fix/s, kept every >= 3 m,
  // 5-10 m GPS error), which draws as a zig-zag. smoothLine turns it into the S-curve a
  // skier actually makes: (1) Gaussian smoothing along the path removes GPS jitter,
  // (2) a centripetal Catmull-Rom spline through the result rounds each turn without loops,
  // (3) Douglas-Peucker drops points that add nothing. It is a plausible shape of the line
  // taken, not an exact trace of every turn -- 1 Hz GPS cannot resolve that.
  var CHUTE_LINE = {
    // Gaussian width along the path; bigger = smoother but flattens real turns. Measured on a
    // synthetic 1 Hz S-turn line (8 m/s, 12 m wide turns): 6 m cut the sharpest corner with
    // 4 m GPS noise from 121 to 52 deg per 1.5 m and kept ~85% of a clean turn's width;
    // 3 m reached no neighbours at ski speed (fixes ~8 m apart), 9 m kept only ~70%.
    SIGMA_M: 6,
    SAMPLE_M: 1.5,       // spline sampling step
    SIMPLIFY_M: 0.3,     // Douglas-Peucker tolerance on the final line
    DEFAULT_VISIBLE: 3,  // newest N per chute start switched on (the server applies the same rule)
    // Cycled newest-first per chute. Avoids the difficulty colours, guard yellow, armed cyan
    // and the day-track aqua so a saved line is never mistaken for any of them.
    COLORS: ["#ff5fa2", "#ff9f1c", "#c77dff", "#ffffff", "#c6ff00", "#ff4d4d"]
  };

  function toLocal(lonlats) {
    var lat0 = 0, lon0 = 0, n = lonlats.length;
    lonlats.forEach(function (p) { lon0 += p[0] / n; lat0 += p[1] / n; });
    var ky = 111320, kx = 111320 * Math.cos(lat0 * Math.PI / 180);
    return {
      pts: lonlats.map(function (p) { return { x: (p[0] - lon0) * kx, y: (p[1] - lat0) * ky }; }),
      back: function (q) { return [lon0 + q.x / kx, lat0 + q.y / ky]; }
    };
  }
  function d2(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }

  // Weighted average of neighbours by distance ALONG the path; the two endpoints are pinned.
  function gaussianAlong(P, sigma) {
    var s = [0];
    for (var i = 1; i < P.length; i++) s.push(s[i - 1] + d2(P[i - 1], P[i]));
    var reach = 3 * sigma, out = [P[0]];
    function w(ds) { return Math.exp(-ds * ds / (2 * sigma * sigma)); }
    for (var k = 1; k < P.length - 1; k++) {
      var sx = 0, sy = 0, sw = 0, j, wt;
      for (j = k; j >= 0 && s[k] - s[j] <= reach; j--) { wt = w(s[k] - s[j]); sx += wt * P[j].x; sy += wt * P[j].y; sw += wt; }
      for (j = k + 1; j < P.length && s[j] - s[k] <= reach; j++) { wt = w(s[j] - s[k]); sx += wt * P[j].x; sy += wt * P[j].y; sw += wt; }
      out.push({ x: sx / sw, y: sy / sw });
    }
    out.push(P[P.length - 1]);
    return out;
  }

  // Centripetal (alpha 0.5) Catmull-Rom, Barry-Goldman form: no cusps or self-loops on
  // unevenly spaced points, and the curve passes through every control point.
  function catmullRom(P, step) {
    if (P.length < 3) return P.slice();
    function lerp(a, b, ta, tb, t) {
      var d = tb - ta; if (d < 1e-9) return { x: a.x, y: a.y };
      var u = (t - ta) / d; return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
    function knot(a, b) { return Math.max(Math.sqrt(d2(a, b)), 1e-4); }
    var out = [];
    for (var i = 0; i < P.length - 1; i++) {
      var p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
      var t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
      var n = Math.max(1, Math.ceil(d2(p1, p2) / step));
      for (var k = 0; k < n; k++) {
        var t = t1 + (t2 - t1) * k / n;
        var a1 = lerp(p0, p1, t0, t1, t), a2 = lerp(p1, p2, t1, t2, t), a3 = lerp(p2, p3, t2, t3, t);
        var b1 = lerp(a1, a2, t0, t2, t), b2 = lerp(a2, a3, t1, t3, t);
        out.push(lerp(b1, b2, t1, t2, t));
      }
    }
    out.push(P[P.length - 1]);
    return out;
  }

  function segDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    var t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
    return d2(p, { x: a.x + t * dx, y: a.y + t * dy });
  }
  function douglasPeucker(P, tol) {
    if (P.length < 3) return P;
    var keep = new Uint8Array(P.length); keep[0] = keep[P.length - 1] = 1;
    var stack = [[0, P.length - 1]];
    while (stack.length) {
      var se = stack.pop(), maxD = 0, idx = -1;
      for (var i = se[0] + 1; i < se[1]; i++) { var d = segDist(P[i], P[se[0]], P[se[1]]); if (d > maxD) { maxD = d; idx = i; } }
      if (idx > -1 && maxD > tol) { keep[idx] = 1; stack.push([se[0], idx], [idx, se[1]]); }
    }
    return P.filter(function (_, i) { return keep[i]; });
  }

  // lonlats: [[lon,lat],...] -> smoothed [[lon,lat],...]; endpoints are kept exactly.
  function smoothLine(lonlats) {
    var pts = (lonlats || []).filter(function (p) { return p && isFinite(p[0]) && isFinite(p[1]); });
    if (pts.length < 3) return pts.map(function (p) { return [p[0], p[1]]; });
    var L = toLocal(pts);
    var P = [L.pts[0]];
    for (var i = 1; i < L.pts.length; i++) if (d2(P[P.length - 1], L.pts[i]) > 0.01) P.push(L.pts[i]);   // drop repeats
    if (P.length < 3) return P.map(L.back);
    var out = douglasPeucker(catmullRom(gaussianAlong(P, CHUTE_LINE.SIGMA_M), CHUTE_LINE.SAMPLE_M), CHUTE_LINE.SIMPLIFY_M);
    return out.map(L.back);
  }

  // lines: [{id, zoneId, startedAt, visible}] -> {id: colour} for the visible ones, cycled
  // newest-first within each chute. Hidden entries get no colour (the list shows them grey),
  // so the swatch in "Your chutes" always matches the line on the map.
  function chuteLineColors(lines) {
    var byZone = {}, out = {};
    (lines || []).forEach(function (l) { if (l.visible) (byZone[l.zoneId] = byZone[l.zoneId] || []).push(l); });
    Object.keys(byZone).forEach(function (z) {
      byZone[z].sort(function (a, b) { return a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0; })
        .forEach(function (l, i) { out[l.id] = CHUTE_LINE.COLORS[i % CHUTE_LINE.COLORS.length]; });
    });
    return out;
  }

  // lines: already filtered to what should be drawn; smoothed(line) -> [[lon,lat],...].
  function chuteLinesFeatureCollection(lines, colors, smoothed) {
    return { type: "FeatureCollection", features: (lines || []).map(function (l) {
      var c = colors[l.id] ? smoothed(l) : null;
      if (!c || c.length < 2) return null;
      return { type: "Feature", properties: { id: l.id, color: colors[l.id] }, geometry: { type: "LineString", coordinates: c } };
    }).filter(Boolean) };
  }

  function chuteLinesLayer(id, source) {
    return {
      id: id, type: "line", source: source,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"], "line-opacity": 0.95,
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.8, 16, 3, 18, 4.5]
      }
    };
  }

  root.RidgeVisuals = {
    TRACK: TRACK, createTrack: createTrack, trackFeatureCollection: trackFeatureCollection,
    trackLayer: trackLayer, skiedLayer: skiedLayer, completion: completion,
    sunPosition: sunPosition, hillshadeLight: hillshadeLight, celebrate: celebrate,
    CHUTE_LINE: CHUTE_LINE, smoothLine: smoothLine, chuteLineColors: chuteLineColors,
    chuteLinesFeatureCollection: chuteLinesFeatureCollection, chuteLinesLayer: chuteLinesLayer
  };
})(typeof window !== "undefined" ? window : globalThis);
