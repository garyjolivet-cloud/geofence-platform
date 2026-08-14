/* asset-preview-layer.js — live 3D AR-object preview inside fence-editor.html
 * (window.AssetPreviewLayer)
 *
 * Renders zone.arObjects[] as real three.js meshes positioned directly on
 * fence-editor.html's own MapLibre map, via a MapLibre "custom" layer
 * (type:"custom", onAdd(map,gl)/render(gl,options)) sharing the map's own
 * WebGL context — this repo's first use of that technique. Contrast
 * ar-view.js (the visitor-facing AR camera view), which deliberately runs
 * three.js on its own SEPARATE overlay canvas instead of sharing MapLibre's
 * context — that separation doesn't apply here, since this preview needs to
 * live inside the same tilted/terrain map the author is already editing on,
 * not a full-screen camera overlay.
 *
 * Loaded as an ES module (three.js ships ESM-only) — same importmap
 * technique geofence-engine.html already uses for ar-view.js.
 *
 * Host contract:
 *   AssetPreviewLayer.install(map)
 *     Idempotent — safe to call more than once, and safe to call before the
 *     map's style has finished loading (waits internally). Call this RIGHT
 *     AFTER constructing the map, not inside a "load" handler — see the
 *     module/map-load race handshake at the bottom of this file for why a
 *     "load"-handler-only call site isn't safe here.
 *   AssetPreviewLayer.setObjects([{id, url, center:[lat,lon], anchor, animationClip}, ...])
 *     Full desired-state list, safe to call on every render pass (including
 *     drag-frame frequency — fence-editor.html's own renderSources() runs on
 *     every zone-drag mousemove). Identity-stable: diffs against the
 *     current mesh cache by id, only loads what's new, only repositions
 *     what already exists, removes what's gone. Never blocks — a still-
 *     loading model is silently skipped until its GLTF finishes fetching.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const draco = new DRACOLoader();
draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/libs/draco/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(draco);

const modelCache = new Map();   // url -> Promise<GLTF> (template; clone before adding to scene)
function loadModelTemplate(url){
  if(modelCache.has(url)) return modelCache.get(url);
  const p = new Promise((res,rej)=>gltfLoader.load(url, res, undefined, rej))
    .catch(e=>{ modelCache.delete(url); throw e; });
  modelCache.set(url, p);
  return p;
}
function cloneModel(gltf){
  return (gltf.animations && gltf.animations.length) ? SkeletonUtils.clone(gltf.scene) : gltf.scene.clone();
}

/* ---- module state ---- */
let map=null, scene=null, camera=null, renderer=null, clock=null;
const entries = new Map();   // id -> {url, mesh, mixer, gltfAnimations, playingClip, loading}
let animRafId=null;

// Animation needs continuous repaints while something is actually playing
// — MapLibre only calls a custom layer's render() when something triggers
// a repaint (pan/zoom/interaction) otherwise, so an idle editor with a
// static preview and no pending placement burns nothing extra.
//
// Also covers a placement STILL waiting on terrain data (e.mesh set,
// e.refBase not — see placeMesh()'s deferred-placement path): confirmed
// live that DEM-tile-load does NOT reliably call map.triggerRepaint() on
// its own, so a mesh that failed its first placement attempt (terrain on,
// DEM not loaded yet at that point — the real, common case on a fresh
// page load) could sit forever with nothing ever calling render() again to
// retry it. This loop self-drives repaints until every pending entry has
// actually been placed, then stops — same battery/idle-cost hygiene as
// the animation case, just gated on a different condition.
function ensureAnimLoop(){
  const anyAnimated = [...entries.values()].some(e=>e.mixer);
  const anyPending = [...entries.values()].some(e=>e.mesh && !e.refBase);
  if((anyAnimated||anyPending) && animRafId==null){
    const tick=()=>{ if(map) map.triggerRepaint(); animRafId=requestAnimationFrame(tick); };
    animRafId=requestAnimationFrame(tick);
  } else if(!anyAnimated && !anyPending && animRafId!=null){
    cancelAnimationFrame(animRafId); animRafId=null;
  }
}

// Ground-relative altitude — SAME fix as this session's vertical-extent
// cylinder work, inverted: MercatorCoordinate.fromLngLat's altitude param
// is ABSOLUTE (meters above sea level), but anchor.altM is a small relative
// offset (0-5m typically). With terrain on (~800-1500m ground around Golden
// BC), placing a mesh directly at anchor.altM buries it roughly a
// kilometer underground. Returns null (caller skips repositioning this
// tick, keeps last known position) when terrain is on but DEM data hasn't
// loaded at this point yet — same transient-null handling already used for
// the vext feature's queryTerrainElevation() calls.
function groundRelativeAlt(lngLat, altM){
  if(!map.getTerrain()) return altM||0;
  const g = map.queryTerrainElevation(lngLat);
  return g==null ? null : g+(altM||0);
}

