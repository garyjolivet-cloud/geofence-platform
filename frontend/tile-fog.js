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
 *     [{coords:[[lon,lat],...], activityType}], draws the continuous
 *     activity-typed ribbon graphic along each one.
 *   TileFog.isRevealed(h3Cell) -> boolean
 */
(function(global){

const RESOLUTION = 10; // H3 res-10, ~66m edge — matches ridge-quest.html's FOG_RESOLUTION
const REVEAL_POST_CHUNK = 500; // /api/projects/:id/reveal-cells caps at 500 cells/call

// Real-world corridor width per activity, and which shared tile_asset
// terrain_type each one's ribbon texture is stored under (see the plan's
// "Corridor path graphics" section — added mid-build per direct product
// feedback, since a corridor needs its own continuous ribbon graphic, not
// just generic "trail" hex fill).
const ACTIVITY_WIDTH_M = { hike: 2, bike: 2, xcountry: 5, ski_chute: 20, walking_city: 3 };
const ACTIVITY_TERRAIN_TYPE = { hike: "path_hike", bike: "path_bike", xcountry: "path_xcountry", ski_chute: "path_ski_chute", walking_city: "path_walking_city" };
const FOG_TERRAIN_TYPE = "fog";

let projectId = null, deviceId = null;
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

async function preloadImage(map, key){
  if(loadedImageKeys.has(key) || map.hasImage(key)) { loadedImageKeys.add(key); return; }
  const url = tileUrlByKey.get(key);
  if(!url) return;
  try{
    const img = await map.loadImage(url);
    if(!map.hasImage(key)) map.addImage(key, img.data);
    loadedImageKeys.add(key);
  }catch(e){}
}

async function preloadAllImages(map){
  const keys = new Set([tileKey(FOG_TERRAIN_TYPE, 0)]);
  terrainCells.forEach(c => keys.add(tileKey(c.terrainType, c.variantIndex)));
  Object.values(ACTIVITY_TERRAIN_TYPE).forEach(t => keys.add(tileKey(t, 0)));
  await Promise.all([...keys].map(k => preloadImage(map, k)));
}

async function attachToMap(map){
  mapRef = map;
  if(!map.getSource("tile-cells")){
    map.addSource("tile-cells", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "tile-cells-fill", type: "fill", source: "tile-cells",
      paint: { "fill-pattern": ["get", "tileKey"] } });
  }
  if(!map.getSource("tile-corridors")){
    map.addSource("tile-corridors", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "tile-corridors-line", type: "line", source: "tile-corridors",
      paint: {
        "line-pattern": ["get", "tileKey"],
        "line-width": ["interpolate", ["exponential", 2], ["zoom"],
          0, ["*", ["get", "widthM"], ["get", "pxPerMeterAtZ0"]],
          20, ["*", ["get", "widthM"], ["get", "pxPerMeterAtZ0"], 1048576]
        ]
      } });
  }
  await preloadAllImages(map);
  renderCells();
}

function renderCells(){
  if(!mapRef) return;
  const src = mapRef.getSource("tile-cells"); if(!src) return;
  if(typeof h3 === "undefined") return;
  const feats = [];
  terrainCells.forEach((c, cell) => {
    const key = isRevealed(cell) ? tileKey(c.terrainType, c.variantIndex) : tileKey(FOG_TERRAIN_TYPE, 0);
    if(!tileUrlByKey.has(key)) return; // asset not in the library yet -- skip rather than render a broken pattern ref
    const ring = closedRing(h3.cellToBoundary(cell, true));
    feats.push({ type: "Feature", properties: { tileKey: key }, geometry: { type: "Polygon", coordinates: [ring] } });
  });
  src.setData({ type: "FeatureCollection", features: feats });
}

function renderCorridors(corridors){
  if(!mapRef) return;
  const src = mapRef.getSource("tile-corridors"); if(!src) return;
  const feats = (corridors || []).filter(c => Array.isArray(c.coords) && c.coords.length >= 2).map(c => {
    const activity = c.activityType || "hike";
    const key = tileKey(ACTIVITY_TERRAIN_TYPE[activity] || ACTIVITY_TERRAIN_TYPE.hike, 0);
    return { type: "Feature",
      properties: { tileKey: key, widthM: ACTIVITY_WIDTH_M[activity] || 2, pxPerMeterAtZ0: pxPerMeterAtZ0(c.coords[0][1]) },
      geometry: { type: "LineString", coordinates: c.coords } };
  }).filter(f => tileUrlByKey.has(f.properties.tileKey));
  src.setData({ type: "FeatureCollection", features: feats });
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
  ACTIVITY_WIDTH_M, ACTIVITY_TERRAIN_TYPE };

})(typeof window !== "undefined" ? window : globalThis);
