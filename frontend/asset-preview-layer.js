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

// Animation only needs continuous repaints while something is actually
// playing — MapLibre only calls a custom layer's render() when something
// triggers a repaint (pan/zoom/interaction) otherwise, so an idle editor
// with a static (or zero) preview burns nothing extra.
function ensureAnimLoop(){
  const anyAnimated = [...entries.values()].some(e=>e.mixer);
  if(anyAnimated && animRafId==null){
    const tick=()=>{ if(map) map.triggerRepaint(); animRafId=requestAnimationFrame(tick); };
    animRafId=requestAnimationFrame(tick);
  } else if(!anyAnimated && animRafId!=null){
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

// Positions + scales a mesh directly in MapLibre's Mercator-normalized
// coordinate space (not the "bake one static object's transform into the
// shared camera" trick from MapLibre's own single-model example — that
// doesn't generalize to multiple independently-positioned objects in one
// layer). Each mesh carries its own tiny per-location scale
// (meterInMercatorCoordinateUnits()) and lat/lon offsets are applied as a
// direct planar approximation scaled by that same factor — consistent with
// how this codebase's own destPoint()/haversineM() 2D handle math already
// treats small offsets as locally planar, just extended to 3D here.
// Returns false if positioning couldn't be computed this tick (terrain not
// loaded yet) — mesh keeps its last position rather than jumping to (0,0,0).
//
// Mercator-normalized space (x east, y south, z up) is LEFT-handed;
// three.js is right-handed — a naive uniform-positive mesh.scale renders
// every model mirrored. The composition order three.js actually applies is
// T·R·S (translate, then rotate, then scale, each in the PARENT's frame at
// matrix-build time) — negating y on mesh.scale alone doesn't correctly
// cancel the handedness once combined with the Y-up->Z-up rotation below,
// since scale and rotation don't commute. Sidestepping that trap entirely
// by building the model matrix by hand, in the exact order the canonical
// MapLibre/Mapbox three.js custom-layer example uses: translate, THEN
// scale(s,-s,s), THEN rotateX(90°) — composed right-to-left as
// T * S * R, i.e. the rotation is applied first to raw model space, then
// the (handedness-flipped) scale, then the translation.
//
// PRECISION: mesh.matrix's translation only ever carries the SMALL delta
// from this object's own absolute mercator position (anchor lat/lon
// offset converted to mercator units — z=0, altitude is already fully
// baked into absAlt/base.z, no separate offset needed). The FULL absolute
// position (base, magnitude ~0.5 — mid mercator range) is stashed on the
// entry (e.refBase) and folded into camera.projectionMatrix in render(),
// via a CPU double-precision matrix multiply, once per mesh per frame —
// NOT combined with local vertex data on the GPU. Putting the absolute
// ~0.5 translation directly in mesh.matrix (the original version of this
// function) causes real, confirmed-live visual corruption: float32's ULP
// at 0.5 (~6e-8) is coarser than the per-vertex offsets a real-scale local
// mesh produces once scaled down by the mercator-per-metre factor
// (~1e-8), so the GPU's float32 modelViewMatrix*vertex multiply quantizes
// every vertex onto a handful of grid points — "noisy polygons, no shape
// at all", exactly what was reported live. Exactly one factor (refBase,
// composed in camera.projectionMatrix) may ever carry the absolute
// position; mesh.matrix's translation must stay near zero.
const _mA=new THREE.Matrix4(), _mB=new THREE.Matrix4();
function placeMesh(e, centerLatLon, anchor, objScale){
  const mesh=e.mesh;
  const lngLat=[centerLatLon[1], centerLatLon[0]];
  const absAlt=groundRelativeAlt(lngLat, anchor.altM);
  if(absAlt==null) return false;
  const base=maplibregl.MercatorCoordinate.fromLngLat(lngLat, absAlt);
  // mUnit converts real metres -> mercator units at this point, independent
  // of the object's own scale factor — used for the anchor's lat/lon
  // offsets. scaleM (mUnit * objScale) is only for the mesh's own size; if
  // both used scaleM, a scale-2 object's position offsets would double too.
  const mUnit=base.meterInMercatorCoordinateUnits();
  const scaleM=mUnit*(objScale||1);
  // Mercator-normalized space: +x east, +y SOUTH (standard web-tile
  // convention, opposite of geographic north-positive latitude) — so a
  // north-positive latOffsetM subtracts from dy. Small deltas only (see
  // PRECISION note above) — base's own absolute x/y/z go on e.refBase,
  // not here.
  const dx=(anchor.lonOffsetM||0)*mUnit;
  const dy=-(anchor.latOffsetM||0)*mUnit;
  mesh.matrixAutoUpdate=false;
  mesh.matrix
    .makeTranslation(dx,dy,0)
    .multiply(_mA.makeScale(scaleM,-scaleM,scaleM))
    .multiply(_mB.makeRotationX(Math.PI/2));
  // matrixAutoUpdate=false means three.js's own updateMatrix() never runs
  // (that's the one place matrixWorldNeedsUpdate normally gets set) — flag
  // it manually or the scene-graph traversal in render() silently keeps
  // using a stale matrixWorld (only ever computed once, on the frame this
  // mesh was first added) and the mesh never visibly moves again.
  mesh.matrixWorldNeedsUpdate=true;
  e.refBase=base;
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
    placeMesh(e, o.center, o.anchor||{}, o.scale);
    applyAnimationClip(e, o.animationClip);
  });
  ensureAnimLoop();
  map.triggerRepaint();
}

function onAdd(mapInstance, gl){
  scene=new THREE.Scene();
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
// absolute mercator reference point (e.refBase). See placeMesh()'s
// PRECISION comment for why: combining mainMatrix with an absolute
// ~0.5-magnitude translation and local vertex data all in one GPU float32
// multiply loses enough precision to visibly corrupt the geometry.
// Composing main*T(refBase) on the CPU first, then feeding the GPU only a
// small delta-from-refBase translation (already baked into mesh.matrix),
// keeps every GPU-side value in a precision-safe range.
const _mMain=new THREE.Matrix4(), _mRefT=new THREE.Matrix4();
function render(gl, options){
  _mMain.fromArray(options.defaultProjectionData.mainMatrix);
  const dt=clock.getDelta();
  entries.forEach(e=>{ if(e.mixer) e.mixer.update(dt); });
  const withMesh=[...entries.values()].filter(e=>e.mesh && e.refBase);
  // three.js and MapLibre both cache GL state on the shared context and
  // will corrupt each other's rendering without this reset before/after —
  // once per render() call (not per mesh); three.js keeps its own state
  // consistent across its own consecutive render() calls.
  renderer.resetState();
  withMesh.forEach(e=>{ e.mesh.visible=false; });
  withMesh.forEach(e=>{
    e.mesh.visible=true;
    camera.projectionMatrix.copy(_mMain).multiply(_mRefT.makeTranslation(e.refBase.x,e.refBase.y,e.refBase.z));
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
