/* ar-view.js — camera-fallback AR view (window.ARView)
 *
 * AR/3D plan Phase 2, built 2026-08-14 after deciding to skip true WebXR
 * entirely: iOS Safari has zero `navigator.xr` immersive-ar support, and
 * this app is heavily iOS-used (see CLAUDE.md's iOS audio-unlock section
 * for how much prior pain this codebase has already hit on iOS Safari
 * quirks alone). Instead: a live camera feed with a glTF/GLB model
 * (`zone.arObjects[]`, from the Phase 0 asset library) rendered on top,
 * positioned by GPS bearing/distance + device compass/tilt — not real
 * SLAM/surface-detection/depth-sensing. One codepath, works identically on
 * iOS and Android.
 *
 * Loaded as an ES module (`<script type="module" src="/ar-view.js">` +
 * an importmap for "three"/"three/addons/") since three.js ships ESM-only
 * — the first module script in this repo, everything else is classic
 * `<script src>`. geofence-engine.html (a classic script) must therefore
 * only ever reach into `window.ARView` lazily, inside event handlers, never
 * at top-level script-parse time — same extraction shape already used for
 * `BleGPS` (frontend/ble-gps.js).
 *
 * Deliberately self-contained: never reads BUNDLE/HUD/Geofencer/MapView
 * from geofence-engine.html directly. The caller resolves a zone's current
 * center (via centerNow() for a path stop) and its arObjects[] itself and
 * passes them into open()/onFix() as plain data.
 *
 * Host contract:
 *   ARView.open({videoEl, canvas, label, zoneCenter:[lat,lon], arObjects:[...],
 *                visitorLatLon:[lat,lon], onClosed})
 *     label (optional) is a DOM element this module writes a permanent
 *     live debug readout into every frame — heading/source/beta/gamma and
 *     the bearing to the nearest active object — for diagnosing on-device
 *     compass issues that can't be reproduced off-device. Same pattern as
 *     field-recorder.html's own debug readout.
 *     onClosed is called exactly once whenever this session ends, from
 *     EVERY close path — an explicit close() call, an open() failure, or
 *     this module's own visibilitychange auto-close on phone lock/app
 *     switch. The host's DOM restoration (hide the AR overlay, show the
 *     map back) belongs in onClosed, not duplicated in a close-button
 *     handler — otherwise an auto-close strands the overlay on screen.
 *   ARView.onFix(visitorLatLon)   — call once per GPS tick while open
 *   ARView.close()
 *   ARView.isOpen()
 *   ARView.requestOrientationPermission()  — iOS gate; call as the FIRST
 *     statement in a real tap handler, before open() and before any other
 *     await, or iOS silently denies it (transient-activation window).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
// SkeletonUtils.js has no export literally named `SkeletonUtils` — it
// exports individual functions (clone/retarget/retargetClip) — so this
// must be a namespace import, not a named one. Verified against the file
// directly (fetched, checked its export statements) before writing this.
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const draco = new DRACOLoader();
draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/libs/draco/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(draco);

/* ---- local planar-offset math ----
 * Deliberately NOT reading geofence-engine.html's own `Geo` object via
 * `window.Geo`: `const Geo = {...}` in a classic <script> creates a
 * lexical binding in the global declarative environment, not a property
 * of `window` — only `var`/function declarations do that. A cross-module
 * `window.Geo` read here would be `undefined`. This is the same tiny
 * equirectangular-approximation math as that object's own toXY(), just a
 * local copy so this module has no fragile coupling to the host page. */
const M_PER_DEG_LAT = 111320;
function mPerDegLon(lat){ return 111320 * Math.cos(lat*Math.PI/180); }
function toXY(p, ref){ return { x:(p[1]-ref[1])*mPerDegLon(ref[0]), y:(p[0]-ref[0])*M_PER_DEG_LAT }; }

/* ---- device orientation ----
 * A deliberate, scoped reintroduction of device-compass reliance, isolated
 * entirely from TravelHeading (the walking-navigation heading source in
 * geofence-engine.html, which stays GPS-travel-heading-only and untouched
 * by this module). guidance-bot.js dropped device compass on 2026-07-26
 * for phone-in-pocket unreliability — CLAUDE.md says any future
 * reintroduction "must be an explicit flagged decision, not a silent
 * revert." This is that decision: the AR view is a held-up,
 * actively-looked-at-the-screen context, the opposite of phone-in-pocket,
 * where a compass reading is actually meaningful. Active only while the AR
 * overlay is open (start()/stop() below), never running in the background.
 *
 * Two real, different platform paths, not one:
 *   iOS Safari    — event.webkitCompassHeading, already true-north
 *                   referenced clockwise; requires an explicit
 *                   requestPermission() gate.
 *   Android       — deviceorientationabsolute event / event.absolute===true,
 *                   no permission gate exists.
 *   Anything else — plain deviceorientation event.alpha, RELATIVE and
 *                   uncalibrated (may drift) — used only as a last resort. */