// Positions + scales a mesh in the shared `scene`'s own local-metres frame
// (east, up, north) — NOT hand-rolled mercator-space matrix math. Earlier
// versions of this function built mesh.matrix by hand (translate * scale
// * rotateX, claiming to match "the canonical MapLibre/Mapbox three.js
// example") — that claim was never actually checked against the real
// example source, and turned out to be wrong: the real official terrain
// example (fetched and verified directly, maplibre.org's own
// "adding-3d-models-using-threejs-on-terrain" page) applies the Y-up
// (three.js/glTF) -> Z-up (mercator) conversion ONCE to the whole `scene`
// (scene.rotateX(Math.PI/2) + scene.scale.multiply(1,1,-1) — see onAdd()),
// with each individual model just using plain .position/.scale like any
// normal three.js object. Our old per-mesh hand-rolled composition did a
// SINGLE sign flip (Y) in a different order than the official's net-EVEN
// (two-flip) pipeline — an odd total number of negative-determinant
// transforms inverts every triangle's winding order, and three.js's
// default backface culling (GLTFLoader's default FrontSide material)
// then silently culls 100% of the model's triangles from every viewing
// angle. (three.js auto-flips gl.frontFace when it detects a negative
// determinant in an object's OWN matrixWorld — but a reflection baked
// into camera.projectionMatrix instead, as ours was, is invisible to
// that check, so nothing compensates for it.) Confirmed live as the
// actual cause of a real "renders nothing at all" report, in both edit
// and Test Mode, terrain on either way (winding is terrain-independent)
// — not a positioning/precision bug (already separately fixed by then).
//
// Returns false if positioning couldn't be computed this tick (terrain on
// but DEM tiles not loaded yet) — caller (render()'s retry pre-pass)
// re-attempts on a later frame rather than placing at a wrong position.
function placeMesh(e, centerLatLon, anchor, objScale){
  const mesh=e.mesh;
  const lngLat=[centerLatLon[1], centerLatLon[0]];
  const absAlt=groundRelativeAlt(lngLat, anchor.altM);
  if(absAlt==null){
    // Terrain is on but DEM tiles haven't loaded at this point yet (real
    // at page-load time — happened live: the object never got a first
    // placement, e.refBase stayed unset, and the withMesh filter in
    // render() then permanently excluded it since nothing ever retried).
    // render()'s pre-pass now retries this every call until it succeeds.
    console.debug('asset-preview-layer: placement deferred, terrain elevation not ready yet', e.url);
    return false;
  }
  // e.refBase (the object's full absolute mercator position, magnitude
  // ~0.5 — mid mercator range) is folded into camera.projectionMatrix in
  // render(), via a CPU double-precision matrix multiply, once per mesh
  // per frame — NOT combined with local vertex data on the GPU. See
  // render()'s own comment for why: putting an absolute ~0.5-magnitude
  // translation directly into a matrix that also holds real-scale local
  // vertex data causes a confirmed-live float32 precision collapse
  // ("noisy polygons, no shape at all").
  e.refBase=maplibregl.MercatorCoordinate.fromLngLat(lngLat, absAlt);
  // Everything below is in real METRES, relative to e.refBase — same
  // units/frame the official example's own model.position.set(east, up,
  // north) uses. "up" stays 0: unlike the official example (one shared
  // scene origin, every model's altitude expressed as a delta from it),
  // our per-mesh refBase already carries this object's own FULL absolute
  // altitude, so there's no separate altitude delta left to apply here.
  mesh.position.set(anchor.lonOffsetM||0, 0, anchor.latOffsetM||0);
  mesh.scale.setScalar(objScale||1);
  console.debug('asset-preview-layer: placed', e.url, 'absAlt', absAlt);
  return true;
}

function removeEntry(id){
  const e=entries.get(id);
  if(e && e.mesh) scene.remove(e.mesh);
  entries.delete(id);
}

