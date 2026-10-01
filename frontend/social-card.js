/* Ridge Quest — "Social media export" (2026-09-30).

   Draws a marketing-grade image of a rider's day (or season) for Instagram / Facebook:
   a real 3D winter satellite view of the mountain with the rider's own track, chutes and lift
   lines on it, the big numbers under it, and the Ridge Quest logo. Drawn in the browser on an
   HTML canvas (no Canva account, works on every phone), saved through the phone's share sheet
   ("Save Image" to Photos, or post straight to a Story) or downloaded on a computer.

   Used by ridge-quest.html (the rider's real data) and fence-editor.html's "📸 Social" test
   screen (fake data — it is fall, nobody can ride). Plain script, window.SocialCard.

     SocialCard.FORMATS                       story 1080x1920, wide 1200x630 (Facebook link)
     SocialCard.collectDay(api, ctx)          -> data   (real rider data, today)
     SocialCard.collectSeason(api, ctx)       -> data   (real rider data, this ski season)
     SocialCard.testDay(corridors)            -> data   (10 gondola + 10 Stairway + 3 boot packs)
     SocialCard.testSeason(corridors)         -> data
     SocialCard.make(data, format, opts)      -> Promise<{canvas, blob, filename}>
     SocialCard.draw(ctx, data, format, hero) -> draws one card (pure 2D canvas, testable)
     SocialCard.pngWithText(bytes, meta)      -> PNG bytes with iTXt metadata chunks
     SocialCard.shareOrSave(blob, filename, text)

   House rules (Ridge Quest): never show or reward SPEED, no turn counts. The day's total
   vertical is lifts + boot packs (what you went up), never chute descents.
*/
(function (root) {
  "use strict";

  var FORMATS = {
    story: { w: 1080, h: 1920, heroW: 1080, heroH: 980, label: "Story (Instagram / Facebook)" },
    wide:  { w: 1200, h: 630,  heroW: 660,  heroH: 630,  label: "Facebook post" }
  };
  var COL = {
    night: "#0a1018", night2: "#121c2a", snow: "#f4f8fb", fog: "#9fb0c2",
    coral: "#ff6a3d", coral2: "#ff9166", ice: "#7fd8ff", gold: "#ffcf4a", go: "#7ee08a",
    green: "#3ecf6e", blue: "#3d8bff", black: "#0b0f14"
  };
  var RESORT = "Kicking Horse";
  var LOCATION = "Kicking Horse Mountain Resort, Golden BC, Canada";
  var TAGLINE = "Live to ski. Ski to live.";
  var DIFF_RANK = { "double-black": 4, black: 3, blue: 2, green: 1 };

  // ---------------------------------------------------------------- helpers
  function fmtInt(n) { return Math.round(n || 0).toLocaleString("en-US"); }
  function fmtM(n) { return fmtInt(n) + " m"; }
  function plural(n, one, many) { return n === 1 ? one : many; }
  function shortLift(name) {
    return String(name || "Lift").replace(/\s+(Gondi|Gondola)$/i, " Gondola").replace(/Chairt$/i, "Chair").trim();
  }
  function seeded(seed) {           // deterministic test data
    var s = seed >>> 0 || 1;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  function hav(a, b) {              // a, b = [lat, lon]
    var R = 6371000, r = Math.PI / 180, dp = (b[0] - a[0]) * r, dl = (b[1] - a[1]) * r;
    var x = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function lonlat(path) { return (path || []).map(function (p) { return [p[1], p[0]]; }); }
  // A lift's uphill end: elevation decides (lifts are drawn either way), else the drawn end.
  function liftTopIndex(c) {
    if (c.climbM != null && c.descentM != null) return c.climbM >= c.descentM ? c.path.length - 1 : 0;
    if (c.descentM != null) return c.descentM < 10 ? c.path.length - 1 : 0;
    return c.path.length - 1;
  }
  function liftGain(c) {
    var g = c.climbM != null && c.descentM != null ? Math.max(c.climbM, c.descentM) : (c.climbM != null ? c.climbM : c.descentM);
    return g != null ? g : 0;
  }
  function boundsOf(paths) {
    var b = null;
    paths.forEach(function (p) {
      (p || []).forEach(function (q) {           // q = [lon, lat]
        if (!b) b = [q[0], q[1], q[0], q[1]];
        else { b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); }
      });
    });
    return b;
  }

  // ------------------------------------------------------------ data model
  // {
  //   kind: "day" | "season", dateLabel, resort, rider,
  //   verticalM (lifts + boot packs), points,
  //   runs: n ski runs, chutes: [{name, difficulty, count}], chuteCount,
  //   bootPacks: {count, verticalM, routes:[{name,count,verticalM}]},
  //   lifts: [{name, count, verticalM}], liftRides,
  //   weather: {snow24, tempC, windKph, windDir} | null,
  //   season: {days, verticalM} | null   (the small season line on a day card),
  //   days (season card only),
  //   geo: { track:[[ [lon,lat]... ]], chutes:[path], lifts:[{name, path}], bootPacks:[path] }
  // }
  function liftList(rows) {
    return (rows || []).map(function (r) { return { name: shortLift(r.name), count: r.count, verticalM: Math.round(r.verticalM || 0) }; });
  }
  function geoFor(corridors, names) {
    var byId = {};
    (corridors || []).forEach(function (c) { byId[c.zoneId] = c; });
    return function (ids) { return ids.map(function (id) { return byId[id]; }).filter(Boolean); };
  }

  // Real data, today. `ctx` = { playerId, rider, corridors, track (RQTrack.segments()), dayKey(isoString)->"YYYY-MM-DD", today:"YYYY-MM-DD" }
  async function collectDay(api, ctx) {
    var pid = encodeURIComponent(ctx.playerId);
    var get = function (p) { return api(p).catch(function () { return null; }); };
    var res = await Promise.all([
      get("/api/players/" + pid + "/runs?limit=200"),
      get("/api/players/" + pid + "/chutes/daily"),
      get("/api/players/" + pid + "/bootpacks/daily"),
      get("/api/players/" + pid + "/lifts/daily"),
      get("/api/weather"),
      get("/api/snow-history"),
      get("/api/players/" + pid + "/bootpacks/season"),
      get("/api/players/" + pid + "/lifts/season"),
      get("/api/players/" + pid + "/stats")
    ]);
    var runs = ((res[0] && res[0].runs) || []).filter(function (r) { return ctx.dayKey(r.started_at) === ctx.today; });
    var ski = runs.filter(function (r) { return r.activity === "ski"; });
    var chutes = ((res[1] && res[1].chutes) || []).map(function (c) { return { name: c.name, difficulty: c.difficulty, count: c.count, zoneId: c.zoneId }; });
    var bp = res[2] || {}, lf = res[3] || {}, w = res[4] || {}, snow = res[5] || [];
    var pick = geoFor(ctx.corridors);
    var seasonV = ((res[6] && res[6].season && res[6].season.verticalM) || 0) + ((res[7] && res[7].season && res[7].season.verticalM) || 0);
    var days = ((res[8] && res[8].days) || []).filter(function (d) { return d.season_id === ctx.seasonId && (d.runs_count > 0 || d.lift_rides > 0 || d.hikes > 0); }).length;
    return {
      kind: "day", dateLabel: ctx.dateLabel, resort: RESORT, rider: ctx.rider || "",
      verticalM: ((bp.today && bp.today.verticalM) || 0) + ((lf.today && lf.today.verticalM) || 0),
      points: runs.reduce(function (s, r) { return s + (r.points || 0); }, 0),
      runs: ski.length,
      chutes: chutes, chuteCount: chutes.length,
      bootPacks: { count: (bp.today && bp.today.count) || 0, verticalM: (bp.today && bp.today.verticalM) || 0, routes: bp.routes || [] },
      lifts: liftList(lf.routes), liftRides: (lf.today && lf.today.count) || 0,
      weather: (w && !w.error) || (snow && snow.length) ? {
        snow24: snow && snow.length ? snow[0].hn24_cm : null,
        tempC: w && w.ww_temp_c != null ? w.ww_temp_c : null,
        windKph: w && w.ww_wind_spd_kph != null ? Math.round(w.ww_wind_spd_kph) : null,
        windDir: w && w.ww_wind_dir_deg != null ? ["N", "E", "S", "W"][Math.round(w.ww_wind_dir_deg / 90) % 4] : null
      } : null,
      season: { days: days, verticalM: seasonV },
      geo: {
        track: (ctx.track || []).filter(function (s) { return s.length >= 2; }),
        chutes: pick(chutes.map(function (c) { return c.zoneId; })).map(function (c) { return lonlat(c.path); }),
        lifts: pick((lf.routes || []).map(function (r) { return r.zoneId; })).map(function (c) { return { name: shortLift(c.name), path: lonlat(c.path) }; }),
        bootPacks: pick((bp.routes || []).map(function (r) { return r.zoneId; })).map(function (c) { return lonlat(c.path); })
      }
    };
  }

  // Real data, this ski season.
  async function collectSeason(api, ctx) {
    var pid = encodeURIComponent(ctx.playerId);
    var get = function (p) { return api(p).catch(function () { return null; }); };
    var res = await Promise.all([
      get("/api/players/" + pid + "/chutes/season"),
      get("/api/players/" + pid + "/bootpacks/season"),
      get("/api/players/" + pid + "/lifts/season"),
      get("/api/players/" + pid + "/stats")
    ]);
    var chutes = ((res[0] && res[0].chutes) || []).map(function (c) { return { name: c.name, difficulty: c.difficulty, count: c.count, zoneId: c.zoneId }; });
    var bp = res[1] || {}, lf = res[2] || {};
    var seasonDays = ((res[3] && res[3].days) || []).filter(function (d) { return d.season_id === ctx.seasonId; });
    var pick = geoFor(ctx.corridors);
    return {
      kind: "season", dateLabel: ctx.seasonLabel, resort: RESORT, rider: ctx.rider || "",
      verticalM: ((bp.season && bp.season.verticalM) || 0) + ((lf.season && lf.season.verticalM) || 0),
      points: seasonDays.reduce(function (s, d) { return s + (d.points || 0); }, 0),
      runs: seasonDays.reduce(function (s, d) { return s + (d.runs_count || 0); }, 0),
      days: seasonDays.filter(function (d) { return d.runs_count > 0 || d.lift_rides > 0 || d.hikes > 0; }).length,
      chutes: chutes, chuteCount: chutes.length,
      bootPacks: { count: (bp.season && bp.season.count) || 0, verticalM: (bp.season && bp.season.verticalM) || 0, routes: bp.routes || [] },
      lifts: liftList(lf.routes), liftRides: (lf.season && lf.season.count) || 0,
      weather: null, season: null,
      geo: {
        track: [],
        chutes: pick(chutes.map(function (c) { return c.zoneId; })).map(function (c) { return lonlat(c.path); }),
        lifts: pick((lf.routes || []).map(function (r) { return r.zoneId; })).map(function (c) { return { name: shortLift(c.name), path: lonlat(c.path) }; }),
        bootPacks: pick((bp.routes || []).map(function (r) { return r.zoneId; })).map(function (c) { return lonlat(c.path); })
      }
    };
  }

  // ------------------------------------------------------------- test data
  // It is fall — nobody can ride — so the Fence Editor's test screen uses a believable fake day
  // built from the project's REAL corridors: 10 Golden Eagle gondola rides, 10 Stairway Chair
  // rides, 3 boot packs, and one descent after every lift ride (a chute or run near that lift's
  // top). corridors = Ridge Quest shape {zoneId, name, runType, difficulty, path:[[lat,lon]], descentM, climbM}.
  var TEST_POINTS_PER_M = { green: 1, blue: 1.5, black: 2, "double-black": 3 };   // approximate, display only
  function findCorr(cors, re, type) {
    return cors.find(function (c) { return re.test(c.name || "") && (!type || c.runType === type); }) || null;
  }
  function testDay(corridors, opts) {
    opts = opts || {};
    var cors = (corridors || []).filter(function (c) { return c && c.path && c.path.length >= 2; });
    var rnd = seeded(opts.seed || 20261003);
    var lifts = cors.filter(function (c) { return c.runType === "lift"; });
    var gondola = findCorr(cors, /golden eagle|gondol/i, "lift") || lifts[0] || null;
    var stairway = findCorr(cors, /stairway/i, "lift") || lifts.find(function (l) { return l !== gondola; }) || null;
    var hikes = [/t1 hike/i, /guts/i, /midle ridge|middle ridge/i].map(function (re) { return findCorr(cors, re); }).filter(Boolean);
    cors.filter(function (c) { return c.runType === "hike"; }).forEach(function (c) { if (hikes.length < 3 && hikes.indexOf(c) < 0) hikes.push(c); });
    var descents = cors.filter(function (c) { return (c.runType === "chute" || c.runType === "run") && (c.descentM || 0) > 20; });

    function nearTop(lift, max) {
      if (!lift) return descents.slice(0, max);
      var top = lift.path[liftTopIndex(lift)];
      return descents.map(function (c) { return { c: c, d: Math.min(hav(top, c.path[0]), hav(top, c.path[c.path.length - 1])) }; })
        .sort(function (a, b) { return a.d - b.d; }).slice(0, max).map(function (x) { return x.c; });
    }
    var fromGondola = nearTop(gondola, 14), fromStairway = nearTop(stairway, 10);
    var skied = [], liftRows = [];
    [[gondola, fromGondola], [stairway, fromStairway]].forEach(function (pair) {
      var lift = pair[0], pool = pair[1];
      if (!lift) return;
      liftRows.push({ name: shortLift(lift.name), count: 10, verticalM: Math.round(liftGain(lift) * 10), corr: lift });
      for (var i = 0; i < 10 && pool.length; i++) skied.push(pool[Math.floor(rnd() * pool.length)]);
    });
    var routes = hikes.slice(0, 3).map(function (h) { return { name: h.name, count: 1, verticalM: Math.round(liftGain(h) || 0), corr: h }; });
    var chuteMap = {};
    skied.filter(function (c) { return c.runType === "chute"; }).forEach(function (c) {
      chuteMap[c.zoneId] = chuteMap[c.zoneId] || { name: c.name, difficulty: c.difficulty, count: 0, zoneId: c.zoneId };
      chuteMap[c.zoneId].count++;
    });
    var chutes = Object.keys(chuteMap).map(function (k) { return chuteMap[k]; })
      .sort(function (a, b) { return (DIFF_RANK[b.difficulty] || 0) - (DIFF_RANK[a.difficulty] || 0) || b.count - a.count; });
    var bpV = routes.reduce(function (s, r) { return s + r.verticalM; }, 0);
    var liftV = liftRows.reduce(function (s, r) { return s + r.verticalM; }, 0);
    var points = skied.reduce(function (s, c) { return s + (c.descentM || 0) * (TEST_POINTS_PER_M[c.difficulty] || 1) * (c.runType === "chute" ? 1.5 : 1); }, 0)
      + routes.reduce(function (s, r) { return s + r.verticalM; }, 0);
    var d = opts.date || new Date();
    return {
      kind: "day", test: true,
      dateLabel: d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }),
      resort: RESORT, rider: opts.rider || "Gary J.",
      verticalM: liftV + bpV, points: Math.round(points),
      runs: skied.length, chutes: chutes, chuteCount: chutes.length,
      bootPacks: { count: routes.length, verticalM: bpV, routes: routes.map(function (r) { return { name: r.name, count: r.count, verticalM: r.verticalM }; }) },
      lifts: liftRows.map(function (r) { return { name: r.name, count: r.count, verticalM: r.verticalM }; }),
      liftRides: liftRows.reduce(function (s, r) { return s + r.count; }, 0),
      weather: { snow24: 24, tempC: -8, windKph: 15, windDir: "W" },
      season: { days: 38, verticalM: Math.round((liftV + bpV) * 38 * 0.62) },
      geo: {
        track: skied.concat(routes.map(function (r) { return r.corr; })).map(function (c) { return lonlat(c.path); }),
        chutes: Object.keys(chuteMap).map(function (k) { return lonlat(skied.find(function (c) { return c.zoneId === k; }).path); }),
        lifts: liftRows.map(function (r) { return { name: r.name, path: lonlat(r.corr.path) }; }),
        bootPacks: routes.map(function (r) { return lonlat(r.corr.path); })
      }
    };
  }
  function testSeason(corridors, opts) {
    var day = testDay(corridors, opts);
    var days = 38, f = 0.62;
    var chutes = day.chutes.map(function (c, i) { return { name: c.name, difficulty: c.difficulty, count: Math.round(c.count * days * f * (1 - i * 0.07)) || 1 }; })
      .sort(function (a, b) { return b.count - a.count; });
    return {
      kind: "season", test: true, dateLabel: (opts && opts.seasonLabel) || "Season 2026–27",
      resort: RESORT, rider: day.rider,
      verticalM: Math.round(day.verticalM * days * f), points: Math.round(day.points * days * f),
      runs: Math.round(day.runs * days * f), days: days,
      chutes: chutes, chuteCount: chutes.length,
      bootPacks: { count: Math.round(day.bootPacks.count * days * 0.5), verticalM: Math.round(day.bootPacks.verticalM * days * 0.5), routes: day.bootPacks.routes },
      lifts: day.lifts.map(function (l) { return { name: l.name, count: Math.round(l.count * days * f), verticalM: Math.round(l.verticalM * days * f) }; }),
      liftRides: Math.round(day.liftRides * days * f),
      weather: null, season: null,
      geo: { track: [], chutes: day.geo.chutes, lifts: day.geo.lifts, bootPacks: day.geo.bootPacks }
    };
  }

  // ------------------------------------------------------------- hero map
  // A real MapLibre render of the mountain: satellite, 3D terrain, winter look, the rider's lines.
  // Off-screen at the exact pixel size; resolves to {canvas, labels:[{name,x,y}]}. Falls back to a
  // drawn mountain if anything fails or takes over 15 s, so the export never hangs.
  function heroBearing(geo) {
    var l = (geo.lifts || [])[0];
    if (!l || l.path.length < 2) return 250;
    // look roughly up the main lift (bottom -> top), so the peaks fill the frame
    var a = l.path[0], b = l.path[l.path.length - 1];
    var dy = b[1] - a[1], dx = (b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180);
    var brg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    return brg;
  }
  function renderHeroMap(geo, w, h) {
    var ml = root.maplibregl;
    if (!ml || !root.document) return Promise.resolve(null);
    // Frame the UPPER mountain -- chutes, boot packs and the lift tops -- not the long lower lift
    // lines and the village, so the peaks fill the picture.
    var focus = [].concat(geo.chutes || [], geo.bootPacks || [], (geo.lifts || []).map(function (l) { return [l.path[l.path.length - 1]]; }));
    var b = boundsOf(focus.length ? focus : [].concat(geo.track || [], (geo.lifts || []).map(function (l) { return l.path; })));
    if (!b) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var done = false, map = null, box = root.document.createElement("div");
      box.style.cssText = "position:fixed;left:-30000px;top:0;width:" + w + "px;height:" + h + "px;pointer-events:none;";
      root.document.body.appendChild(box);
      function finish(out) {
        if (done) return; done = true;
        try { if (map) map.remove(); } catch (e) {}
        box.remove(); resolve(out);
      }
      var timer = setTimeout(function () { finish(null); }, 15000);
      try {
        map = new ml.Map({
          container: box, interactive: false, attributionControl: false, pixelRatio: 1,
          preserveDrawingBuffer: true, fadeDuration: 0,
          style: { version: 8,
            sources: { base: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256 } },
            layers: [{ id: "base", type: "raster", source: "base" }] },
          center: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], zoom: 13
        });
      } catch (e) { clearTimeout(timer); finish(null); return; }
      map.on("error", function () {});
      map.once("load", function () {
        try {
          if (root.Terrain3D) { root.Terrain3D.setEnabled(map, true, { sky: true }); root.Terrain3D.applyWinter(map, { dem: true }); }
          var fc = function (paths) { return { type: "FeatureCollection", features: paths.map(function (p) { return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: p } }; }) }; };
          map.addSource("sc-lifts", { type: "geojson", data: fc((geo.lifts || []).map(function (l) { return l.path; })) });
          map.addSource("sc-chutes", { type: "geojson", data: fc(geo.chutes || []) });
          map.addSource("sc-boot", { type: "geojson", data: fc(geo.bootPacks || []) });
          map.addSource("sc-track", { type: "geojson", data: fc(geo.track || []) });
          var lay = { "line-cap": "round", "line-join": "round" };
          map.addLayer({ id: "sc-lifts", type: "line", source: "sc-lifts", layout: lay, paint: { "line-color": "#ffffff", "line-width": 3, "line-dasharray": [1.5, 1.5], "line-opacity": 0.9 } });
          map.addLayer({ id: "sc-track-glow", type: "line", source: "sc-track", layout: lay, paint: { "line-color": COL.ice, "line-width": 14, "line-blur": 10, "line-opacity": 0.55 } });
          map.addLayer({ id: "sc-track", type: "line", source: "sc-track", layout: lay, paint: { "line-color": "#d8f6ff", "line-width": 3.5 } });
          map.addLayer({ id: "sc-boot", type: "line", source: "sc-boot", layout: lay, paint: { "line-color": COL.go, "line-width": 6, "line-dasharray": [0.2, 1.6] } });
          map.addLayer({ id: "sc-chutes-glow", type: "line", source: "sc-chutes", layout: lay, paint: { "line-color": COL.gold, "line-width": 18, "line-blur": 12, "line-opacity": 0.6 } });
          map.addLayer({ id: "sc-chutes", type: "line", source: "sc-chutes", layout: lay, paint: { "line-color": COL.gold, "line-width": 5 } });
          // fit flat first (exact centre + zoom), then tilt and turn to look up the mountain
          var cam = map.cameraForBounds([[b[0], b[1]], [b[2], b[3]]], { padding: Math.round(Math.min(w, h) * 0.08) }) || {};
          map.jumpTo({ center: cam.center || map.getCenter(), zoom: Math.min(15, (cam.zoom || 13) + 0.15), pitch: 62, bearing: heroBearing(geo) });
        } catch (e) { clearTimeout(timer); finish(null); return; }
        map.once("idle", function () {
          setTimeout(function () {
            try {
              var out = root.document.createElement("canvas"); out.width = w; out.height = h;
              out.getContext("2d").drawImage(map.getCanvas(), 0, 0, w, h);
              var labels = (geo.lifts || []).map(function (l) {
                var p = map.project(l.path[l.path.length - 1]);
                return { name: l.name, x: p.x, y: p.y };
              }).filter(function (q) { return q.x > 90 && q.x < w - 90 && q.y > h * 0.3 && q.y < h * 0.8; });
              clearTimeout(timer); finish({ canvas: out, labels: labels });
            } catch (e) { clearTimeout(timer); finish(null); }
          }, 250);
        });
      });
    });
  }

  // A drawn mountain when the real map isn't available (no signal, no WebGL, tests).
  function drawFallbackHero(ctx, x, y, w, h, seed) {
    var rnd = seeded(seed || 7);
    var sky = ctx.createLinearGradient(0, y, 0, y + h);
    sky.addColorStop(0, "#1b1446"); sky.addColorStop(0.45, "#6a2a6e"); sky.addColorStop(0.75, "#e0755a"); sky.addColorStop(1, "#f6c27a");
    ctx.fillStyle = sky; ctx.fillRect(x, y, w, h);
    [[0.55, "#2a3550"], [0.68, "#1a2236"], [0.8, COL.night2]].forEach(function (layer, li) {
      ctx.beginPath(); ctx.moveTo(x, y + h);
      var base = y + h * layer[0], n = 9 + li * 3;
      for (var i = 0; i <= n; i++) {
        var px = x + (w * i) / n, peak = (i % 2 ? -1 : 1) * (0.08 + rnd() * 0.12) * h * (1 - li * 0.25);
        ctx.lineTo(px, base - Math.abs(peak) * (i % 2 ? 1 : 0.35));
      }
      ctx.lineTo(x + w, y + h); ctx.closePath(); ctx.fillStyle = layer[1]; ctx.fill();
    });
  }

  // ---------------------------------------------------------------- drawing
  // Pure 2D-canvas layout. `hero` = {canvas, labels} or null (then the drawn mountain).
  function setFont(ctx, weight, px, family) { ctx.font = weight + " " + px + "px " + family; }
  var BIG = "'Black Han Sans','Barlow Condensed',sans-serif", COND = "'Barlow Condensed','Barlow',sans-serif";
  function fitText(ctx, text, maxW, weight, px, family, minPx) {
    var size = px;
    setFont(ctx, weight, size, family);
    while (ctx.measureText(text).width > maxW && size > (minPx || 12)) { size -= 2; setFont(ctx, weight, size, family); }
    return size;
  }
  function text(ctx, t, x, y, o) {
    o = o || {};
    var size = fitText(ctx, t, o.maxW || 10000, o.weight || "600", o.size || 32, o.family || COND, o.min);
    ctx.fillStyle = o.color || COL.snow; ctx.textAlign = o.align || "left"; ctx.textBaseline = o.base || "alphabetic";
    if (o.shadow) { ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = o.shadow; ctx.shadowOffsetY = 2; }
    ctx.fillText(t, x, y);
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    return size;
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function diamonds(ctx, diff, x, y, s) {           // ◆ / ◆◆ difficulty marks, drawn (not a font glyph)
    var n = diff === "double-black" ? 2 : diff === "black" ? 1 : 0, col = COL.snow;
    if (diff === "blue") { ctx.fillStyle = COL.blue; ctx.fillRect(x, y - s, s, s); return s; }
    if (diff === "green") { ctx.fillStyle = COL.green; ctx.beginPath(); ctx.arc(x + s / 2, y - s / 2, s / 2, 0, 7); ctx.fill(); return s; }
    for (var i = 0; i < n; i++) {
      var cx = x + s / 2 + i * s * 0.95, cy = y - s / 2;
      ctx.beginPath(); ctx.moveTo(cx, cy - s / 2); ctx.lineTo(cx + s / 2, cy); ctx.lineTo(cx, cy + s / 2); ctx.lineTo(cx - s / 2, cy); ctx.closePath();
      ctx.fillStyle = COL.black; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.stroke();
    }
    return n ? s * (0.95 * n + 0.05) : 0;
  }
  function logo(ctx, x, y, s) {                     // the app glyph: coral gradient tile with a dark ring
    var g = ctx.createLinearGradient(x, y, x + s, y + s);
    g.addColorStop(0, COL.coral); g.addColorStop(1, COL.coral2);
    roundRect(ctx, x, y, s, s, s * 0.28); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); ctx.arc(x + s / 2, y + s / 2, s * 0.22, 0, Math.PI * 2); ctx.lineWidth = Math.max(2, s * 0.06); ctx.strokeStyle = "#1a0d07"; ctx.stroke();
  }
  function chip(ctx, x, y, w, h, value, label, accent, mark) {
    roundRect(ctx, x, y, w, h, 22); ctx.fillStyle = "rgba(255,255,255,0.07)"; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.stroke();
    ctx.fillStyle = accent; roundRect(ctx, x, y, 8, h, 4); ctx.fill();
    var vx = x + 30;
    text(ctx, value, vx, y + h * 0.56, { family: BIG, weight: "400", size: Math.round(h * 0.42), color: COL.snow, maxW: w - 50 });
    text(ctx, label.toUpperCase(), vx, y + h * 0.84, { size: Math.round(h * 0.18), weight: "600", color: COL.fog, maxW: w - 50 });
    if (mark) diamonds(ctx, mark, x + w - 30 - h * 0.22 * 2, y + h * 0.36, Math.round(h * 0.2));
  }
  function liftLine(d) {
    return (d.lifts || []).map(function (l) { return l.name + " ×" + l.count; }).join("   ·   ");
  }
  function weatherLine(wx) {
    if (!wx) return "";
    var p = [];
    if (wx.snow24 != null) p.push("❄ " + wx.snow24 + " cm fresh");
    if (wx.tempC != null) p.push(Math.round(wx.tempC) + "°C at the top");
    if (wx.windKph != null) p.push("wind " + wx.windKph + " kph" + (wx.windDir ? " " + wx.windDir : ""));
    return p.join("   ·   ");
  }
  function topDiff(chutes) {
    var best = null;
    (chutes || []).forEach(function (c) { if (!best || (DIFF_RANK[c.difficulty] || 0) > (DIFF_RANK[best] || 0)) best = c.difficulty; });
    return best;
  }
  function chipsFor(d) {
    var a = [
      { v: fmtInt(d.chuteCount), l: plural(d.chuteCount, "chute", "chutes"), c: COL.gold, m: topDiff(d.chutes) },
      d.kind === "season" ? { v: fmtInt(d.days), l: plural(d.days, "day on the hill", "days on the hill"), c: COL.coral }
                          : { v: fmtInt(d.runs), l: plural(d.runs, "run", "runs"), c: COL.coral },
      { v: fmtInt(d.bootPacks.count), l: "boot packs · " + fmtM(d.bootPacks.verticalM), c: COL.go },
      { v: fmtInt(d.liftRides), l: plural(d.liftRides, "lift ride", "lift rides"), c: COL.ice }
    ];
    return a;
  }

  function heroInto(ctx, hero, x, y, w, h, fadeTo) {
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    if (hero && hero.canvas) ctx.drawImage(hero.canvas, x, y, w, h);
    else drawFallbackHero(ctx, x, y, w, h);
    // alpenglow wash over the sky, night fade at the bottom
    var g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, "rgba(30,16,70,0.62)"); g.addColorStop(0.16, "rgba(190,70,120,0.16)"); g.addColorStop(0.32, "rgba(255,170,90,0.0)");
    g.addColorStop(fadeTo === "right" ? 1 : 0.78, "rgba(10,16,24,0.0)"); if (fadeTo !== "right") g.addColorStop(1, COL.night);
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    if (fadeTo === "right") {
      var r = ctx.createLinearGradient(x + w * 0.7, 0, x + w, 0);
      r.addColorStop(0, "rgba(10,16,24,0)"); r.addColorStop(1, COL.night);
      ctx.fillStyle = r; ctx.fillRect(x, y, w, h);
    }
    (hero && hero.labels || []).forEach(function (l) {
      text(ctx, l.name, x + l.x, y + l.y - 12, { size: Math.round(h * 0.024) + 8, weight: "700", color: "#ffffff", align: "center", shadow: 8 });
    });
    ctx.restore();
  }

  function drawStory(ctx, d, hero) {
    var F = FORMATS.story, W = F.w, H = F.h, P = 72;
    ctx.fillStyle = COL.night; ctx.fillRect(0, 0, W, H);
    heroInto(ctx, hero, 0, 0, W, F.heroH, "bottom");
    // header over the sky: date, resort, and the powder brag, on a soft dark plate so it reads on any photo
    var plate = ctx.createLinearGradient(0, 0, 0, 290);
    plate.addColorStop(0, "rgba(6,10,18,0.72)"); plate.addColorStop(1, "rgba(6,10,18,0)");
    ctx.fillStyle = plate; ctx.fillRect(0, 0, W, 290);
    text(ctx, (d.kind === "season" ? "MY SEASON" : d.dateLabel.toUpperCase()), P, 112, { size: 44, weight: "700", color: "#ffffff", shadow: 10, maxW: W - 2 * P });
    text(ctx, d.resort.toUpperCase() + (d.kind === "season" ? "  ·  " + d.dateLabel.toUpperCase() : ""), P, 166, { size: 34, weight: "600", color: "rgba(255,255,255,0.85)", shadow: 8, maxW: W - 2 * P });
    var wl = d.kind === "day" ? weatherLine(d.weather) : "";
    if (wl) text(ctx, wl, P, 216, { size: 32, weight: "700", color: COL.ice, shadow: 8, maxW: W - 2 * P, min: 22 });
    // the big number, sitting on the faded bottom of the map
    var y = 940;
    var size = fitText(ctx, fmtInt(d.verticalM), W - 2 * P - 120, "400", 210, BIG, 110);
    text(ctx, fmtInt(d.verticalM), P, y, { family: BIG, weight: "400", size: size, color: COL.snow, shadow: 18 });
    setFont(ctx, "400", size, BIG);
    text(ctx, "m", P + ctx.measureText(fmtInt(d.verticalM)).width + 14, y, { family: BIG, weight: "400", size: Math.round(size * 0.43), color: COL.coral });
    text(ctx, d.kind === "season" ? "VERTICAL THIS SEASON" : "VERTICAL TODAY", P, y + 64, { size: 46, weight: "700", color: COL.coral, maxW: W - 2 * P });
    text(ctx, "lifts + boot packs  ·  " + fmtInt(d.points) + " points", P, y + 108, { size: 34, weight: "500", color: COL.fog, maxW: W - 2 * P });
    // chips 2 x 2
    var cy = 1088, cw = (W - 2 * P - 24) / 2, ch = 140;
    chipsFor(d).forEach(function (c, i) {
      chip(ctx, P + (i % 2) * (cw + 24), cy + Math.floor(i / 2) * (ch + 20), cw, ch, c.v, c.l, c.c, c.m);
    });
    // lifts
    if (d.lifts && d.lifts.length) {
      text(ctx, "LIFTS", P, 1440, { size: 30, weight: "700", color: COL.ice });
      text(ctx, liftLine(d), P, 1486, { size: 38, weight: "600", color: COL.snow, maxW: W - 2 * P, min: 24 });
    }
    // chutes (3)
    var list = (d.chutes || []).slice().sort(function (a, b) {
      return d.kind === "season" ? b.count - a.count : (DIFF_RANK[b.difficulty] || 0) - (DIFF_RANK[a.difficulty] || 0) || b.count - a.count;
    }).slice(0, 3);
    if (list.length) {
      text(ctx, d.kind === "season" ? "MOST SKIED CHUTES" : "CHUTES", P, 1546, { size: 30, weight: "700", color: COL.gold });
      list.forEach(function (c, i) {
        var ry = 1592 + i * 48;
        var mw = diamonds(ctx, c.difficulty, P, ry - 6, 28);
        text(ctx, c.name + (c.count > 1 ? "  ×" + c.count : ""), P + (mw ? mw + 16 : 0), ry, { size: 36, weight: "600", color: COL.snow, maxW: W - 2 * P - 60, min: 22 });
      });
    }
    if (d.kind === "day" && d.season) {
      text(ctx, "Season so far: " + fmtInt(d.season.days) + " " + plural(d.season.days, "day", "days") + "  ·  " + fmtM(d.season.verticalM), P, 1730, { size: 30, weight: "500", color: COL.fog, maxW: W - 2 * P, min: 20 });
    }
    // brand footer
    ctx.fillStyle = "rgba(255,255,255,0.10)"; ctx.fillRect(P, H - 168, W - 2 * P, 2);
    logo(ctx, P, H - 136, 84);
    text(ctx, "Ridge Quest", P + 108, H - 82, { family: BIG, weight: "400", size: 62, color: COL.snow });
    text(ctx, TAGLINE.toUpperCase(), P + 110, H - 42, { size: 28, weight: "700", color: COL.coral, maxW: W - 2 * P - 120 });
    if (d.rider) text(ctx, d.rider, W - P, H - 82, { size: 34, weight: "600", color: COL.fog, align: "right", maxW: 300, min: 20 });
  }

  function drawWide(ctx, d, hero) {
    var F = FORMATS.wide, W = F.w, H = F.h, X = F.heroW - 30, P = 40, RW = W - X - P;
    ctx.fillStyle = COL.night; ctx.fillRect(0, 0, W, H);
    heroInto(ctx, hero, 0, 0, F.heroW, H, "right");
    text(ctx, d.kind === "season" ? "MY SEASON" : d.dateLabel.toUpperCase(), 32, 58, { size: 30, weight: "700", color: "#ffffff", shadow: 8, maxW: F.heroW - 64 });
    text(ctx, d.resort.toUpperCase() + (d.kind === "season" ? "  ·  " + d.dateLabel.toUpperCase() : ""), 32, 94, { size: 24, weight: "600", color: "rgba(255,255,255,0.85)", shadow: 6, maxW: F.heroW - 64 });
    var y = 128;
    var size = fitText(ctx, fmtInt(d.verticalM), RW - 70, "400", 108, BIG, 60);
    text(ctx, fmtInt(d.verticalM), X, y, { family: BIG, weight: "400", size: size, color: COL.snow });
    setFont(ctx, "400", size, BIG);
    text(ctx, "m", X + ctx.measureText(fmtInt(d.verticalM)).width + 8, y, { family: BIG, weight: "400", size: 48, color: COL.coral });
    text(ctx, d.kind === "season" ? "VERTICAL THIS SEASON" : "VERTICAL TODAY", X, y + 40, { size: 28, weight: "700", color: COL.coral, maxW: RW });
    text(ctx, "lifts + boot packs  ·  " + fmtInt(d.points) + " points", X, y + 74, { size: 22, weight: "500", color: COL.fog, maxW: RW });
    var cy = y + 100, cw = (RW - 16) / 2, ch = 92;
    chipsFor(d).forEach(function (c, i) {
      chip(ctx, X + (i % 2) * (cw + 16), cy + Math.floor(i / 2) * (ch + 14), cw, ch, c.v, c.l, c.c, c.m);
    });
    var ly = cy + 2 * (ch + 14) + 30;
    if (d.lifts && d.lifts.length) { text(ctx, liftLine(d), X, ly, { size: 24, weight: "600", color: COL.ice, maxW: RW, min: 16 }); ly += 34; }
    var wl = d.kind === "day" ? weatherLine(d.weather) : "";
    if (wl) text(ctx, wl, X, ly, { size: 22, weight: "600", color: COL.fog, maxW: RW, min: 14 });
    logo(ctx, X, H - 74, 44);
    text(ctx, "Ridge Quest", X + 58, H - 42, { family: BIG, weight: "400", size: 34, color: COL.snow });
    text(ctx, TAGLINE.toUpperCase(), X + 59, H - 18, { size: 17, weight: "700", color: COL.coral, maxW: RW - 60 });
  }

  function draw(ctx, d, format, hero) { (format === "wide" ? drawWide : drawStory)(ctx, d, hero); }

  // -------------------------------------------------------------- PNG + share
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function utf8(s) { return new TextEncoder().encode(s); }
  // iTXt chunk (UTF-8 text, uncompressed): keyword\0 0 0 \0 \0 text
  function itxt(key, value) {
    var k = utf8(key), v = utf8(value);
    var data = new Uint8Array(k.length + 5 + v.length);
    data.set(k, 0); data.set([0, 0, 0, 0, 0], k.length); data.set(v, k.length + 5);
    var type = utf8("iTXt"), out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length); out.set(type, 4); out.set(data, 8);
    var crcIn = new Uint8Array(4 + data.length); crcIn.set(type, 0); crcIn.set(data, 4);
    dv.setUint32(8 + data.length, crc32(crcIn));
    return out;
  }
  // Inserts metadata right after IHDR (byte 33 of every PNG: 8 signature + 25 IHDR).
  function pngWithText(bytes, meta) {
    var src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var chunks = Object.keys(meta).filter(function (k) { return meta[k] != null && meta[k] !== ""; }).map(function (k) { return itxt(k, String(meta[k])); });
    var extra = chunks.reduce(function (n, c) { return n + c.length; }, 0);
    var out = new Uint8Array(src.length + extra);
    out.set(src.subarray(0, 33), 0);
    var o = 33;
    chunks.forEach(function (c) { out.set(c, o); o += c.length; });
    out.set(src.subarray(33), o);
    return out;
  }
  function readText(bytes) {                         // for tests and debugging
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), dv = new DataView(b.buffer, b.byteOffset), o = 8, out = {};
    while (o + 8 <= b.length) {
      var len = dv.getUint32(o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
      if (type === "iTXt") {
        var data = b.subarray(o + 8, o + 8 + len), z = data.indexOf(0);
        var key = new TextDecoder().decode(data.subarray(0, z)), rest = data.subarray(z + 3), z2 = rest.indexOf(0), rest2 = rest.subarray(z2 + 1), z3 = rest2.indexOf(0);
        out[key] = new TextDecoder().decode(rest2.subarray(z3 + 1));
        var crcIn = b.subarray(o + 4, o + 8 + len);
        out["_crcOk_" + key] = crc32(crcIn) === dv.getUint32(o + 8 + len);
      }
      if (type === "IEND") break;
      o += 12 + len;
    }
    return out;
  }
  function summary(d) {
    return [
      (d.kind === "season" ? "Season " : "") + fmtM(d.verticalM) + " vertical (lifts + boot packs)",
      d.chuteCount + " " + plural(d.chuteCount, "chute", "chutes") + (d.chutes && d.chutes.length ? " (" + d.chutes.slice(0, 6).map(function (c) { return c.name + (c.difficulty ? " " + c.difficulty : ""); }).join(", ") + ")" : ""),
      (d.kind === "season" ? d.days + " days, " : "") + d.runs + " runs",
      d.bootPacks.count + " boot packs, " + fmtM(d.bootPacks.verticalM) + " climbed",
      d.liftRides + " lift rides" + (d.lifts && d.lifts.length ? " (" + d.lifts.map(function (l) { return l.name + " x" + l.count; }).join(", ") + ")" : ""),
      d.weather ? weatherLine(d.weather).replace("❄ ", "") : "",
      fmtInt(d.points) + " points"
    ].filter(Boolean).join(" | ");
  }
  function meta(d) {
    return {
      Title: "Ridge Quest — " + (d.kind === "season" ? d.dateLabel : d.dateLabel) + " at " + d.resort,
      Description: summary(d),
      Author: d.rider || "",
      "Creation Time": new Date().toISOString(),
      Software: "Ridge Quest",
      Location: LOCATION,
      Copyright: "© " + new Date().getFullYear() + " " + (d.rider || "Ridge Quest rider"),
      Comment: TAGLINE
    };
  }

  async function ensureFonts() {
    if (!root.document || !root.document.fonts) return;
    try { await Promise.all([root.document.fonts.load("400 100px 'Black Han Sans'"), root.document.fonts.load("700 40px 'Barlow Condensed'"), root.document.fonts.load("600 40px 'Barlow Condensed'"), root.document.fonts.load("500 40px 'Barlow Condensed'")]); } catch (e) {}
  }

  // data -> {canvas, blob, filename}. opts.onProgress(text), opts.noMap (tests / no WebGL).
  async function make(d, format, opts) {
    opts = opts || {};
    var F = FORMATS[format] || FORMATS.story;
    if (opts.onProgress) opts.onProgress("Drawing your mountain…");
    await ensureFonts();
    var hero = opts.noMap ? null : await renderHeroMap(d.geo || {}, F.heroW, F.heroH);
    if (opts.onProgress) opts.onProgress(hero ? "Adding your numbers…" : "Adding your numbers… (map unavailable, using the mountain art)");
    var canvas = root.document.createElement("canvas"); canvas.width = F.w; canvas.height = F.h;
    draw(canvas.getContext("2d"), d, format, hero);
    var raw = await new Promise(function (res) { canvas.toBlob(res, "image/png"); });
    var bytes = pngWithText(new Uint8Array(await raw.arrayBuffer()), meta(d));
    var blob = new Blob([bytes], { type: "image/png" });
    var stamp = new Date().toISOString().slice(0, 10);
    var filename = "ridge-quest-" + (d.kind === "season" ? "season" : stamp) + "-" + (format === "wide" ? "facebook" : "story") + ".png";
    return { canvas: canvas, blob: blob, filename: filename, hero: !!hero };
  }

  // Phone: the share sheet (Save Image -> Photos, or post straight to Instagram / Facebook).
  // Elsewhere: a download. Must be called from a tap (share needs a fresh user gesture).
  async function shareOrSave(blob, filename, textMsg) {
    try {
      var file = new File([blob], filename, { type: "image/png" });
      if (root.navigator && root.navigator.canShare && root.navigator.canShare({ files: [file] })) {
        await root.navigator.share({ files: [file], title: "Ridge Quest", text: textMsg || "" });
        return "shared";
      }
    } catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
    var url = URL.createObjectURL(blob), a = root.document.createElement("a");
    a.href = url; a.download = filename; root.document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    return "downloaded";
  }

  root.SocialCard = {
    FORMATS: FORMATS, COL: COL,
    collectDay: collectDay, collectSeason: collectSeason,
    testDay: testDay, testSeason: testSeason,
    renderHeroMap: renderHeroMap, draw: draw, drawStory: drawStory, drawWide: drawWide,
    make: make, shareOrSave: shareOrSave,
    pngWithText: pngWithText, readText: readText, crc32: crc32, meta: meta, summary: summary,
    _shortLift: shortLift
  };
})(typeof window !== "undefined" ? window : globalThis);
