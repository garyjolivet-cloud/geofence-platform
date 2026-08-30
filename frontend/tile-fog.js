/* TileFog — Artistic Fog-of-War Tiles shared module (window.TileFog).
 *
 * Generalizes ridge-quest.html's H3-hex fog-of-war (_revealFog/fogCells/
 * renderFogMap) off Ridge Quest's ski-only, player_account-gated form into a
 * platform-wide feature keyed to the generic device/project tables — see
 * the plan's "Artistic Fog-of-War Tiles" file. One real shared module (not
 * copy-pasted per call site) specifically to avoid the "verbatim mirror"
 * bug class this codebase has hit before (kalman-filter.js's own header,
 * the fence-editor.html editorToSimBundle() gotcha) — geofence-engine.html,
 * geofence-sim.html, and fence-editor.html's Test Mode all load this same
 * file rather than three independent copies.
 *
 * Side effects only through the map instance passed to attachToMap() and
 * plain fetch() calls — no other DOM access, matching guidance-bot.js/
 * kalman-filter.js's existing callback-injection convention.
 *
 * API:
 *   TileFog.load({projectId, deviceId})         -> Promise, fetches
 *     classified cells (Phase B), this device's prior reveal state, and the
 *     shared tile-art library (Phase A).
 *   TileFog.attachToMap(map)                     -> Promise, adds the hex
 *     terrain source/layers + corridor ribbon source/layer, preloads every
 *     tile image this project's cells/corridors reference.
 *   TileFog.reveal(lat, lon, acc, accuracyCapM)   -> reveals the current H3
 *     cell + its k=1 ring (same "torch radius" Ridge Quest uses), POSTs new
 *     cells, re-renders. Call from the position tick loop (HUD.onFix etc).
 *   TileFog.renderCorridors(corridors)            -> corridors:
 *     [{coords:[[lon,lat],...], activityType}]. Caches this corridor set
 *     and (re-)draws only the ribbon segments whose H3 cell is currently
 *     revealed -- per direct product feedback (2026-08-26), a corridor
 *     should reveal progressively as the visitor passes through each hex,
 *     the same "board game" mechanic the terrain hex fill already uses,
 *     not draw its whole length upfront. reveal() re-invokes this
 *     automatically whenever new cells get revealed, so callers only need
 *     to call renderCorridors() once (or whenever the corridor set itself
 *     changes, e.g. an edit) -- not on every tick.
 *   TileFog.isRevealed(h3Cell) -> boolean
 */
