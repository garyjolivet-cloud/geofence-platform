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
 *                visitorLatLon:[lat,lon], zoneRadiusM, zoneAltM, zoneAltToleranceM,
 *                hazardCylinders, distFarM, distClearM, onClosed})
 *     label (optional) is a DOM element this module writes a permanent
 *     live debug readout into every frame — heading/source/beta/gamma and
 *     the bearing to the nearest active object — for diagnosing on-device
 *     compass issues that can't be reproduced off-device. Same pattern as
 *     field-recorder.html's own debug readout.
 *     zoneRadiusM/zoneAltM/zoneAltToleranceM (all optional — item A,
 *     2026-08-14): when the open zone is a real cylinder trigger volume
 *     (circle shape + vertical extent, same isCylinder condition the
 *     trigger engine uses), renders it as a translucent cylinder mesh
 *     alongside any placed arObjects. See onFix()'s own comment for how
 *     its vertical position is kept correct as the visitor's altitude
 *     changes.
 *     onClosed is called exactly once whenever this session ends, from
 *     EVERY close path — an explicit close() call, an open() failure, or
 *     this module's own visibilitychange auto-close on phone lock/app
 *     switch. The host's DOM restoration (hide the AR overlay, show the
 *     map back) belongs in onClosed, not duplicated in a close-button
 *     handler — otherwise an auto-close strands the overlay on screen.
 *   ARView.onFix(visitorLatLon, visitorAltM)   — call once per GPS tick
 *     while open. visitorAltM (optional) keeps a vertical-extent cylinder's
 *     height tracking the visitor's real altitude — see onFix()'s comment.
 *   ARView.close()
 *   ARView.isOpen()
 *   ARView.requestOrientationPermission()  — iOS gate; call as the FIRST
 *     statement in a real tap handler, before open() and before any other
 *     await, or iOS silently denies it (transient-activation window).
 *   ARView.fadeOutAndClose(durationS)   — Phase 3 (trigger-based show/
 *     hide): the host calls this when it detects the visitor has walked
 *     out of the zone this session opened for (this view has no per-zone
 *     reload path — one session is locked to whatever zone it opened
 *     with, see Phase 2 scoping above — so leaving that zone means
 *     there's nothing left to show here). Ramps every loaded object's
 *     opacity down, then calls close(). durationS falls back to a short
 *     baked-in minimum when 0/omitted, so the transition never reads as
 *     an instant pop right before the camera view itself vanishes.
 *   ARView.preload(urls)   — Phase 4 (predictive preload): call while the
 *     visitor is still APPROACHING a stop, before open() would ever run,
 *     so the model's already fetched+parsed by the time they tap AR.
 *     Doesn't touch scene/camera/anything open()-specific — just warms
 *     the same modelCache loadArObjects() reads from.
 *   open()'s hazardCylinders (Phase 5b, AR occlusion, optional) —
 *     [{center:[lat,lon], radiusM, bottom, top}], a snapshot of nearby
 *     hazard cylinders (same circle+altM geometry the trigger engine's
 *     forward hazard raycasting, Phase 5a, already uses) taken once at
 *     open() time. Any placed arObject with obj.occlusion:true fades out
 *     (closed-form segment-vs-cylinder test, computed in onFix() at
 *     GPS-fix rate — no THREE.Raycaster, every occluder here is a known
 *     analytic cylinder, not scanned geometry) when one of these cylinders
 *     genuinely sits between the visitor and the object, and fades back in
 *     once the line of sight clears.
 *   open()'s distFarM/distClearM (both optional, 2026-08-18 field report
 *     "the duck should fade the same as audio distance") — every placed
 *     arObject fades with distance-to-zoneCenter using the SAME curve
 *     geofence-engine.html's SpatialVoice/AmbientVoice use for a stop's
 *     recorded audio (pass the host's own zoneAudioFadeRadii(zone) output
 *     here so the two are literally the same numbers, not just visually
 *     similar). Falls back to SpatialVoice's own defaults (64/8) if
 *     omitted.
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
// Phase 5b (AR occlusion) — snapshot of nearby hazard cylinders, taken
// once at open() (see open()'s own comment on why snapshotting is
// acceptable for v1). [{center:[lat,lon], radiusM, bottom, top}], bottom/
// top are ABSOLUTE altitudes (converted to visitor-relative in onFix(),
// same as the vext cylinder's own altitude handling).
let hazardCylinders=[];
const OCCLUSION_FADE_S=0.4;   // full opacity transition when occlusion state flips — short, this is a visibility correction, not an authored fade