// Smoothing time constant for AROrient's low-pass filter, below. Raw
// deviceorientation events reach the camera every frame with zero
// filtering by default, which reads as visible jitter on ordinary hand
// tremor (confirmed live 2026-08-14: "compass seems unstable, very
// sensitive to motion of the phone"). Time-based (not per-sample-count-
// based) so it behaves consistently regardless of how fast the browser
// actually fires orientation events (varies by platform, unlike GPS's
// fixed ~1Hz — a fixed per-sample alpha would over- or under-smooth
// depending on event rate; this doesn't).
const ORIENT_SMOOTH_TAU_MS = 150;
const AROrient = {
  // Raw = latest instantaneous sensor reading (kept for reference/debug).
  // Smoothed (*S) = what actually drives the camera — see applyDeviceQuaternion() below.
  alpha:0, beta:0, gamma:0, alphaS:0, betaS:0, gammaS:0,
  ready:false, source:null, _lastT:0,
  _handler(e){
    let alpha;
    if(e.webkitCompassHeading!=null){
      alpha=(360-e.webkitCompassHeading)%360;   // convert to the CCW convention applyDeviceQuaternion() expects
      AROrient.source='ios-compass';
    } else if(e.absolute===true && e.alpha!=null){
      alpha=e.alpha; AROrient.source='android-absolute';
    } else if(e.alpha!=null){
      alpha=e.alpha; AROrient.source='relative-uncalibrated';
    } else return;
    const beta=e.beta||0, gamma=e.gamma||0;
    const now=performance.now();
    if(!AROrient.ready){
      // First reading — snap straight to it rather than smoothing from a
      // stale 0, or the camera would visibly swing in from zero on open.
      AROrient.alphaS=alpha; AROrient.betaS=beta; AROrient.gammaS=gamma;
    } else {
      const dt=Math.max(0, now-AROrient._lastT);
      const a=1-Math.exp(-dt/ORIENT_SMOOTH_TAU_MS);
      // alpha is circular (wraps 0/360) — a naive linear blend breaks near
      // the wrap boundary (e.g. 359° and 1° would average to 180°, exactly
      // backwards). Blend as a unit vector and convert back instead, same
      // technique CLAUDE.md documents guidance-bot.js already using for
      // its own GPS-heading smoothing.
      const curRad=AROrient.alphaS*Math.PI/180, newRad=alpha*Math.PI/180;
      const x=Math.cos(curRad)*(1-a)+Math.cos(newRad)*a;
      const y=Math.sin(curRad)*(1-a)+Math.sin(newRad)*a;
      AROrient.alphaS=(Math.atan2(y,x)*180/Math.PI+360)%360;
      // beta/gamma don't approach their wrap boundaries in normal
      // held-up-facing-forward AR use, so plain linear blending is fine.
      AROrient.betaS=AROrient.betaS*(1-a)+beta*a;
      AROrient.gammaS=AROrient.gammaS*(1-a)+gamma*a;
    }
    AROrient._lastT=now;
    AROrient.alpha=alpha; AROrient.beta=beta; AROrient.gamma=gamma; AROrient.ready=true;
  },
  start(){
    this._lastT=0;
    if('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', this._handler, true);
    else window.addEventListener('deviceorientation', this._handler, true);
  },
  stop(){
    window.removeEventListener('deviceorientationabsolute', this._handler, true);
    window.removeEventListener('deviceorientation', this._handler, true);
    this.ready=false; this.source=null;
  },
  // iOS-only permission gate — must be the first statement inside a real
  // tap handler (do not await anything else first). Android/desktop have
  // no such gate and just resolve true.
  async requestPermission(){
    if(typeof DeviceOrientationEvent!=='undefined' && typeof DeviceOrientationEvent.requestPermission==='function'){
      try{ return (await DeviceOrientationEvent.requestPermission())==='granted'; }catch(e){ return false; }
    }
    return true;
  }
};

// Camera-orientation quaternion from alpha/beta/gamma + screen orientation —
// the standard formula three.js's own DeviceOrientationControls used before
// it was removed from the examples set; still the correct approach, not
// worth reinventing.
const _zee=new THREE.Vector3(0,0,1), _euler=new THREE.Euler(), _q0=new THREE.Quaternion();
const _q1=new THREE.Quaternion(-Math.sqrt(0.5),0,0,Math.sqrt(0.5)); // -PI/2 around X
function applyDeviceQuaternion(cameraQuat, alphaDeg, betaDeg, gammaDeg, screenOrientDeg){
  const D=Math.PI/180;
  _euler.set(betaDeg*D, alphaDeg*D, -gammaDeg*D, 'YXZ');
  cameraQuat.setFromEuler(_euler);
  cameraQuat.multiply(_q1);
  cameraQuat.multiply(_q0.setFromAxisAngle(_zee, -screenOrientDeg*D));
}

