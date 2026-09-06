/* terrain-3d.js — shared 3D DEM-terrain wiring for the platform's MapLibre
   surfaces.

   window.Terrain3D = {
     DEM_ID,                       // the raster-dem source id
     ensureSource(map),            // add the DEM source if it isn't there yet
     setEnabled(map, on, opts),    // opts: { exaggeration = 1, sky = false }
     toggleTilt(map, hi = 60),     // ease pitch between flat and `hi`
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

  window.Terrain3D = {
    DEM_ID: DEM_ID,
    ensureSource: ensureSource,
    setEnabled: setEnabled,
    toggleTilt: toggleTilt
  };
})();