// Distance-based opacity fade (2026-08-18 field report: "the duck should
// fade the same as audio distance") — reuses the EXACT curve
// geofence-engine.html's SpatialVoice/AmbientVoice already use for a
// stop's recorded-audio volume, so "same as audio" is literal, not
// approximate. distFarM/distClearM come from the host's own
// zoneAudioFadeRadii(zone) (same helper feeding the audio fade + the
// map's own fadeband rings), passed into open(); fall back to that
// helper's own defaults if the host omits them. fadeGain() is a local
// copy of geofence-engine.html's function of the same name — same
// no-window-coupling reasoning as toXY()/bearingTo() above.
let distFarM=64, distClearM=8;
const DIST_FADE_DB_RANGE=30;
function distFadeGain(f){
  const floor=Math.pow(10,-DIST_FADE_DB_RANGE/20);
  return (Math.pow(10,-DIST_FADE_DB_RANGE*f/20)-floor)/(1-floor);
}
const DISTANCE_FADE_S=0.6;   // opacity transition rate as distanceFactor's target changes — short enough to track a walking visitor without visible stepping between 1Hz GPS fixes

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
// Phase 4 (predictive preload) — the host calls this while the visitor is
// still APPROACHING a stop, well before open() would ever run, so the
// GLTF fetch+parse is already sitting in modelCache by the time they
// actually tap the AR button. Doesn't touch scene/camera/renderer at all
// (none of that exists yet, and doesn't need to) — purely warms the same
// cache loadArObjects() already reads from, so there's no duplicate
// fetch either way. One bad/unreachable url shouldn't block the others.
function preload(urls){
  (urls||[]).forEach(url=>{ if(url) loadModelTemplate(url).catch(()=>{}); });
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

// Phase 5b (AR occlusion) — does the segment from local origin (the
// visitor/camera — placeMesh() already positions everything relative to
// them) to P1 (an AR object's local position) pass through a hazard
// cylinder centered at cylCenterXZ {x,z}, radius R, vertical band
// [bottom,top] (all local coordinates, already visitor-relative)? Same
// horizontal-quadratic + vertical-band combination as
// geofence-engine.html's Geo.segCylinderCross, just run in this module's
// own local XYZ instead of lat/lon — no THREE.Raycaster needed, every
// occluder here is a known analytic cylinder, not scanned geometry.
// tEnter>0 && tExit<1 is deliberately strict on BOTH ends: tEnter<=0 means
// the segment starts inside the cylinder (visitor standing in a hazard —
// still sees their own object, fail open); tExit>=1 means the object
// itself is inside the cylinder (an object placed inside a hazard's own
// volume isn't hidden by it). Only a genuine "passes through and exits
// before reaching the object" counts as occluded.
function segCylinderOcclude(P1, cylCenterXZ, R, bottom, top){
  const dx=P1.x, dz=P1.z;                          // origin->P1 delta (translation-invariant)
  const cx=-cylCenterXZ.x, cz=-cylCenterXZ.z;       // origin, relative to cylinder center
  const a=dx*dx+dz*dz, b=2*(cx*dx+cz*dz), c=cx*cx+cz*cz-R*R;
  let hLo, hHi;
  if(a<1e-9){                          // segment doesn't move horizontally at all
    if(c>0) return false;              // sitting outside the circle the whole time
    hLo=0; hHi=1;
  } else {
    const disc=b*b-4*a*c;
    if(disc<0) return false;           // line never reaches the circle at all
    const sq=Math.sqrt(disc);
    hLo=Math.max(0,(-b-sq)/(2*a)); hHi=Math.min(1,(-b+sq)/(2*a));
    if(hLo>hHi) return false;
  }
  let vLo, vHi;
  const y0=0, y1=P1.y;
  if(Math.abs(y1-y0)<1e-6){
    if(y0<bottom || y0>top) return false;
    vLo=0; vHi=1;
  } else {
    const t1=(bottom-y0)/(y1-y0), t2=(top-y0)/(y1-y0);
    vLo=Math.max(0,Math.min(t1,t2)); vHi=Math.min(1,Math.max(t1,t2));
    if(vLo>vHi) return false;
  }
  const tEnter=Math.max(hLo,vLo), tExit=Math.min(hHi,vHi);
  return tEnter<=tExit && tEnter>0 && tExit<1;
}

// Vertical-extent cylinder (item A, 2026-08-14) — this module's first
// primitive mesh; every other object here is a loaded/cloned GLB. Open-
// ended (no top/bottom caps) so the translucent side wall reads as a
// volume boundary, not a solid drum.
function buildVextMesh(radiusM, toleranceM){
  const geo=new THREE.CylinderGeometry(radiusM, radiusM, 2*toleranceM, 32, 1, true);
  const mat=new THREE.MeshStandardMaterial({color:0xffc24d, transparent:true, opacity:0.25, side:THREE.DoubleSide});
  return new THREE.Mesh(geo, mat);
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
      // obj.occlusion (Phase 5b, AR occlusion against hazard cylinders) —
      // per-object opt-in: only objects with this set get checked against
      // the session's hazardCylinders snapshot in onFix(). Originally
      // authored for a since-skipped WebXR depth-sensing path; repurposed
      // here since the flag/data already exists on real published objects
      // (this project's own test Duck has occlusion:true) and the new
      // meaning (fade out when a real hazard cylinder blocks the line of
      // sight) is a closer match to what "occlusion" actually means than
      // leaving it dead.
      //
      // Materials cloned per instance, same reasoning as
      // asset-preview-layer.js's ensureMeshLoaded(): cloneModel() shares
      // material objects by reference across every clone of the same url,
      // and this project's own live test tour has two Duck.glb instances
      // — animating one's opacity for its fade-in would otherwise yank
      // the other's too. Only set transparent/opacity at all when this
      // object actually has a fade-in configured (fadeInS>0), so an
      // object with no fade keeps its authored material untouched.
      const fadeInS=obj.fadeInS||0;
      const materials=[];
      mesh.traverse(child=>{
        if(!child.material) return;
        const wasArray=Array.isArray(child.material);
        const src=wasArray?child.material:[child.material];
        const cloned=src.map(m=>{
          const c=m.clone();
          c._baseOpacity=(m.opacity!=null?m.opacity:1);
          if(fadeInS>0){ c.transparent=true; c.opacity=0; }
          return c;
        });
        child.material=wasArray?cloned:cloned[0];
        materials.push(...cloned);
      });
      scene.add(mesh);
      const anchor=obj.anchor||{latOffsetM:0,lonOffsetM:0,altM:0};
      if(zoneCenter && visitorLatLon) placeMesh(mesh, zoneCenter, visitorLatLon, anchor);
      // fadeDone:true when fadeInS<=0 (the default) — render()'s fade loop
      // below then does nothing for this object, no behavior change from
      // before this feature existed.
      // occlusionFactor/occlusionTarget: Phase 5b — both start at 1 (fully
      // visible, nothing occluding yet) until the first onFix() after
      // hazardCylinders is available actually evaluates this object.
      // distanceFactor/distanceTarget: same starting-at-1 reasoning, for
      // the distance-based fade (matches SpatialVoice's own audio fade) —
      // applies to every placed object, not just occlusion opt-ins.
      active.push({mesh, zoneCenter, anchor, materials, fadeInS, fadeElapsed:0, fadeDone:fadeInS<=0,
        occlusion:!!obj.occlusion, occlusionFactor:1, occlusionTarget:1,
        distanceFactor:1, distanceTarget:1});
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
      // Distance to zone center — cheap live diagnostic (2026-08-18) so a
      // future "did I walk far enough for auto-close" field report can be
      // answered with a number instead of "far enough".
      const distXY=toXY(a.zoneCenter, lastVisitorLatLon);
      const dist=Math.round(Math.hypot(distXY.x, distXY.y));
      extra=' | obj brg '+brg+'° Δ'+delta+'° dist '+dist+'m';
    }
  }
  labelEl.textContent='hdg '+displayHeading+'° ('+(AROrient.source||'none')+') '+
    'β'+Math.round(AROrient.betaS)+' γ'+Math.round(AROrient.gammaS)+extra;
}

