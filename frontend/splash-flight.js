/* Shared "camera keyframe flight" player — window.SplashFlight.
   Used by BOTH ridge-quest.html's real splash and fence-editor.html's
   "Splash Flyby" editor Preview button, so the two always run the exact
   same flight code: what's previewed in the editor is what actually
   ships in the splash, no verbatim-mirror drift between the two copies.

   A keyframe is {lon,lat,zoom,pitch,bearing,ms} — ms is the flight
   duration INTO this point from the previous one (ignored on point 0,
   which is just the starting camera the map opens on). */
(function(){
  function cameraFor(kf){
    return { center:[kf.lon, kf.lat], zoom:kf.zoom, pitch:kf.pitch, bearing:kf.bearing };
  }
  function totalDurationMs(keyframes){
    if(!Array.isArray(keyframes)) return 0;
    let t = 0;
    for(let i=1; i<keyframes.length; i++) t += Math.max(0, Number(keyframes[i].ms) || 0);
    return t;
  }
  // Flies `map` through every keyframe in order via jumpTo(point0) then one
  // map.easeTo() per segment (linear easing by default — matches the
  // uniform-speed feel already validated live against real terrain).
  // Returns the total flight duration in ms so the caller can schedule
  // whatever comes after (an end-card, re-enabling editor controls, etc).
  function play(map, keyframes, opts){
    opts = opts || {};
    const easing = opts.easing || (t => t);
    if(!map || !Array.isArray(keyframes) || keyframes.length < 2) return 0;
    try{ map.jumpTo(cameraFor(keyframes[0])); }catch(e){}
    let elapsed = 0;
    for(let i=1; i<keyframes.length; i++){
      const kf = keyframes[i];
      const dur = Math.max(0, Number(kf.ms) || 0);
      const cam = cameraFor(kf);
      setTimeout(()=>{
        if(opts.onSegment) try{ opts.onSegment(i, keyframes.length-1); }catch(e){}
        try{ map.easeTo(Object.assign({}, cam, { duration:dur, easing })); }catch(e){}
      }, elapsed);
      elapsed += dur;
    }
    return elapsed;
  }
  window.SplashFlight = { cameraFor, totalDurationMs, play };
})();