/* ---- module state ---- */
let renderer=null, scene=null, camera=null, videoEl=null, labelEl=null;
let stream=null, rafId=null, clock=null;
let mixers=[];        // active THREE.AnimationMixer instances, ticked every frame
let active=[];         // [{mesh, zoneCenter:[lat,lon], anchor:{latOffsetM,lonOffsetM,altM}}]
let lastVisitorLatLon=null;   // most recent onFix() position, for the debug readout below
const modelCache=new Map();   // url -> loaded GLTF (template; clone before adding to scene)

function initScene(canvas){
  renderer=new THREE.WebGLRenderer({canvas, alpha:true, antialias:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  scene=new THREE.Scene();
  camera=new THREE.PerspectiveCamera(65, window.innerWidth/window.innerHeight, 0.1, 2000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
  const dl=new THREE.DirectionalLight(0xffffff, 0.9); dl.position.set(1,2,1); scene.add(dl);
}
function onResize(){
  if(!renderer || !camera) return;
  camera.aspect=window.innerWidth/window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

async function startCamera(){
  stream=await navigator.mediaDevices.getUserMedia({
    video:{ facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720} },
    audio:false
  });
  videoEl.srcObject=stream;
  await videoEl.play();
}

async function loadModelTemplate(url){
  if(modelCache.has(url)) return modelCache.get(url);
  const gltf=await new Promise((res,rej)=>gltfLoader.load(url, res, undefined, rej));
  modelCache.set(url, gltf);
  return gltf;
}
// Skinned/animated models need SkeletonUtils.clone(), not plain .clone() —
// a plain clone breaks the skeleton bindings silently (mesh renders but
// never animates, or renders collapsed).
function cloneModel(gltf){
  return (gltf.animations && gltf.animations.length) ? SkeletonUtils.clone(gltf.scene) : gltf.scene.clone();
}

// anchor offsets are planar metres (already, not degrees) — add directly
// onto the zone-center-relative-to-visitor offset, no unit conversion.
// anchor.altM is "raise/lower relative to where the visitor is standing,"
// not an absolute elevation — GPS/DEM altitude are both too noisy to be a
// usable vertical datum at AR placement scale.
function placeMesh(mesh, zoneCenterLatLon, visitorLatLon, anchor){
  const base=toXY(zoneCenterLatLon, visitorLatLon);
  const worldX = base.x + (anchor.lonOffsetM||0);
  const worldNorth = base.y + (anchor.latOffsetM||0);
  mesh.position.set(worldX, anchor.altM||0, -worldNorth);   // three.js: +Y up, -Z north
}
// Same bearing formula as geofence-engine.html's own Geo.bearing() — a
// local copy for the same reason toXY() is local (no window.Geo coupling).
function bearingTo(a, b){
  const y=Math.sin((b[1]-a[1])*Math.PI/180)*Math.cos(b[0]*Math.PI/180);
  const x=Math.cos(a[0]*Math.PI/180)*Math.sin(b[0]*Math.PI/180)-
          Math.sin(a[0]*Math.PI/180)*Math.cos(b[0]*Math.PI/180)*Math.cos((b[1]-a[1])*Math.PI/180);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}

async function loadArObjects(zoneCenter, arObjects, visitorLatLon){
  for(const obj of arObjects){
    if(!obj.url) continue;   // unresolved (asset deleted from palette, or publish-time fetch failed) — skip, don't throw
    try{
      const gltf=await loadModelTemplate(obj.url);
      const mesh=cloneModel(gltf);
      const rot=obj.rotationDeg||{x:0,y:0,z:0};
      mesh.rotation.set((rot.x||0)*Math.PI/180, (rot.y||0)*Math.PI/180, (rot.z||0)*Math.PI/180);
      mesh.scale.setScalar(obj.scale||1);
      // obj.occlusion intentionally unread — designed for WebXR depth
      // sensing, explicitly out of scope for this camera+compass fallback.
      // Don't fake real-world occlusion against the raw video feed.
      scene.add(mesh);
      const anchor=obj.anchor||{latOffsetM:0,lonOffsetM:0,altM:0};
      if(zoneCenter && visitorLatLon) placeMesh(mesh, zoneCenter, visitorLatLon, anchor);
      active.push({mesh, zoneCenter, anchor});
      if(gltf.animations && gltf.animations.length){
        const mixer=new THREE.AnimationMixer(mesh);
        const clip=(obj.animationClip && gltf.animations.find(c=>c.name===obj.animationClip)) || gltf.animations[0];
        mixer.clipAction(clip).play();
        mixers.push(mixer);
      }
    }catch(e){ /* one bad/unreachable model shouldn't block the others */ }
  }
}

// Permanent lightweight debug readout (matches this repo's own established
// pattern for a live-device-only bug that can't be reproduced off-device —
// see field-recorder.html's debug readout, added for a similar reason).
// Shows the human-compass-equivalent heading (inverse of the ios-compass
// conversion below, so it's directly comparable against a real compass
// app on the same phone) computed from the SMOOTHED reading (what the
// camera actually uses), its source, smoothed beta/gamma, and the bearing
// to the nearest active object + the delta between them — a delta near 0°
// means "should be dead ahead," near 180° means "should be behind."
function updateDebugLabel(){
  if(!labelEl) return;
  const displayHeading=Math.round((360-AROrient.alphaS)%360);
  let extra='';
  if(active.length && lastVisitorLatLon){
    const a=active[0];
    if(a.zoneCenter){
      const brg=Math.round(bearingTo(lastVisitorLatLon, a.zoneCenter));
      const delta=Math.round(((brg-displayHeading)%360+360)%360);
      extra=' | obj brg '+brg+'° Δ'+delta+'°';
    }
  }
  labelEl.textContent='hdg '+displayHeading+'° ('+(AROrient.source||'none')+') '+
    'β'+Math.round(AROrient.betaS)+' γ'+Math.round(AROrient.gammaS)+extra;
}

function render(){
  const screenOrient=(screen.orientation && screen.orientation.angle) || window.orientation || 0;
  applyDeviceQuaternion(camera.quaternion, AROrient.alphaS, AROrient.betaS, AROrient.gammaS, screenOrient);
  const dt=clock.getDelta();
  mixers.forEach(m=>m.update(dt));
  renderer.render(scene, camera);
  updateDebugLabel();
  rafId=requestAnimationFrame(render);
}

/* ---- public API ---- */
let _onClosed=null;   // caller's DOM-restoration hook — see close()'s own comment
async function open({videoEl:videoElArg, canvas, label, zoneCenter, arObjects, visitorLatLon, onClosed}){
  if(rafId!=null) return;   // already open
  videoEl=videoElArg; labelEl=label||null;
  _onClosed=onClosed||null;
  lastVisitorLatLon=visitorLatLon||null;
  try{
    initScene(canvas);
    clock=new THREE.Clock();
    active=[]; mixers=[];
    await startCamera();
    AROrient.start();
    window.addEventListener('resize', onResize);
    await loadArObjects(zoneCenter, arObjects||[], visitorLatLon);
    rafId=requestAnimationFrame(render);
  }catch(e){
    close();   // clean up any partial state (camera/scene/listeners) before surfacing the error
    throw e;
  }
}

function onFix(visitorLatLon){
  if(rafId==null) return;
  lastVisitorLatLon=visitorLatLon;
  active.forEach(a=>{ if(a.zoneCenter) placeMesh(a.mesh, a.zoneCenter, visitorLatLon, a.anchor); });
}

// Explicit, enumerated teardown — every one of these matters. Skipping any
// is a real, user-visible failure mode (camera-in-use indicator stuck on).
// Safe to call at any point, including a partially-opened state.
//
// This module has no access to the host page's DOM (deliberately
// self-contained — see the file header), but close() can fire from INSIDE
// this module too (the visibilitychange listener below, or open()'s own
// catch block) — not just from the host's close-button handler. If DOM
// restoration (hiding #arView, showing #map back) only lived in the host's
// button handler, a phone-lock-triggered auto-close would strand the
// overlay on screen with a frozen video and no visible way out. So open()
// takes an `onClosed` callback and close() always fires it, exactly once
// per open()/close() pair — the host's button handler doesn't need its own
// separate restoration logic, it just calls close() (or lets this module
// call it) and the callback given to open() is the single source of truth.
function close(){
  if(rafId!=null){ cancelAnimationFrame(rafId); rafId=null; }
  if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
  if(videoEl) videoEl.srcObject=null;
  AROrient.stop();
  window.removeEventListener('resize', onResize);
  if(scene) scene.clear();
  if(renderer){ renderer.dispose(); renderer=null; }
  scene=null; camera=null; clock=null; mixers=[]; active=[];
  labelEl=null; lastVisitorLatLon=null;
  if(_onClosed){ const cb=_onClosed; _onClosed=null; cb(); }
}

function isOpen(){ return rafId!=null; }
async function requestOrientationPermission(){ return AROrient.requestPermission(); }

// Phone lock / app switch while AR is open must not leave the camera
// running — close() (and therefore the host's onClosed callback) fires
// here too, not just from the host's close button.
window.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden' && isOpen()) close(); });

window.ARView = { open, close, onFix, requestOrientationPermission, isOpen };