// Phase 3 (trigger-based show/hide): set by fadeOutAndClose() below when
// the host (geofence-engine.html) detects the visitor has walked out of
// the zone this AR session was opened for. Handled INSIDE this existing
// render() loop rather than a second rAF loop, so it can't fight the
// loop already calling renderer.render() every frame.
let _closing=null;   // {elapsed, dur} | null
function render(){
  const screenOrient=(screen.orientation && screen.orientation.angle) || window.orientation || 0;
  applyDeviceQuaternion(camera.quaternion, AROrient.alphaS, AROrient.betaS, AROrient.gammaS, screenOrient);
  const dt=clock.getDelta();
  mixers.forEach(m=>m.update(dt));
  if(_closing){
    _closing.elapsed+=dt;
    const factor=Math.max(0, 1-_closing.elapsed/_closing.dur);
    // Ramp down from wherever this entry's opacity actually was, not from
    // full brightness — without capturing the fade-in/occlusion/distance
    // product here too, a duck already dimmed by distance or occlusion
    // would pop to full-bright for one frame before the close-out ramp
    // started, right at the exact moment a walking-away test is watching
    // for a fade. None of these factors update while closing (this is the
    // only writer active), so this is a clean snapshot, not a race.
    active.forEach(a=>{
      if(!a.materials) return;
      const prod=(a.fadeDone?1:Math.min(1,a.fadeElapsed/a.fadeInS))*(a.occlusionFactor??1)*(a.distanceFactor??1);
      a.materials.forEach(m=>{ m.opacity=m._baseOpacity*factor*prod; m.transparent=true; });
    });
    if(factor<=0){
      renderer.render(scene, camera);   // one last frame at full transparency before tearing down
      close();
      return;   // deliberately no requestAnimationFrame(render) here — close() already nulled everything render() would touch next
    }
  } else {
    // Opacity is one product of independent factors — fade-in ramp
    // (existing) and occlusion ramp (Phase 5b, new) — computed once per
    // frame per entry, instead of two writers that could stomp each other
    // (fade-in used to unconditionally set transparent:false once done,
    // which an occlusion event happening later would need undone). isVext
    // entries (the hazard/vertical-extent cylinder mesh) have no
    // .materials at all and are skipped, same as before this change.
    active.forEach(a=>{
      if(!a.materials || !a.materials.length) return;
      const fadeSettled=a.fadeDone;
      const occlusionSettled=!a.occlusion || a.occlusionFactor===a.occlusionTarget;
      const distanceSettled=a.distanceFactor===a.distanceTarget;
      if(fadeSettled && occlusionSettled && distanceSettled) return;   // opacity already correct, nothing to ramp
      if(!fadeSettled){
        a.fadeElapsed+=dt;
        if(a.fadeElapsed/a.fadeInS>=1) a.fadeDone=true;
      }
      if(!occlusionSettled){
        const step=dt/OCCLUSION_FADE_S;
        a.occlusionFactor = a.occlusionTarget>a.occlusionFactor
          ? Math.min(a.occlusionTarget, a.occlusionFactor+step)
          : Math.max(a.occlusionTarget, a.occlusionFactor-step);
      }
      if(!distanceSettled){
        const step=dt/DISTANCE_FADE_S;
        a.distanceFactor = a.distanceTarget>a.distanceFactor
          ? Math.min(a.distanceTarget, a.distanceFactor+step)
          : Math.max(a.distanceTarget, a.distanceFactor-step);
      }
      const fadeInFactor=a.fadeDone?1:Math.min(1, a.fadeElapsed/a.fadeInS);
      const product=fadeInFactor*a.occlusionFactor*a.distanceFactor;
      // transparent only when the product actually reduces opacity — most
      // exported GLBs are authored opaque, and leaving transparent:true
      // permanently can show sorting/z-fighting artifacts a normal opaque
      // material wouldn't have.
      a.materials.forEach(m=>{ m.opacity=m._baseOpacity*product; m.transparent=product<1; });
    });
  }
  renderer.render(scene, camera);
  updateDebugLabel();
  rafId=requestAnimationFrame(render);
}
// Real fade-out, driven by the host detecting a zone-exit while AR is
// still open (Phase 3) — ramps every currently-loaded object's opacity
// down, then closes the whole session (this view has no per-zone reload
// path — see the file header's Phase 2 scoping — so once the visitor has
// left the one zone this session opened for, there's nothing left to show
// them here). durationS falls back to a short baked-in minimum when the
// object's own fadeOutS is 0 (the default) — popping straight to a closed
// camera view with no transition at all reads as broken, not "off."
function fadeOutAndClose(durationS){
  if(rafId==null || _closing) return;   // not open, or a close is already in flight
  _closing={elapsed:0, dur:(durationS>0?durationS:0.6)};
}

