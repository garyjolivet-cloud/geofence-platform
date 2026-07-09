/* guidance-bot.js — precision positioning guidance module
 * Guides a visitor (phone in pocket) to a GPS spot and facing direction.
 * All instructions are relative: turn left/right, bear, slow down, stop.
 * Routes around zones flagged isHazard via Turf.js tangent waypoints.
 * Exposes window.GuidanceBot.
 */
(function(){
'use strict';

// --- constants ---
const ARRIVED_M       = 8;    // switch to align phase
const WAYPOINT_M      = 12;   // waypoint considered passed
const ALIGN_OK_DEG    = 25;   // heading tolerance for alignment complete
const MIN_HDG_SPEED   = 0.5;  // m/s — minimum speed to trust GPS travel heading
const EMA_ALPHA       = 0.15; // circular EMA smoothing factor
const SPEAK_NEW_MS    = 6000; // min ms between different instructions
const SPEAK_SAME_MS   = 15000;// min ms to repeat same instruction
const HAZARD_BUF_KM   = 0.015;// 15m buffer around hazard zones
const DIR_DEAD        = 10;   // hysteresis dead-band in degrees

// --- geometry helpers (match existing Geo.bearing / haversineM pattern) ---
function hav(a, b){
  // a,b = [lat,lon]
  const R=6371e3, φ1=a[0]*Math.PI/180, φ2=b[0]*Math.PI/180;
  const dφ=(b[0]-a[0])*Math.PI/180, dλ=(b[1]-a[1])*Math.PI/180;
  const s=Math.sin(dφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return R*2*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));
}

function bearing(a, b){
  // a,b = [lat,lon]; returns 0–360 clockwise from north
  const φ1=a[0]*Math.PI/180, φ2=b[0]*Math.PI/180;
  const dλ=(b[1]-a[1])*Math.PI/180;
  const y=Math.sin(dλ)*Math.cos(φ2);
  const x=Math.cos(φ1)*Math.sin(φ2)-Math.sin(φ1)*Math.cos(φ2)*Math.cos(dλ);
  return(Math.atan2(y,x)*180/Math.PI+360)%360;
}

function circularEMA(raw, prev, alpha){
  if(prev==null) return raw;
  let diff=raw-prev;
  diff=((diff+540)%360)-180;
  return(prev+alpha*diff+360)%360;
}

// --- direction state machine ---
// Returns 'STRAIGHT'|'BEAR'|'TURN'|'AROUND' with hysteresis
function nextDirState(absDelta, prev){
  if(prev==='STRAIGHT'){
    if(absDelta > 25+DIR_DEAD) return absDelta>135+DIR_DEAD?'AROUND':absDelta>45+DIR_DEAD?'TURN':'BEAR';
    return 'STRAIGHT';
  }
  if(prev==='AROUND'){
    if(absDelta < 135-DIR_DEAD) return absDelta<25-DIR_DEAD?'STRAIGHT':absDelta<45-DIR_DEAD?'BEAR':'TURN';
    return 'AROUND';
  }
  if(prev==='BEAR'){
    if(absDelta < 25-DIR_DEAD) return 'STRAIGHT';
    if(absDelta > 45+DIR_DEAD) return absDelta>135+DIR_DEAD?'AROUND':'TURN';
    return 'BEAR';
  }
  if(prev==='TURN'){
    if(absDelta < 45-DIR_DEAD) return absDelta<25-DIR_DEAD?'STRAIGHT':'BEAR';
    if(absDelta > 135+DIR_DEAD) return 'AROUND';
    return 'TURN';
  }
  // null/unknown — cold start
  if(absDelta<25) return 'STRAIGHT';
  if(absDelta<45) return 'BEAR';
  if(absDelta<135) return 'TURN';
  return 'AROUND';
}

function buildInstruction(dirState, side, distM, phase){
  const lr=side==='R'?'right':'left';
  if(phase==='align'){
    if(dirState==='STRAIGHT') return "Good — keep walking this way";
    if(dirState==='BEAR')     return `Bear ${lr} and keep walking`;
    if(dirState==='TURN')     return `Turn ${lr} and keep walking`;
    return `Turn around and walk that way`;
  }
  // navigate phase
  const ds=distM>100?``:distM>30?`, ${Math.round(distM)} metres`:``;
  if(dirState==='STRAIGHT'){
    if(distM>100) return 'Keep going straight';
    if(distM>30)  return `Keep going${ds}`;
    if(distM>10)  return 'Getting close — slow down';
    return 'Almost there';
  }
  if(dirState==='BEAR')  return `Bear ${lr}${ds}`;
  if(dirState==='TURN')  return `Turn ${lr}`;
  return 'Turn around';
}

// --- Turf loader (lazy, cached, graceful offline degradation) ---
let _turf=null;
async function loadTurf(){
  if(_turf) return _turf;
  try{
    _turf=await import('https://esm.sh/@turf/turf@7');
    return _turf;
  }catch(e){ return null; }
}

// Build a GeoJSON polygon from a zone's target layer geometry
function zoneToTurfPoly(zone, turf){
  const tgt=(zone.layers||[]).find(l=>l.kind==='target');
  if(!tgt) return null;
  try{
    if(tgt.radiusM!=null){
      // center is [lat,lon]
      return turf.circle([zone.center[1],zone.center[0]], tgt.radiusM/1000, {units:'kilometers'});
    }
    if(tgt.geometry&&tgt.geometry.type==='polygon'){
      const coords=tgt.geometry.coords.map(c=>[c[1],c[0]]); // [lat,lon] → [lon,lat]
      coords.push(coords[0]);
      return turf.polygon([coords]);
    }
  }catch(e){}
  return null;
}

// cross2d: sign tells which side of line O→A the point B is on
function cross2d(O,A,B){ return (A[0]-O[0])*(B[1]-O[1])-(A[1]-O[1])*(B[0]-O[0]); }

// Find the two tangent vertices from external point P to a convex polygon.
// Returns [leftTangent, rightTangent] as [lon,lat], or nulls.
// Path P→tangent just grazes the hull — guaranteed not to enter the polygon.
function tangentVertices(P, hCoords){
  const n=hCoords.length-1; // last = first (closed ring)
  let left=null, right=null;
  for(let i=0;i<n;i++){
    const curr=hCoords[i];
    const prev=hCoords[(i-1+n)%n];
    const next=hCoords[(i+1)%n];
    const cp=cross2d(P,curr,prev);
    const cn=cross2d(P,curr,next);
    if(cp<=0&&cn>0) right=curr; // right tangent
    if(cp>=0&&cn<0) left=curr;  // left tangent
  }
  return [left,right];
}

async function computeBypassWaypoints(userLatLon, targetLatLon, allZones){
  if(!userLatLon) return [];
  const hazards=(allZones||[]).filter(z=>z.isHazard);
  if(!hazards.length) return [];
  const turf=await loadTurf();
  if(!turf) return [];
  const waypoints=[];
  const fromPt=[userLatLon[1],userLatLon[0]];   // [lon,lat]
  const toPt=[targetLatLon[1],targetLatLon[0]];

  for(const hz of hazards){
    try{
      const poly=zoneToTurfPoly(hz,turf);
      if(!poly) continue;
      const buffered=turf.buffer(poly,HAZARD_BUF_KM,{units:'kilometers'});
      const hull=turf.convex(turf.explode(buffered))||buffered;
      const line=turf.lineString([fromPt,toPt]);
      if(!turf.booleanIntersects(line,hull)) continue;

      const hCoords=hull.geometry.coordinates[0];

      // Get proper tangent vertices — path to these is guaranteed clear
      const [leftV,rightV]=tangentVertices(fromPt,hCoords);

      // Convert back to [lat,lon] and pick shorter total path
      const toLatlng=v=>v?[v[1],v[0]]:null;
      const leftLL=toLatlng(leftV), rightLL=toLatlng(rightV);
      const pathLen=wp=>wp?hav(userLatLon,wp)+hav(wp,targetLatLon):Infinity;
      const chosen=(pathLen(leftLL)<pathLen(rightLL)?leftLL:rightLL)||leftLL||rightLL;
      if(chosen) waypoints.push({lat:chosen[0],lon:chosen[1]});
    }catch(e){}
  }
  return waypoints;
}

// --- module state ---
let _active=false, _phase=null;
let _targetZone=null, _allZones=null;
let _sayFn=null, _onComplete=null, _onInstruction=null;
let _lastSpeakT=0, _lastInstrText=null;
let _smoothedHdg=null, _prevDirState=null;
let _waypointQueue=[];
let _lastHazardCheck=0;  // epoch ms of last computeBypassWaypoints call
let _hazardChecking=false; // prevent concurrent checks

// --- update — called every GPS fix ---
async function update(fix){
  if(!_active||!_targetZone) return;
  _lastUserPos=[fix.lat,fix.lon];
  const now=fix.t||Date.now();

  // Smooth heading from GPS travel (phone in pocket → never use device compass)
  if(fix.speed>=MIN_HDG_SPEED&&fix.headingTravel!=null){
    _smoothedHdg=circularEMA(fix.headingTravel,_smoothedHdg,EMA_ALPHA);
  }
  const hdg=_smoothedHdg;

  // Current waypoint (bypass waypoint or final target)
  const currentTarget=_waypointQueue.length>0
    ?[_waypointQueue[0].lat,_waypointQueue[0].lon]
    :_targetZone.center;
  const distToWp=hav([fix.lat,fix.lon],currentTarget);
  const distToTarget=hav([fix.lat,fix.lon],_targetZone.center);

  // Pass waypoint?
  if(_waypointQueue.length>0&&distToWp<WAYPOINT_M){
    _waypointQueue.shift();
  }
  // Re-check hazards only when queue is empty (don't overwrite in-progress bypass), throttled to 4s
  if(!_hazardChecking&&_phase==='navigate'&&_waypointQueue.length===0&&now-_lastHazardCheck>4000){
    _hazardChecking=true; _lastHazardCheck=now;
    computeBypassWaypoints([fix.lat,fix.lon],_targetZone.center,_allZones)
      .then(wps=>{ if(_active) _waypointQueue=wps; })
      .catch(()=>{})
      .finally(()=>{ _hazardChecking=false; });
  }

  if(_phase==='navigate'){
    if(distToTarget<ARRIVED_M){
      _phase=(_targetZone.bearingDeg!=null)?'align':'done';
      if(_phase==='align'){
        _say("You've arrived. Keep walking to find your direction.");
      }else{
        _say("You've arrived.");
        _finish();
      }
      return;
    }
    const brg=bearing([fix.lat,fix.lon],currentTarget);
    if(hdg!=null){
      const delta=((brg-hdg+540)%360)-180;
      const absDelta=Math.abs(delta);
      const side=delta>=0?'R':'L';
      const dir=nextDirState(absDelta,_prevDirState);
      _prevDirState=dir;
      const text=buildInstruction(dir,side,distToTarget,'navigate');
      _maybeSpeak(text,now);
      if(_onInstruction) _onInstruction(text,distToTarget,'navigate');
    }else if(now-_lastSpeakT>12000){
      const text=distToTarget>15?`Keep walking — target is ${Math.round(distToTarget)} metres ahead`:`Almost there — ${Math.round(distToTarget)} metres`;
      _lastSpeakT=now;
      _say(text);
      if(_onInstruction) _onInstruction(text,distToTarget,'navigate');
    }
  }

  else if(_phase==='align'){
    if(!_targetZone.bearingDeg&&_targetZone.bearingDeg!==0){ _finish(); return; }
    if(hdg!=null&&fix.speed>=MIN_HDG_SPEED*0.4){
      const delta=((_targetZone.bearingDeg-hdg+540)%360)-180;
      if(Math.abs(delta)<ALIGN_OK_DEG){
        _say("Perfect. Stop here — you're facing the right direction.");
        _finish();
      }else{
        const absDelta=Math.abs(delta);
        const side=delta>=0?'R':'L';
        const dir=nextDirState(absDelta,_prevDirState);
        _prevDirState=dir;
        const text=buildInstruction(dir,side,null,'align');
        _maybeSpeak(text,now);
        if(_onInstruction) _onInstruction(text,distToTarget,'align');
      }
    }else if(now-_lastSpeakT>10000){
      _say("Keep walking — I'll tell you when to turn once I have your direction.");
    }
  }
}

function _maybeSpeak(text, now){
  const same=(text===_lastInstrText);
  const interval=same?SPEAK_SAME_MS:SPEAK_NEW_MS;
  if(now-_lastSpeakT<interval) return;
  _say(text);
  _lastSpeakT=now;
  _lastInstrText=text;
}

function _say(text){ if(_sayFn) _sayFn(text); }

function _finish(){
  _active=false; _phase='done';
  if(_onComplete) _onComplete();
}

// --- public API ---
let _lastUserPos=null; // [lat,lon] updated each tick

window.GuidanceBot={
  start({targetZone, allZones, sayFn, onComplete, onInstruction}){
    _active=true; _phase='navigate';
    _targetZone=targetZone; _allZones=allZones||[];
    _sayFn=sayFn||null; _onComplete=onComplete||null; _onInstruction=onInstruction||null;
    _lastSpeakT=0; _lastInstrText=null;
    _smoothedHdg=null; _prevDirState=null; _waypointQueue=[];
    _lastHazardCheck=0; _hazardChecking=false;
    _say("Guidance active — keep your phone in your pocket and start walking. I'll tell you when to turn.");
  },
  update,
  stop(){ _active=false; _phase=null; _sayFn=null; _onComplete=null; _onInstruction=null; _lastUserPos=null; _hazardChecking=false; },
  get active(){ return _active; },
  get phase(){ return _phase; },
  // returns bearing (0-360) to display as the guidance arrow
  // navigate phase: bearing toward current waypoint/target
  // align phase: the bearingDeg the visitor should face
  get targetBearing(){
    if(!_active||!_targetZone) return null;
    if(_phase==='align') return _targetZone.bearingDeg!=null?_targetZone.bearingDeg:null;
    const from=_lastUserPos;
    if(!from) return null;
    const to=_waypointQueue.length>0?[_waypointQueue[0].lat,_waypointQueue[0].lon]:_targetZone.center;
    return bearing(from,to);
  },
  get targetZone(){ return _targetZone; },
  get waypointQueue(){ return _waypointQueue; }
};

})();
