/* terrain-3d.js — shared 3D DEM-terrain + map-appearance wiring for the
   platform's MapLibre surfaces.

   window.Terrain3D = {
     DEM_ID,                       // the raster-dem source id
     ensureSource(map),            // add the DEM source if it isn't there yet
     setEnabled(map, on, opts),    // opts: { exaggeration = 1, sky = false }
     toggleTilt(map, hi = 60),     // ease pitch between flat and `hi`
     applyWinter(map, opts),       // opts: { dem = false } — wintry recolor of
                                   //   the raster basemap + (dem) DEM hillshade
                                   //   / elevation snowline + cool wash + grain
     clearWinter(map),             // undo applyWinter
   }

   Background: the Terrarium DEM + setTerrain call was copy-pasted, verbatim,
   into six HTML files (geofence-engine, geofence-sim, fence-editor,
   field-recorder, record, gpx-editor). Ridge Quest's "My map" is the first
   surface to use this module instead of a seventh copy; the others should
   migrate onto it. The DEM spec below is byte-identical to those copies AND
   to backend/worker.js's server-side sampleElevation() — keep all of them in
   sync if the source ever changes.

   No dependency of its own beyond the maplibre-gl global the host page loads. */
(function () {
  "use strict";

  var DEM_ID = "terrain-dem";
  // AWS Open Data "Terrarium" DEM — public, permissive CORS, no proxy.
  var DEM = {
    type: "raster-dem",
    tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
    tileSize: 256,
    encoding: "terrarium",
    maxzoom: 15
  };

  // A light atmosphere for pitched views — palette-aligned with the app's
  // --ice / --night tokens. Only applied when the caller asks for sky.
  var SKY = {
    "sky-color": "#9ec4e4",
    "sky-horizon-blend": 0.6,
    "horizon-color": "#dfeaf2",
    "horizon-fog-blend": 0.5,
    "fog-color": "#0b1622",
    "fog-ground-blend": 0.4,
    "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.8, 12, 0.3]
  };

  function reducedMotion() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (e) { return false; }
  }

  function ensureSource(map) {
    if (map && !map.getSource(DEM_ID)) map.addSource(DEM_ID, DEM);
  }

  // on === true  -> DEM terrain (+ optional sky).
  // on === false -> drop terrain, clear sky, flatten the camera.
  function setEnabled(map, on, opts) {
    if (!map) return;
    opts = opts || {};
    if (on) {
      ensureSource(map);
      map.setTerrain({ source: DEM_ID, exaggeration: opts.exaggeration || 1 });
      if (opts.sky && map.setSky) map.setSky(SKY);
    } else {
      map.setTerrain(null);
      if (map.setSky) { try { map.setSky(undefined); } catch (e) {} }
      map.easeTo({ pitch: 0, duration: reducedMotion() ? 0 : 300 });
    }
  }

  // Mirrors the tiltBtn handlers already in geofence-engine.html /
  // geofence-sim.html: a single button that eases between flat and `hi`.
  function toggleTilt(map, hi) {
    if (!map) return;
    hi = hi || 60;
    map.easeTo({
      pitch: map.getPitch() > 10 ? 0 : hi,
      duration: reducedMotion() ? 0 : 400
    });
  }

  /* ---- winter map treatment -------------------------------------------------
     The map surfaces use a RASTER satellite basemap (no vector feature layers
     to recolor), so "make it look like winter" is done with GPU-cheap raster
     paint adjustments + DEM-derived shading, all added once and static for the
     life of the map screen. Nothing here touches a per-tick source. */

  var WINTER_SRC_ID = "winter-src";
  var GRAIN_IMG_ID = "winter-grain";
  var WINTER_LAYERS = ["winter-relief", "winter-hillshade", "winter-wash", "winter-grain"];
  var WORLD_RING = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];

  // Cooler, more overcast variant of SKY for a winter alpine sky.
  var WINTER_SKY = {
    "sky-color": "#b9cede",
    "sky-horizon-blend": 0.7,
    "horizon-color": "#e8eef4",
    "horizon-fog-blend": 0.6,
    "fog-color": "#0d1926",
    "fog-ground-blend": 0.5,
    "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.7, 12, 0.22]
  };

  // Low-contrast blue-grey speckle, built once as raw RGBA and cached. Passed
  // straight to map.addImage (which accepts {width,height,data}); tiles itself
  // when used as a fill-pattern.
  var _grain = null;
  function grainImageData() {
    if (_grain) return _grain;
    var w = 128, h = 128, data = new Uint8ClampedArray(w * h * 4);
    for (var i = 0; i < w * h; i++) {
      var n = 200 + ((Math.random() * 55) | 0);   // 200..255, tight range
      data[i * 4] = n;
      data[i * 4 + 1] = n;
      data[i * 4 + 2] = Math.min(255, n + 6);     // faint blue bias
      data[i * 4 + 3] = 255;
    }
    _grain = { width: w, height: h, data: data };
    return _grain;
  }

  function _add(map, layer, beforeId) {
    if (map.getLayer(layer.id)) return;
    try { map.addLayer(layer, beforeId); }
    catch (e) { /* an unsupported layer type shouldn't kill the rest */ }
  }

  // opts.dem === true  -> also add DEM hillshade + elevation snowline (needs
  //                       the Terrarium raster-dem source, i.e. 3D is on) and
  //                       switch to the winter sky.
  function applyWinter(map, opts) {
    if (!map) return;
    opts = opts || {};

    // 1. recolor the satellite in place — kills summer greens/browns, lifts
    //    toward a snow-field tone, keeps the imagery legible.
    if (map.getLayer("base")) {
      try {
        map.setPaintProperty("base", "raster-saturation", -0.55);
        map.setPaintProperty("base", "raster-brightness-min", 0.10);
        map.setPaintProperty("base", "raster-contrast", -0.06);
      } catch (e) {}
    }

    // 2. where the winter layers slot: above the satellite, below the shroud /
    //    run network, whichever renderFogMap branch ran.
    var anchor = ["shroud-fill", "runLines-halo", "fog-fill"].filter(function (id) {
      return map.getLayer(id);
    })[0];

    // 3. a world-covering polygon to hang the flat overlays on.
    if (!map.getSource(WINTER_SRC_ID)) {
      map.addSource(WINTER_SRC_ID, {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [WORLD_RING] } }
      });
    }

    // 4. DEM-derived layers — only when the raster-dem source is present.
    if (opts.dem && map.getSource(DEM_ID)) {
      _add(map, {
        id: "winter-relief", type: "color-relief", source: DEM_ID,
        paint: {
          "color-relief-color": [
            "interpolate", ["linear"], ["elevation"],
            1200, "#63806b", 1700, "#b9c9d6", 2200, "#eef4fa", 2800, "#ffffff"
          ],
          "color-relief-opacity": 0.4
        }
      }, anchor);
      _add(map, {
        id: "winter-hillshade", type: "hillshade", source: DEM_ID,
        paint: {
          "hillshade-exaggeration": 0.45,
          "hillshade-shadow-color": "#3d4b6e",
          "hillshade-highlight-color": "#ffffff",
          "hillshade-accent-color": "#1a2536"
        }
      }, anchor);
    }

    // 5. icy cast.
    _add(map, {
      id: "winter-wash", type: "fill", source: WINTER_SRC_ID,
      paint: { "fill-color": "#dbe7f4", "fill-opacity": 0.16 }
    }, anchor);

    // 6. faint wind-drift grain.
    if (!map.hasImage || !map.hasImage(GRAIN_IMG_ID)) {
      try { map.addImage(GRAIN_IMG_ID, grainImageData(), { pixelRatio: 2 }); } catch (e) {}
    }
    _add(map, {
      id: "winter-grain", type: "fill", source: WINTER_SRC_ID,
      paint: { "fill-pattern": GRAIN_IMG_ID, "fill-opacity": 0.09 }
    }, anchor);

    // 7. winter sky (pitched contexts only).
    if (opts.dem && map.setSky) { try { map.setSky(WINTER_SKY); } catch (e) {} }
  }

  function clearWinter(map) {
    if (!map) return;
    WINTER_LAYERS.forEach(function (id) { if (map.getLayer(id)) { try { map.removeLayer(id); } catch (e) {} } });
    if (map.getSource(WINTER_SRC_ID)) { try { map.removeSource(WINTER_SRC_ID); } catch (e) {} }
    if (map.hasImage && map.hasImage(GRAIN_IMG_ID)) { try { map.removeImage(GRAIN_IMG_ID); } catch (e) {} }
    if (map.getLayer("base")) {
      try {
        map.setPaintProperty("base", "raster-saturation", 0);
        map.setPaintProperty("base", "raster-brightness-min", 0);
        map.setPaintProperty("base", "raster-contrast", 0);
      } catch (e) {}
    }
  }

  window.Terrain3D = {
    DEM_ID: DEM_ID,
    ensureSource: ensureSource,
    setEnabled: setEnabled,
    toggleTilt: toggleTilt,
    applyWinter: applyWinter,
    clearWinter: clearWinter
  };
})();