/* ---- public API ---- */
let _onClosed=null;   // caller's DOM-restoration hook — see close()'s own comment
async function open({videoEl:videoElArg, canvas, label, zoneCenter, arObjects, visitorLatLon,
                      zoneRadiusM, zoneAltM, zoneAltToleranceM, hazardCylinders:hazardCylindersArg,
                      distFarM:distFarMArg, distClearM:distClearMArg, onClosed}){
  if(rafId!=null) return;   // already open
  videoEl=videoElArg; labelEl=label||null;
  _onClosed=onClosed||null;
  lastVisitorLatLon=visitorLatLon||null;
  hazardCylinders=hazardCylindersArg||[];
  distFarM=distFarMArg>0?distFarMArg:64;
  distClearM=distClearMArg!=null?distClearMArg:8;
  try{
    initScene(canvas);
    clock=new THREE.Clock();
    active=[]; mixers=[];
    await startCamera();
    AROrient.start();
    window.addEventListener('resize', onResize);
    await loadArObjects(zoneCenter, arObjects||[], visitorLatLon);
    // Vertical-extent cylinder — pushed AFTER arObjects so active[0] (what
    // updateDebugLabel() reads for bearing-to-object) still prefers a real
    // placed model when one exists, same as before this was added.
    if(zoneCenter && zoneRadiusM!=null && zoneAltM!=null){
      const tol=zoneAltToleranceM!=null?zoneAltToleranceM:25;
      const mesh=buildVextMesh(zoneRadiusM, tol);
      scene.add(mesh);
      const anchor={latOffsetM:0, lonOffsetM:0, altM:0};
      if(visitorLatLon) placeMesh(mesh, zoneCenter, visitorLatLon, anchor);
      active.push({mesh, zoneCenter, anchor, isVext:true, vextAltM:zoneAltM});
    }
    rafId=requestAnimationFrame(render);
  }catch(e){
    close();   // clean up any partial state (camera/scene/listeners) before surfacing the error
    throw e;
  }
}

