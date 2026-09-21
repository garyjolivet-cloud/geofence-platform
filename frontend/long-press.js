/* long-press.js — a shared "press and hold a map feature to arm/disarm it"
   gesture, distinct from a normal quick tap (which keeps doing whatever a
   page's existing click handler already does — e.g. showing a corridor's
   name/difficulty/length popup). Built for Corridor Guard's per-chute
   press-to-arm control (ridge-quest.html "My map" + fence-editor.html Test
   Mode), but has no Corridor Guard/map-feature-specific logic of its own.

   window.LongPress.bind(map, layerId, opts) -> { unbind() }

   opts.holdMs          press duration to count as a hold (default 600)
   opts.moveTolerancePx pointer drift beyond this cancels the hold — it was
                        a drag/pan, not a press-and-hold (default 20 — raised
                        2026-09-20 from an original 8px: real touch input
                        (a finger, more so through a ski glove) drifts more
                        than a mouse pointer just from natural pressure/
                        contact-area changes while holding still, and 8px
                        was tight enough to spuriously cancel a genuine hold
                        attempt as "dragging" well before holdMs elapsed —
                        field report: a press "taking over 10 seconds"
                        turned out to be several silently-cancelled attempts
                        in a row, not one slow one)
   opts.onLongPress(feature, lngLat)  fires once, the instant the hold
                        completes while still pressed. `feature` is the
                        MapLibre feature under the pointer at press-start.
   opts.onTap(feature, lngLat)        fires on a normal quick release —
                        released before holdMs, without drifting past
                        moveTolerancePx. Never fires after onLongPress or a
                        cancelled (dragged) press.

   Works for touch (gloved ski-resort use) and mouse (Fence Editor Test
   Mode) alike via MapLibre's own layer-scoped mousedown/touchstart plus a
   page-wide mousemove/mouseup/touchmove/touchend/touchcancel pair bound
   ONLY while a press is active (removed immediately once it resolves, so
   nothing lingers between gestures).

   dragPan is temporarily disabled the instant a press starts on the layer
   (so a hold-in-progress doesn't also pan the map out from under the
   pointer), and restored the moment the press either resolves (hold fires,
   or the pointer lifts) OR drifts past moveTolerancePx (at which point it's
   a real pan, not a hold attempt, so control is handed straight back to
   MapLibre for the rest of that same gesture). Every one of those exits —
   hold/tap/drag/touchcancel/unbind() — routes through one restore path so
   dragPan can never be left stuck off. This project has hit exactly that
   "dragPan permanently disabled" bug once already (corridor-drag,
   2026-08-20/21) from a cleanup path that didn't cover every exit; this
   module keeps them all going through the same function specifically to
   avoid repeating it.

   No DOM/audio side effects of its own, no knowledge of Corridor Guard or
   any other feature — same "self-contained, callback injection" shape as
   kalman-filter.js/guidance-bot.js/chute-guard.js/here-marker.js.
*/
(function(){
  "use strict";

  function dist(a, b){ return Math.hypot(a.x-b.x, a.y-b.y); }

  function bind(map, layerId, opts){
    opts = opts || {};
    const holdMs = opts.holdMs!=null ? opts.holdMs : 600;
    const tolPx  = opts.moveTolerancePx!=null ? opts.moveTolerancePx : 20;

    let timer=null, startPt=null, feature=null, lngLat=null;
    let pressing=false, dragging=false, holdFired=false, dragPanWasEnabled=false;

    function restoreDragPan(){
      if(dragPanWasEnabled && map.dragPan && !map.dragPan.isEnabled()) map.dragPan.enable();
      dragPanWasEnabled=false;
    }

    function endPress(){
      if(timer!=null){ clearTimeout(timer); timer=null; }
      map.off("mousemove", onMove);
      map.off("touchmove", onMove);
      map.off("mouseup", onUp);
      map.off("touchend", onUp);
      map.off("touchcancel", onCancel);
      restoreDragPan();
      pressing=false; dragging=false; holdFired=false; startPt=null; feature=null; lngLat=null;
    }

    function onMove(e){
      if(!pressing || dragging || holdFired) return;
      if(dist(e.point, startPt) > tolPx){
        dragging = true;
        if(timer!=null){ clearTimeout(timer); timer=null; }
        restoreDragPan(); // hand the rest of this gesture back to MapLibre's own pan
      }
    }

    function onUp(){
      if(!pressing) return;
      const shouldTap = !dragging && !holdFired;
      const f=feature, ll=lngLat;
      endPress();
      if(shouldTap && opts.onTap) opts.onTap(f, ll);
    }

    function onCancel(){ endPress(); }

    function onDown(e){
      if(pressing) return; // a second finger/button mid-press — ignore, let the first press resolve
      pressing=true; dragging=false; holdFired=false;
      startPt=e.point; lngLat=e.lngLat;
      feature=(e.features && e.features[0]) || null;
      if(map.dragPan && map.dragPan.isEnabled()){ dragPanWasEnabled=true; map.dragPan.disable(); }
      map.on("mousemove", onMove);
      map.on("touchmove", onMove);
      map.on("mouseup", onUp);
      map.on("touchend", onUp);
      map.on("touchcancel", onCancel);
      timer = setTimeout(()=>{
        timer=null;
        if(!pressing || dragging) return;
        holdFired = true;
        restoreDragPan();
        if(opts.onLongPress) opts.onLongPress(feature, lngLat);
      }, holdMs);
    }

    map.on("mousedown", layerId, onDown);
    map.on("touchstart", layerId, onDown);

    return {
      unbind(){
        endPress();
        map.off("mousedown", layerId, onDown);
        map.off("touchstart", layerId, onDown);
      }
    };
  }

  window.LongPress = { bind };
})();
