/* device-heading.js — window.DeviceHeading

   A small compass-heading source for the live map's "you are here" arrow:
   which way the phone is physically POINTING, in true-north degrees [0,360),
   from DeviceOrientationEvent.

   This is deliberately NOT the old precision device-compass subsystem (that
   was removed because a magnetometer is too noisy for turn-by-turn
   guidance). It only drives the map-dot orientation wedge, and every caller
   falls back to GPS travel heading when this returns null (unsupported,
   permission denied, or no reading yet).

     DeviceHeading.start()    -> begin listening. On iOS 13+ this MUST be
                                 called from inside a user gesture (it calls
                                 DeviceOrientationEvent.requestPermission()).
                                 Idempotent + safe to call again — pages call
                                 it once at load AND from their existing
                                 "tap to enable" handler so iOS gets a
                                 gesture-backed retry. Returns a Promise<bool>.
     DeviceHeading.heading    -> smoothed heading in degrees [0,360), or null
     DeviceHeading.supported  -> boolean (DeviceOrientationEvent exists)
     DeviceHeading.active     -> boolean (at least one reading in)
     DeviceHeading.onChange(fn) -> fn(headingDeg) on every smoothed update
*/
(function () {
  "use strict";

  var supported = typeof window !== "undefined" && "DeviceOrientationEvent" in window;
  var listening = false;
  var raw = null, smooth = null;
  var subs = [];
  var EMA = 0.25;
  var API = { start: start, onChange: onChange, heading: null, supported: supported, active: false };

  function onChange(fn) { if (typeof fn === "function") subs.push(fn); }

  // Circular EMA — blends toward `next` along the shortest arc so a reading
  // near the 0/360 wrap doesn't yank the average the long way round.
  function circEma(next, prev, a) {
    if (prev == null) return next;
    var d = ((next - prev + 540) % 360) - 180;
    return (prev + a * d + 360) % 360;
  }

  function emit() {
    for (var i = 0; i < subs.length; i++) { try { subs[i](smooth); } catch (e) {} }
  }

  function screenAngle() {
    try {
      if (screen.orientation && typeof screen.orientation.angle === "number") return screen.orientation.angle;
    } catch (e) {}
    return (typeof window.orientation === "number") ? window.orientation : 0;
  }

  function onEvent(e) {
    var h = null;
    if (typeof e.webkitCompassHeading === "number" && !isNaN(e.webkitCompassHeading)) {
      // iOS Safari — already clockwise from true north.
      h = e.webkitCompassHeading;
    } else if (e.absolute === true && typeof e.alpha === "number" && !isNaN(e.alpha)) {
      // W3C spec: alpha is counter-clockwise from north; add the screen
      // rotation so a phone held in landscape still reads true.
      h = (360 - e.alpha + screenAngle()) % 360;
    }
    if (h == null || !isFinite(h)) return;
    raw = (h % 360 + 360) % 360;
    smooth = circEma(raw, smooth, EMA);
    API.heading = smooth;
    API.active = true;
    emit();
  }

  function attach() {
    if (listening) return;
    listening = true;
    // deviceorientationabsolute fires the earth-referenced frame on the
    // platforms that have it (Chrome/Android); plain deviceorientation is
    // the fallback and the only one iOS fires (with webkitCompassHeading).
    window.addEventListener("deviceorientationabsolute", onEvent, true);
    window.addEventListener("deviceorientation", onEvent, true);
  }

  function start() {
    if (!supported) return Promise.resolve(false);
    var DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === "function") {
      // iOS 13+: needs a user gesture. Called outside one, requestPermission()
      // rejects — swallow it, a later gesture-backed call retries.
      return DOE.requestPermission().then(function (state) {
        if (state === "granted") { attach(); return true; }
        return false;
      }).catch(function () { return false; });
    }
    attach();
    return Promise.resolve(true);
  }

  window.DeviceHeading = API;
})();