// visitorAltM (optional): recomputes the vertical-extent cylinder's height
// from the visitor's LIVE altitude every fix — not just once at open() —
// because the target user here is a paraglider/drone operator whose
// altitude is constantly changing, the whole point of this feature. Falls
// back to eye-level (anchor.altM=0) when no trustworthy altitude is
// available yet — still shows the cylinder's correct SIZE (radius +
// tolerance thickness), just not true absolute height until one is.
// Ordinary placed arObjects are untouched — their anchor.altM is an
// author-configured relative nudge, not vertical-extent tracking.
function onFix(visitorLatLon, visitorAltM){
  if(rafId==null) return;
  lastVisitorLatLon=visitorLatLon;
  active.forEach(a=>{
    if(!a.zoneCenter) return;
    if(a.isVext) a.anchor.altM = (visitorAltM!=null) ? (a.vextAltM-visitorAltM) : 0;
    placeMesh(a.mesh, a.zoneCenter, visitorLatLon, a.anchor);
    // Phase 5b (AR occlusion): position-only (visitor/object location, not
    // camera orientation), so it's computed here at GPS-fix rate, not every
    // render() frame. hazardCylinders is a fixed snapshot from open() but
    // each cylinder's position RELATIVE TO THE VISITOR still needs
    // recomputing every fix, same as zoneCenter's own placeMesh() call
    // above. No visitorAltM yet -> fail open (visible), same "no data =
    // pass" convention as altOk()/5a's own missing-altitude handling.
    if(a.occlusion){
      if(hazardCylinders.length && visitorAltM!=null){
        const occluded=hazardCylinders.some(cyl=>{
          const c=toXY(cyl.center, visitorLatLon);
          return segCylinderOcclude(a.mesh.position, {x:c.x, z:-c.y}, cyl.radiusM, cyl.bottom-visitorAltM, cyl.top-visitorAltM);
        });
        a.occlusionTarget=occluded?0:1;
      } else {
        a.occlusionTarget=1;
      }
    }
    // Distance-based fade (matches SpatialVoice's own audio fade curve) —
    // every placed object, not just occlusion opt-ins. Planar distance via
    // the same toXY() this module already uses for placement, precise
    // enough at AR-relevant (tens of metres) scale.
    if(a.materials && a.materials.length){
      const base=toXY(a.zoneCenter, visitorLatLon);
      const distM=Math.hypot(base.x, base.y);
      const f=Math.max(0, Math.min(1, (distM-distClearM)/Math.max(1, distFarM-distClearM)));
      a.distanceTarget=distFadeGain(f);
    }
  });
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
  labelEl=null; lastVisitorLatLon=null; _closing=null; hazardCylinders=[];
  distFarM=64; distClearM=8;
  if(_onClosed){ const cb=_onClosed; _onClosed=null; cb(); }
}

function isOpen(){ return rafId!=null; }
async function requestOrientationPermission(){ return AROrient.requestPermission(); }

// Phone lock / app switch while AR is open must not leave the camera
// running — close() (and therefore the host's onClosed callback) fires
// here too, not just from the host's close button.
window.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden' && isOpen()) close(); });

window.ARView = { open, close, onFix, requestOrientationPermission, isOpen, fadeOutAndClose, preload };