async function ensureMeshLoaded(id, url){
  let e=entries.get(id);
  if(e && e.url===url) return e;
  if(e && e.url!==url) removeEntry(id);   // url changed (asset swapped) — rebuild
  e={url, mesh:null, mixer:null, gltfAnimations:null, playingClip:undefined, loading:true};
  entries.set(id, e);
  try{
    const gltf=await loadModelTemplate(url);
    if(!entries.has(id) || entries.get(id)!==e) return null;   // removed/superseded while loading
    const mesh=cloneModel(gltf);
    scene.add(mesh);
    e.mesh=mesh; e.loading=false;
    if(gltf.animations && gltf.animations.length){
      e.mixer=new THREE.AnimationMixer(mesh);
      e.gltfAnimations=gltf.animations;
    }
  }catch(err){
    entries.delete(id);
    return null;
  }
  return e;
}

function applyAnimationClip(e, wantClip){
  if(!e.mixer) return;
  if(e.playingClip===wantClip) return;
  e.mixer.stopAllAction();
  const clip=(wantClip && e.gltfAnimations.find(c=>c.name===wantClip)) || e.gltfAnimations[0];
  if(clip) e.mixer.clipAction(clip).play();
  e.playingClip=wantClip;
  ensureAnimLoop();
}

// Read-only introspection for the host's animation-clip picker UI — reuses
// the SAME modelCache setObjects()/ensureMeshLoaded() already populate (or
// primes it, if this is called first), so this never doubles the network
// cost of loading a given model.
async function listClipNames(url){
  const gltf=await loadModelTemplate(url);
  return (gltf.animations||[]).map(a=>a.name);
}

// Full desired-state diff, called on every render pass by the host — see
// this file's header comment for the identity-stability contract.
function setObjects(list){
  if(!map) return;   // install() hasn't completed yet (style still loading, or module beat the host to it)
  const wantIds=new Set(list.map(o=>o.id));
  for(const id of [...entries.keys()]) if(!wantIds.has(id)) removeEntry(id);
  list.forEach(async o=>{
    const e=await ensureMeshLoaded(o.id, o.url);
    if(!e || !e.mesh) return;   // still loading, or failed — next call will retry from the still-pending cache entry
    // Stashed on every call (not just first) so render()'s retry pre-pass
    // can re-attempt placeMesh with the CURRENT desired position/anchor if
    // the very first attempt failed (terrain on, DEM not loaded yet at
    // that point) — a call site that only retried with stale data from the
    // first setObjects() call would re-place at a since-edited anchor.
    e.want={center:o.center, anchor:o.anchor||{}, scale:o.scale};
    placeMesh(e, o.center, o.anchor||{}, o.scale);
    applyAnimationClip(e, o.animationClip);
    // Also re-evaluate HERE, not just after the forEach below: this whole
    // callback is async (awaits ensureMeshLoaded), so the synchronous
    // ensureAnimLoop() call after the forEach runs BEFORE any mesh has
    // actually finished loading — if placeMesh() just failed above (DEM
    // not ready yet) and nothing else ever calls ensureAnimLoop() again,
    // the self-repaint loop never starts at all, and render()'s own retry
    // block (which depends on that loop for its repaints) never runs
    // either — a deadlock, confirmed live as the reason the first version
    // of this retry fix still showed nothing.
    ensureAnimLoop();
  });
  ensureAnimLoop();
  map.triggerRepaint();
}

function onAdd(mapInstance, gl){
  scene=new THREE.Scene();
  // Y-up (three.js/glTF convention) -> mercator's local X-east/Y-north/
  // Z-up metres frame, applied ONCE to the whole scene — copied exactly
  // from MapLibre's own official terrain+three.js example (see
  // placeMesh()'s comment for why this specific technique, not a
  // per-mesh hand-rolled matrix, is required).
  scene.rotateX(Math.PI/2);
  scene.scale.multiply(new THREE.Vector3(1,1,-1));
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
  const dl=new THREE.DirectionalLight(0xffffff, 0.9); dl.position.set(1,2,1); scene.add(dl);
  camera=new THREE.Camera();   // projectionMatrix rebuilt per-mesh every frame in render() below
  renderer=new THREE.WebGLRenderer({canvas:mapInstance.getCanvas(), context:gl, antialias:true});
  renderer.autoClear=false;
  clock=new THREE.Clock();
}