(function(global){

const RESOLUTION = 10; // H3 res-10, ~66m edge — matches ridge-quest.html's FOG_RESOLUTION
const REVEAL_POST_CHUNK = 500; // /api/projects/:id/reveal-cells caps at 500 cells/call
const REVEAL_SAMPLE_INTERVAL_M = 15; // corridor-densification step for per-hex reveal clipping -- fine enough to catch cell transitions against a ~66m hex edge without being expensive over a multi-km corridor

// Real-world corridor width per activity, and which shared tile_asset
// terrain_type each one's ribbon texture is stored under (see the plan's
// "Corridor path graphics" section — added mid-build per direct product
// feedback, since a corridor needs its own continuous ribbon graphic, not
// just generic "trail" hex fill).
const ACTIVITY_WIDTH_M = { hike: 2, bike: 2, xcountry: 5, ski_chute: 20, walking_city: 3 };
const ACTIVITY_TERRAIN_TYPE = { hike: "path_hike", bike: "path_bike", xcountry: "path_xcountry", ski_chute: "path_ski_chute", walking_city: "path_walking_city" };
const FOG_TERRAIN_TYPE = "fog";

let projectId = null, deviceId = null;
// revealAll: draw every classified cell with its real tile art regardless of
// fog/reveal state. Off for the game surfaces (engine/sim/quest -- fog is the
// point there); on for the Map Paint editor, which needs to see what it's
// painting. Default false so every existing caller is unaffected.
let revealAll = false;
let terrainCells = new Map();   // h3Cell -> {terrainType, variantIndex}
let fogCells = new Map();       // h3Cell -> state (2 = revealed)
let tileUrlByKey = new Map();   // "<terrainType>_<variantIndex>" -> R2-served URL
let mapRef = null;
const loadedImageKeys = new Set();

function tileKey(terrainType, variantIndex){ return terrainType + "_" + (variantIndex || 0); }

// h3-js v4's cellToBoundary(cell, true) already returns a closed ring
// (first point repeated at the end) -- confirmed live via a direct node
// check against the exact installed version, since this silently varies
// across h3-js releases and an unnecessary re-close creates a degenerate
// zero-length final segment.
function closedRing(ring){
  const first = ring[0], last = ring[ring.length - 1];
  return (first[0] === last[0] && first[1] === last[1]) ? ring : ring.concat([first]);
}

async function load(opts){
  projectId = (opts && opts.projectId) || null;
  deviceId = (opts && opts.deviceId) || null;
  revealAll = !!(opts && opts.revealAll);
  terrainCells = new Map();
  fogCells = new Map();
  tileUrlByKey = new Map();
  if(!projectId) return;
  // ?season= is not just a filter -- without it, a season-aware category
  // (e.g. two different path_walking_city rows, one summer one winter, same
  // variant_index) would collide on the same tileKey and silently clobber
  // each other in the Map below. A project with no season set gets
  // everything unfiltered (see the PATCH route's own comment).
  const seasonQS = (opts && opts.season) ? "?season=" + encodeURIComponent(opts.season) : "";
  const [cellsRes, fogRes, assetsRes] = await Promise.allSettled([
    fetch("/api/projects/" + encodeURIComponent(projectId) + "/terrain-cells").then(r => r.ok ? r.json() : { cells: [] }),
    deviceId
      ? fetch("/api/projects/" + encodeURIComponent(projectId) + "/fog?device=" + encodeURIComponent(deviceId)).then(r => r.ok ? r.json() : { cells: [] })
      : Promise.resolve({ cells: [] }),
    fetch("/api/tile-assets" + seasonQS).then(r => r.ok ? r.json() : { tiles: [] })
  ]);
  ((cellsRes.value || {}).cells || []).forEach(c => terrainCells.set(c.h3Cell, { terrainType: c.terrainType, variantIndex: c.variantIndex || 0 }));
  ((fogRes.value || {}).cells || []).forEach(c => fogCells.set(c.h3_cell, c.state));
  ((assetsRes.value || {}).tiles || []).forEach(t => tileUrlByKey.set(tileKey(t.terrainType, t.variantIndex), t.url));
}

function isRevealed(h3Cell){ return (fogCells.get(h3Cell) || 0) >= 2; }

// Real-world-to-screen-pixel line width, exact at a given reference
// latitude: pixels-per-meter scales as exactly 2^zoom (Web Mercator), so an
// "exponential base 2" interpolation between a zoom-0 and zoom-20 anchor
// reproduces widthM*pxPerMeter(lat,z) exactly at every intermediate zoom —
// not an approximation. One reference latitude per corridor (its first
// point) is a deliberate simplification; error over a typical trail's
// latitude span is negligible at this app's zoom range (13-18, see
// CLAUDE.md's zoom-level survey).
function pxPerMeterAtZ0(lat){ return 1 / (156543.03392 * Math.cos(lat * Math.PI / 180)); }

// The generated tile PNGs are ~1024px, authored as dense repeating
// micro-patterns (many small trees/rocks/etc baked into one image, meant to
// read as a fine texture at a MUCH smaller display size -- like a
// wallpaper swatch, not one giant motif). MapLibre's fill-pattern/
// line-pattern render a pattern image at its *native* pixel size unless
// told otherwise via `pixelRatio` on addImage() -- confirmed live
// (2026-08-25): with no pixelRatio, a single real-world hex (only ~30-100
// screen px across at this app's normal zoom range) showed one full
// 1024px tree motif blown up hugely instead of the intended dense small-
// tree texture. pixelRatio scales the DISPLAYED size to nativePx/ratio, so
// this shrinks the on-screen pattern repeat to a size that actually reads
// as a texture rather than a single oversized image.
const TILE_IMAGE_PIXEL_RATIO = 8;
async function preloadImage(map, key){
  if(loadedImageKeys.has(key) || map.hasImage(key)) { loadedImageKeys.add(key); return; }
  const url = tileUrlByKey.get(key);
  if(!url){ console.warn('TileFog: no tile-asset URL registered for', key, '-- was TileFog.load() called with the right season?'); return; }
  try{
    const img = await map.loadImage(url);
    if(!map.hasImage(key)) map.addImage(key, img.data, { pixelRatio: TILE_IMAGE_PIXEL_RATIO });
    loadedImageKeys.add(key);
  }catch(e){ console.warn('TileFog: image load failed for', key, url, e); }
}

async function preloadAllImages(map){
  const keys = new Set([tileKey(FOG_TERRAIN_TYPE, 0)]);
  terrainCells.forEach(c => keys.add(tileKey(c.terrainType, c.variantIndex)));
  Object.values(ACTIVITY_TERRAIN_TYPE).forEach(t => keys.add(tileKey(t, 0)));
  await Promise.all([...keys].map(k => preloadImage(map, k)));
}

// Confirmed live (2026-08-25): map.addSource() throws "Style is not done
// loading" if MapLibre's internal Style._loaded flag isn't set yet --
// initTileArt()'s own try/catch was silently swallowing this, so calling
// attachToMap() too early meant TileFog never activated at all: no hex
// fill, no corridor ribbon, no error visible anywhere. Also confirmed live:
// map.isStyleLoaded()/map.once('idle',...) are NOT reliable signals to wait
// on in this app specifically -- both stayed false/never fired for many
// seconds in a real session, apparently because this editor's own many
// frequently-updated custom GeoJSON sources (fences/draft/walkpath/etc,
// re-setData()'d on nearly every user action) keep the map's overall
// "idle" bookkeeping from ever settling, even though the STYLE itself
// (the thing addSource() actually needs) is long since ready by then. So
// this retries the real addSource() call directly on that specific error
// instead of trusting any one readiness event/flag.
async function trySource(fn, label){
  for(let attempt=0; attempt<20; attempt++){
    try{ return fn(); }
    catch(e){
      if(!/Style is not done loading/.test(e.message||"") || attempt===19) throw e;
      await new Promise(r => setTimeout(r, 250));
    }
  }
}
async function attachToMap(map, opts){
  mapRef = map;
  if(opts && opts.revealAll != null) revealAll = !!opts.revealAll;
  if(!map.getSource("tile-cells")){
    await trySource(() => {
      map.addSource("tile-cells", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "tile-cells-fill", type: "fill", source: "tile-cells",
        paint: { "fill-pattern": ["get", "tileKey"] } });
    });
  }
  if(!map.getSource("tile-corridors")){
    await trySource(() => {
      map.addSource("tile-corridors", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "tile-corridors-line", type: "line", source: "tile-corridors",
        paint: {
          "line-pattern": ["get", "tileKey"],
          // The exact real-world-meters conversion is mathematically
          // correct, but confirmed live (2026-08-25) it makes a narrow
          // corridor (e.g. a 2m hike/bike path) render under 1.5px wide at
          // this app's normal editing zoom (~15-16) -- literally
          // imperceptible, not "a thin path," reading as "no path drawn" at
          // all. This is a board-game-readable overlay, not a survey-grade
          // map, so each stop's value is max(trueWidthAtThisZoom,
          // floorAtThisZoom) -- a wide corridor (20m ski_chute) already
          // exceeds its floor at normal zoom and is unaffected.
          //
          // A first attempt wrapped two separate top-level `interpolate`
          // expressions in `max(...)` -- confirmed live (2026-08-25) that's
          // invalid: "Only one zoom-based step/interpolate subexpression
          // may be used in an expression," which made addLayer() throw on
          // EVERY call, silently (until logging was added), so the
          // corridor layer never got created at all. Fixed by using a
          // SINGLE interpolate whose per-stop VALUES each already contain
          // their own max(...) of the true width (widthM * pxPerMeterAtZ0
          // * 2^stopZoom, precomputed per stop since Web Mercator px/m
          // scales as exactly 2^zoom) against a hand-picked visible floor
          // -- only one interpolate subexpression total, satisfying the
          // validator, while still behaving identically in practice.
          // Confirmed live (2026-08-26): this curve originally stopped at
          // zoom 20 -- MapLibre CLAMPS to an interpolate's last stop for
          // any zoom beyond it, so a viewer zooming in further than z20
          // (easily reachable -- MapLibre's own default maxZoom is 22) saw
          // the path frozen at exactly 30px forever, looking proportionally
          // tinier the closer they got ("can't tell there's a trail with
          // grass on the side"), not an intentional stopping point. Extended
          // to z24 (see attachToMap()'s own map instances, whose maxZoom is
          // now explicitly raised to 24 too) so both the true-width math
          // and the floor keep growing all the way to a genuinely
          // close-up, ground-level-ish view.
          "line-width": ["interpolate", ["exponential", 2], ["zoom"],
            0,  ["max", ["*", ["get", "widthM"], ["get", "pxPerMeterAtZ0"]], 1],
            12, ["max", ["*", ["get", "widthM"], ["get", "pxPerMeterAtZ0"], 4096], 4],
            16, ["max", ["*", ["get", "widthM"], ["get", "pxPerMeterAtZ0"], 65536], 10],
            18, ["max", ["*", ["get", "widthM"], ["get", "pxPerMeterAtZ0"], 262144], 18],
            20, ["max", ["*", ["get", "widthM"], ["get", "pxPerMeterAtZ0"], 1048576], 30],
            22, ["max", ["*", ["get", "widthM"], ["get", "pxPerMeterAtZ0"], 4194304], 60],
            24, ["max", ["*", ["get", "widthM"], ["get", "pxPerMeterAtZ0"], 16777216], 120]
          ]
        } });
    });
  }
  await preloadAllImages(map);
  renderCells();
}

