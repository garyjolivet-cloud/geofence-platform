/* here-marker.js — a shared "you are here" directional avatar for the live
   map pages (Ridge Quest "My map", the visitor Walk / geofence-engine, and
   Field Recorder).

   window.HereMarker.attach(map, opts) -> { update({lon,lat,headingDeg,accM}), remove() }

   - A blue dot + white ring as an HTML maplibregl.Marker (the map styles are
     raster-only, no sprite/glyphs, so a rotatable heading wedge has to be a
     CSS transform on a DOM element — a symbol/icon-rotate layer isn't
     possible). The maps are north-up, so rotate(Ndeg) is true-north-relative.
   - A faint GPS-accuracy circle drawn as a real ground-circle polygon (not a
     metre-scaled circle-radius expression).
   - Smart follow: centre on the first fix, then only re-centre when the dot
     drifts near the screen edge, and never while the user is panning/zooming
     (or within ~2s of finishing a gesture).

   opts.color   dot/wedge colour   (default "#2f7dff" — distinct from the
                pages' coral/green/amber/red map features)
   opts.follow  true | 'edge' | false   (default true; 'edge' = smart-follow
                but skip the first-fix centre, so a page that fitBounds()es its
                own framing keeps it)
*/
(function () {
  "use strict";

  var DOT_R_CAP_M = 75;   // don't draw an accuracy ring bigger than this
  var HIDE_ACC_OVER_M = 120; // above this the fix is too loose to bother drawing a ring
  var INTERACT_COOLDOWN_MS = 2000;
  var FOLLOW_INSET = 0.6; // re-centre when the dot leaves the inner 60% box

  var _stylesInjected = false;
  function injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    var css = ""
      + ".hm{width:26px;height:26px;pointer-events:none;will-change:transform}"
      + ".hm--pending{visibility:hidden}"
      + ".hm-dot{position:absolute;left:50%;top:50%;width:16px;height:16px;transform:translate(-50%,-50%);"
      +   "border-radius:50%;background:var(--hm-color,#2f7dff);border:2px solid #fff;"
      +   "box-shadow:0 0 0 4px rgba(47,125,255,.20),0 1px 3px rgba(0,0,0,.4)}"
      + ".hm-wedge{position:absolute;left:50%;top:50%;width:0;height:0;transform-origin:0 0;"
      +   "transition:opacity .25s linear,transform .15s linear;"
      +   "border-left:9px solid transparent;border-right:9px solid transparent;"
      +   "border-bottom:16px solid var(--hm-color,#2f7dff);margin-left:-9px;margin-top:-22px;opacity:0;"
      +   "filter:drop-shadow(0 0 2px rgba(0,0,0,.35))}";
    var s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  }

  var R_EARTH = 6371000, D2R = Math.PI / 180;
  // Destination point distM metres from (lon,lat) along bearingRad. Spherical.
  function haversineDest(lon, lat, distM, bearingRad) {
    var lat1 = lat * D2R, lon1 = lon * D2R;
    var dr = distM / R_EARTH;
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(bearingRad));
    var lon2 = lon1 + Math.atan2(
      Math.sin(bearingRad) * Math.sin(dr) * Math.cos(lat1),
      Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2)
    );
    return [lon2 / D2R, lat2 / D2R];
  }
  function accuracyRingPolygon(lon, lat, radiusM, steps) {
    steps = steps || 48;
    var ring = [];
    for (var i = 0; i <= steps; i++) {
      ring.push(haversineDest(lon, lat, radiusM, (i / steps) * 2 * Math.PI));
    }
    return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} };
  }

  function whenStyleReady(map, fn) {
    var done = false;
    function go() { if (done) return; done = true; fn(); }
    if (map.isStyleLoaded && map.isStyleLoaded()) { go(); return; }
    try { map.once("idle", go); } catch (e) {}
    try { map.once("load", go); } catch (e) {}
  }

  function ensureAccuracyLayers(map, color) {
    try {
      if (map.getSource("hm-accuracy")) return;
      map.addSource("hm-accuracy", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "hm-accuracy-fill", type: "fill", source: "hm-accuracy",
        paint: { "fill-color": color, "fill-opacity": 0.12 } });
      map.addLayer({ id: "hm-accuracy-line", type: "line", source: "hm-accuracy",
        paint: { "line-color": color, "line-width": 1, "line-opacity": 0.4 } });
    } catch (e) { /* style not ready / racing — update() retries */ }
  }

  function buildElement(color) {
    var root = document.createElement("div");
    root.className = "hm hm--pending";
    root.style.setProperty("--hm-color", color);
    var wedge = document.createElement("div");
    wedge.className = "hm-wedge";
    var dot = document.createElement("div");
    dot.className = "hm-dot";
    root.appendChild(wedge);
    root.appendChild(dot);
    return { root: root, wedge: wedge };
  }

  function screenInsetHit(map, lon, lat, frac) {
    var c = map.getContainer();
    var w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return true; // can't tell — treat as in view, don't chase
    var p;
    try { p = map.project([lon, lat]); } catch (e) { return true; }
    var mx = w * (1 - frac) / 2, my = h * (1 - frac) / 2;
    return p.x >= mx && p.x <= w - mx && p.y >= my && p.y <= h - my;
  }

  function bindInteraction(state, map) {
    var down = function () { state.userInteracting = true; };
    var up = function () { state.userInteracting = false; state.lastInteractionAt = performance.now(); };
    state.handlers = { down: down, up: up };
    ["dragstart", "zoomstart", "rotatestart", "pitchstart"].forEach(function (ev) { map.on(ev, down); });
    ["dragend", "zoomend", "rotateend", "pitchend"].forEach(function (ev) { map.on(ev, up); });
  }
  function unbindInteraction(state, map) {
    if (!state.handlers) return;
    ["dragstart", "zoomstart", "rotatestart", "pitchstart"].forEach(function (ev) { map.off(ev, state.handlers.down); });
    ["dragend", "zoomend", "rotateend", "pitchend"].forEach(function (ev) { map.off(ev, state.handlers.up); });
    state.handlers = null;
  }

  function maybeFollow(state, map, lon, lat) {
    if (state.follow === false) return;
    if (!state.firstFixDone) {
      state.firstFixDone = true;
      if (state.follow === "edge") return; // page keeps its own framing
      map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 16), duration: 600 });
      return;
    }
    if (state.userInteracting) return;
    if (performance.now() - state.lastInteractionAt < INTERACT_COOLDOWN_MS) return;
    if (screenInsetHit(map, lon, lat, FOLLOW_INSET)) return;
    map.easeTo({ center: [lon, lat], duration: 500 });
  }

  function attach(map, opts) {
    opts = opts || {};
    injectStyles();
    var color = opts.color || "#2f7dff";
    var state = {
      map: map, color: color, follow: (opts.follow === undefined ? true : opts.follow),
      marker: null, wedgeEl: null, ready: false, firstFixDone: false,
      userInteracting: false, lastInteractionAt: 0, removed: false, pending: null, handlers: null
    };

    var built = buildElement(color);
    state.wedgeEl = built.wedge;
    state.marker = new maplibregl.Marker({ element: built.root, anchor: "center" });
    // setLngLat BEFORE addTo, or the marker lands at [0,0] (maplibre marker.ts
    // runs _update() synchronously inside addTo()).
    state.marker.setLngLat(map.getCenter()).addTo(map);

    bindInteraction(state, map);
    whenStyleReady(map, function () {
      if (state.removed) return;
      ensureAccuracyLayers(map, color);
      state.ready = true;
      if (state.pending) applyUpdate(state.pending);
    });

    function applyUpdate(a) {
      state.marker.setLngLat([a.lon, a.lat]);
      state.marker.getElement().classList.remove("hm--pending");

      var h = a.headingDeg;
      if (h == null || !isFinite(h)) {
        state.wedgeEl.style.opacity = "0";
      } else {
        state.wedgeEl.style.opacity = "1";
        state.wedgeEl.style.transform = "rotate(" + h + "deg)";
      }

      var src = map.getSource("hm-accuracy");
      if (!src) { ensureAccuracyLayers(map, state.color); src = map.getSource("hm-accuracy"); }
      if (src) {
        var acc = a.accM;
        if (acc == null || !isFinite(acc) || acc > HIDE_ACC_OVER_M) {
          src.setData({ type: "FeatureCollection", features: [] });
        } else {
          src.setData(accuracyRingPolygon(a.lon, a.lat, Math.min(acc, DOT_R_CAP_M)));
        }
      }

      maybeFollow(state, map, a.lon, a.lat);
    }

    function update(a) {
      if (state.removed || !a) return;
      var lon = a.lon, lat = a.lat;
      if (typeof lon !== "number" || typeof lat !== "number" || !isFinite(lon) || !isFinite(lat)) return;
      state.pending = a;
      if (state.ready) applyUpdate(a);
    }

    function remove() {
      if (state.removed) return;
      state.removed = true;
      try { state.marker && state.marker.remove(); } catch (e) {}
      try { if (map.getLayer("hm-accuracy-fill")) map.removeLayer("hm-accuracy-fill"); } catch (e) {}
      try { if (map.getLayer("hm-accuracy-line")) map.removeLayer("hm-accuracy-line"); } catch (e) {}
      try { if (map.getSource("hm-accuracy")) map.removeSource("hm-accuracy"); } catch (e) {}
      unbindInteraction(state, map);
      state.pending = null;
    }

    return { update: update, remove: remove };
  }

  window.HereMarker = { attach: attach };
})();
