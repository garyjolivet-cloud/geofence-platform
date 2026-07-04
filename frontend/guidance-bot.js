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
const HAZARD_BUF_KM   = 0.005;// 5m buffer around hazard zones
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

async function computeBypassWaypoints(userLatLon, targetLatLon, allZones){
  const hazards=(allZones||[]).filter(z=>z.isHazard);
  if(!hazards.length) return [];
  const turf=await loadTurf();
  if(!turf) return [];
  const waypoints=[];
  const fromLL=userLatLon||[targetLatLon[0]-0.0001, targetLatLon[1]-0.0001];
  const fromPt=[fromLL[1],fromLL[0]]; // [lon,lat] for turf
  const toPt=[targetLatLon[1],targetLatLon[0]];

  for(const hz of hazards){
    try{
      const poly=zoneToTurfPoly(hz,turf);
      if(!poly) continue;
      const buffered=turf.buffer(poly,HAZARD_BUF_KM,{units:'kilometers'});
      const hull=turf.convex(turf.explode(buffered))||buffered;
      const line=turf.lineString([fromPt,toPt]);
      if(!turf.booleanIntersects(line,hull)) continue;

      // Classify hull vertices left/right of direct path
      const hCoords=hull.geometry.coordinates[0];
      const [fx,fy]=fromPt, [tx,ty]=toPt;
      const dx=tx-fx, dy=ty-fy;
      let bestLeft=null, bestRight=null, bestLx=0, bestRx=0;
      hCoords.forEach(([cx,cy])=>{
        const cross=dx*(cy-fy)-dy*(cx-fx);
        const mag=Math.abs(cross);
        if(cross>0&&mag>bestLx){ bestLeft=[cy,cx]; bestLx=mag; } // back to [lat,lon]
        if(cross<=0&&mag>bestRx){ bestRight=[cy,cx]; bestRx=mag; }
      });

      // Choose shorter path
      const pathLen=wp=>wp?hav(fromLL,wp)+hav(wp,targetLatLon):Infinity;
      const chosen=(pathLen(bestLeft)<pathLen(bestRight)?bestLeft:bestRight)||bestLeft||bestRight;
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
    computeBypassWaypoints([fix.lat,fix.lon],_targetZone.center,_allZones)
      .then(wps=>{ _waypointQueue=wps; }).catch(()=>{});
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
    }else if(now-_lastSpeakT>20000){
      const text=`Walk ${Math.round(distToTarget)} metres to the target`;
      _lastSpeakT=now;
      _say(text);
      if(_onInstruction) _onInstruction(text,distToTarget,'navigate');
    }
  }

  else if(_phase==='align'){
    if(!_targetZone.bearingDeg&&_targetZone.bearingDeg!==0){ _finish(); return; }
    if(hdg!=null&&fix.speed>=MIN_HDG_SPEED){
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
      _say("Keep walking to establish your direction.");
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
    // Pre-compute hazard waypoints (non-blocking, gracefully absent until ready)
    computeBypassWaypoints(null,targetZone.center,allZones)
      .then(wps=>{ if(_active) _waypointQueue=wps; }).catch(()=>{});
    _say("Guidance started — walk toward the target.");
  },
  update,
  stop(){ _active=false; _phase=null; _sayFn=null; _onComplete=null; _onInstruction=null; _lastUserPos=null; },
  get active(){ return _active; },
  get phase(){ return _phase; },
  // returns bearing (0-360) from current pos to active waypoint/target, or null
  get targetBearing(){
    if(!_active||!_targetZone) return null;
    const from=_lastUserPos;
    if(!from) return null;
    const to=_waypointQueue.length>0?[_waypointQueue[0].lat,_waypointQueue[0].lon]:_targetZone.center;
    return bearing(from,to);
  },
  get targetZone(){ return _targetZone; },
  get waypointQueue(){ return _waypointQueue; }
};

})();