// Chaikin corner-cutting on a closed ring of [lng,lat] points. Two passes
// (SMOOTH_ITERATIONS) turn the hex staircase along a terrain-type boundary
// into an organic curve. Runs on the DISSOLVED patch outline (see
// renderCells), not per hexagon, so total vertex count still drops vs. the
// old one-feature-per-hex render.
const SMOOTH_ITERATIONS = 2;
function chaikinClosedRing(ring){
  const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring.slice();
  if(pts.length < 3) return closedRing(ring);
  const out = [];
  for(let i = 0; i < pts.length; i++){
    const a = pts[i], b = pts[(i + 1) % pts.length];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
    out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  out.push(out[0].slice());
  return out;
}
function smoothRing(ring){
  let r = ring;
  for(let i = 0; i < SMOOTH_ITERATIONS; i++) r = chaikinClosedRing(r);
  return r;
}

function renderCells(){
  if(!mapRef) return;
  const src = mapRef.getSource("tile-cells"); if(!src) return;
  if(typeof h3 === "undefined") return;

  // Group cell ids by the tile key they render with, then dissolve each
  // group's contiguous hexes into one outline (h3.cellsToMultiPolygon) and
  // round it. Fewer geojson features than one-per-hex AND smooth edges --
  // the mobile-friendly compromise (vs. a finer H3 resolution, which is 7x+
  // more features). Falls back to per-hex polygons if the loaded h3-js
  // lacks cellsToMultiPolygon.
  const byKey = new Map();
  terrainCells.forEach((c, cell) => {
    const key = (revealAll || isRevealed(cell)) ? tileKey(c.terrainType, c.variantIndex) : tileKey(FOG_TERRAIN_TYPE, 0);
    if(!tileUrlByKey.has(key)) return; // asset not in the library yet -- skip rather than render a broken pattern ref
    let arr = byKey.get(key); if(!arr){ arr = []; byKey.set(key, arr); }
    arr.push(cell);
  });

  const canDissolve = typeof h3.cellsToMultiPolygon === "function";
  const feats = [];
  byKey.forEach((cellsForKey, key) => {
    if(canDissolve){
      let polys = null;
      try { polys = h3.cellsToMultiPolygon(cellsForKey, true); } catch(e){ polys = null; }
      if(polys){
        const mp = polys.map(poly => poly.map(ring => smoothRing(ring)));
        feats.push({ type: "Feature", properties: { tileKey: key }, geometry: { type: "MultiPolygon", coordinates: mp } });
        return;
      }
    }
    cellsForKey.forEach(cell => {
      feats.push({ type: "Feature", properties: { tileKey: key },
        geometry: { type: "Polygon", coordinates: [closedRing(h3.cellToBoundary(cell, true))] } });
    });
  });
  src.setData({ type: "FeatureCollection", features: feats });
}

// Map Paint editor hook: replace the in-memory classified-cell set from the
// editor's own working copy and redraw, with no server round-trip. `entries`
// is an array (or Map values) of {h3Cell, terrainType, variantIndex}. Pairs
// with revealAll:true so every cell shows its real art while painting.
async function setCells(entries){
  terrainCells = new Map();
  (entries || []).forEach(c => { if(c && c.h3Cell) terrainCells.set(c.h3Cell, { terrainType: c.terrainType, variantIndex: c.variantIndex || 0 }); });
  if(mapRef) await preloadAllImages(mapRef);
  renderCells();
}
function redraw(){ renderCells(); }

function haversineM(a, b){
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]), la2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Adds intermediate points every ~REVEAL_SAMPLE_INTERVAL_M along a
// [lon,lat] coordinate array so per-hex reveal clipping (below) doesn't
// miss a cell transition that falls between two widely-spaced authored
// vertices (a corridor is often just a handful of points spanning
// hundreds of meters each).
function densifyLine(coords, intervalM){
  const out = [coords[0]];
  for(let i = 0; i < coords.length - 1; i++){
    const a = coords[i], b = coords[i + 1];
    const distM = haversineM(a, b);
    const steps = Math.max(1, Math.ceil(distM / intervalM));
    for(let s = 1; s <= steps; s++){
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

let lastCorridors = [];

// Splits each cached corridor's densified line into maximal contiguous
// runs whose H3 cell is currently revealed, emitting one LineString
// feature per run -- an unrevealed stretch simply isn't drawn at all
// (letting the fog-placeholder hex show through untouched underneath),
// rather than drawing the whole corridor upfront. Re-run on every reveal()
// so newly-revealed ground immediately extends the visible ribbon.
function buildRevealedCorridorFeatures(){
  if(typeof h3 === "undefined") return [];
  const feats = [];
  lastCorridors.forEach(c => {
    if(!Array.isArray(c.coords) || c.coords.length < 2) return;
    const activity = c.activityType || "hike";
    const key = tileKey(ACTIVITY_TERRAIN_TYPE[activity] || ACTIVITY_TERRAIN_TYPE.hike, 0);
    if(!tileUrlByKey.has(key)) return;
    const props = { tileKey: key, widthM: ACTIVITY_WIDTH_M[activity] || 2, pxPerMeterAtZ0: pxPerMeterAtZ0(c.coords[0][1]) };
    const dense = densifyLine(c.coords, REVEAL_SAMPLE_INTERVAL_M);
    let seg = null;
    dense.forEach(pt => {
      // revealAll (Map Paint, Ridge Quest "show all runs" when fog is off)
      // draws the whole ribbon, not just walked-over segments -- same
      // reading the hex-cell path already uses.
      const revealed = revealAll || isRevealed(h3.latLngToCell(pt[1], pt[0], RESOLUTION));
      if(revealed){
        if(!seg) seg = [pt]; else seg.push(pt);
      }else{
        if(seg && seg.length >= 2) feats.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: seg } });
        seg = null;
      }
    });
    if(seg && seg.length >= 2) feats.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: seg } });
  });
  return feats;
}