// MapLibre 5.x's custom-layer render signature is render(gl, options) — an
// args OBJECT, not a raw matrix array (that was the pre-v5 Mapbox-style
// contract). Confirmed directly against maplibre-gl@5.24.0's own shipped
// .d.ts (CustomRenderMethodInput) before writing this, not assumed: the
// matrix lives at options.defaultProjectionData.mainMatrix, documented
// there as expecting coordinates in the same 0..1 normalized web-Mercator
// range MercatorCoordinate.fromLngLat() already produces — i.e. directly
// compatible with placeMesh()'s coordinates above, no further conversion
// needed.
//
// Renders one mesh at a time (toggling .visible, lights stay shared in
// `scene`) because each mesh needs its OWN camera.projectionMatrix — the
// raw mainMatrix combined, in CPU double precision, with THAT mesh's own
// absolute mercator reference point (e.refBase) AND the real-metres ->
// mercator-units scale factor at that point (mirroring the official
// example's own render()-time "l" matrix — see placeMesh()'s comment).
// Doing this combine in double precision on the CPU, once per mesh per
// frame, rather than feeding an absolute ~0.5-magnitude translation into
// a matrix that also holds real-scale local vertex data, avoids a
// confirmed-live float32 precision collapse ("noisy polygons, no shape
// at all").
const _mMain=new THREE.Matrix4(), _mL=new THREE.Matrix4(), _vScale=new THREE.Vector3();
function render(gl, options){
  _mMain.fromArray(options.defaultProjectionData.mainMatrix);
  const dt=clock.getDelta();
  entries.forEach(e=>{ if(e.mixer) e.mixer.update(dt); });
  // Retry placement for any mesh whose FIRST placeMesh() call failed (real
  // case: terrain on, DEM tiles not loaded yet at page-load time — the
  // object attaches, setObjects() runs before the map settles, e.refBase
  // never gets set, and without this retry the withMesh filter below
  // excludes it permanently, confirmed live). Cheap once placed (no-op —
  // e.refBase is already set, this block only fires for the still-unplaced
  // case); driven by ensureAnimLoop()'s self-repaint loop (see its own
  // comment — DEM-tile-load does not reliably trigger a repaint on its
  // own, confirmed live), not by hoping something else calls render().
  entries.forEach(e=>{
    if(e.mesh && !e.refBase && e.want) placeMesh(e, e.want.center, e.want.anchor, e.want.scale);
  });
  ensureAnimLoop();   // re-evaluate: stop the self-repaint loop once every pending entry above just got placed
  const withMesh=[...entries.values()].filter(e=>e.mesh && e.refBase);
  // three.js and MapLibre both cache GL state on the shared context and
  // will corrupt each other's rendering without this reset before/after —
  // once per render() call (not per mesh); three.js keeps its own state
  // consistent across its own consecutive render() calls.
  renderer.resetState();
  withMesh.forEach(e=>{ e.mesh.visible=false; });
  withMesh.forEach(e=>{
    e.mesh.visible=true;
    const mUnit=e.refBase.meterInMercatorCoordinateUnits();
    _mL.makeTranslation(e.refBase.x,e.refBase.y,e.refBase.z).scale(_vScale.set(mUnit,-mUnit,mUnit));
    camera.projectionMatrix.copy(_mMain).multiply(_mL);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    renderer.render(scene, camera);
    e.mesh.visible=false;
  });
  withMesh.forEach(e=>{ e.mesh.visible=true; });
  renderer.resetState();
}

const customLayer={
  id:'asset-preview-3d',
  type:'custom',
  // '3d' (not the default '2d'): fence-editor.html's whole reason for
  // having a tilted/terrain-aware map is 3D Mode, and a pitched view with
  // terrain needs MapLibre's full 3D projection matrix for correct
  // depth/positioning — not yet empirically confirmed against a real
  // terrain-on scene in this environment (no way to visually verify here),
  // flagged as the first thing to check once someone looks at this live.
  renderingMode:'3d',
  onAdd, render
};

function install(mapInstance){
  if(map) return;   // already installed — safe to call more than once
  map=mapInstance;
  if(map.isStyleLoaded()) map.addLayer(customLayer);
  else map.once('load', ()=>map.addLayer(customLayer));
}

// Module/map-load race handshake. fence-editor.html is a classic script
// that constructs its map synchronously near the top of its own giant
// inline <script>; this module is a deferred, CDN-loaded ES module that
// may finish loading before OR after that point — real machine-timing, not
// something to assume an order for (the same registration-order-race class
// as the vext-vol layer-visibility bug found live this session: a function
// called before the thing it operates on existed, silently no-op'ing).
// The host stashes its map reference unconditionally right after
// construction (window._fenceEditorMap = map) AND calls
// window.AssetPreviewLayer?.install(map) at that same point — handling the
// "module already loaded" case. This check handles the other order: if
// this module finishes loading AFTER the host already stashed its map.
if(typeof window!=='undefined' && window._fenceEditorMap) install(window._fenceEditorMap);

window.AssetPreviewLayer={ install, setObjects, listClipNames };