function refreshCorridorRender(){
  if(!mapRef){ console.warn('TileFog.renderCorridors: called before attachToMap() -- no-op'); return; }
  const src = mapRef.getSource("tile-corridors");
  if(!src){ console.warn('TileFog.renderCorridors: "tile-corridors" source does not exist yet -- no-op'); return; }
  const feats = buildRevealedCorridorFeatures();
  if(lastCorridors.length > 0 && feats.length === 0) console.warn('TileFog.renderCorridors:', lastCorridors.length, 'corridor(s) cached, but 0 revealed segments to draw yet (expected until the visitor walks into one) -- if this persists after walking, check coords/tileUrlByKey (season) as before.');
  src.setData({ type: "FeatureCollection", features: feats });
}

function renderCorridors(corridors){
  lastCorridors = corridors || [];
  refreshCorridorRender();
}

// Mirrors ridge-quest.html's Quest._revealFog(p, acc) exactly (H3 k=1 disk
// "torch radius", state upgrades only, chunked POST of only genuinely new
// cells) but keyed to project+device instead of a Ridge Quest player.
function reveal(lat, lon, acc, accuracyCapM){
  if(typeof h3 === "undefined") return [];
  if(accuracyCapM != null && acc > accuracyCapM) return [];
  const origin = h3.latLngToCell(lat, lon, RESOLUTION);
  const disk = h3.gridDisk(origin, 1);
  const newCells = disk.filter(cell => (fogCells.get(cell) || 0) < 2);
  if(!newCells.length) return [];
  newCells.forEach(cell => fogCells.set(cell, 2));
  renderCells();
  refreshCorridorRender();
  if(projectId && deviceId){
    for(let i = 0; i < newCells.length; i += REVEAL_POST_CHUNK){
      const chunk = newCells.slice(i, i + REVEAL_POST_CHUNK);
      fetch("/api/projects/" + encodeURIComponent(projectId) + "/reveal-cells", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId, cells: chunk, state: 2 })
      }).catch(() => {});
    }
  }
  return newCells;
}

global.TileFog = { load, attachToMap, reveal, renderCorridors, isRevealed,
  setCells, redraw, ACTIVITY_WIDTH_M, ACTIVITY_TERRAIN_TYPE };

})(typeof window !== "undefined" ? window : globalThis);
