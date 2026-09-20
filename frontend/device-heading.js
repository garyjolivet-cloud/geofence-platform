/* device-heading.js — window.DeviceHeading

   A small compass-heading + tilt source for the live map's "you are here"
   arrow and Ridge Quest's map auto-orientation: which way the phone is
   physically POINTING (true-north degrees) and how far it's tilted up from
   flat, both from DeviceOrientationEvent.

   This is deliberately NOT the old precision device-compass subsystem (that
   was removed because a magnetometer is too noisy for turn-by-turn
   guidance). It only drives the map-dot orientation wedge (+ Ridge Quest's
   map bearing/pitch auto-follow), and every heading caller falls back to
   GPS travel heading when this returns null (unsupported, permission
   denied, or no reading yet).

   Tilt tracking (`API.tilt`/the onChange 2nd arg) is portrait-only: `beta`
   swaps meaning with `gamma` once the device rotates to landscape, and
   unlike heading there's no screenAngle()-style correction applied here —
   a known limitation, not solved, since nothing in this codebase uses tilt
   in landscape today.

     DeviceHeading.start()    -> begin listening. On iOS 13+ this MUST be
                                 called from inside a user gesture (it calls
                                 DeviceOrientationEvent.requestPermission()).
                                 Idempotent + safe to call again — pages call
                                 it once at load AND from their existing
                                 "tap to enable" handler so iOS gets a
                                 gesture-backed retry. Returns a Promise<bool>.
     DeviceHeading.heading    -> smoothed heading in degrees [0,360), or null
     DeviceHeading.tilt       -> smoothed front-back tilt in degrees [0,90]
                                 (0 = flat, 90 = upright), or null
     DeviceHeading.supported  -> boolean (DeviceOrientationEvent exists)
     DeviceHeading.active     -> boolean (at least one reading in)
     DeviceHeading.onChange(fn) -> fn(headingDeg, tiltDeg) on every smoothed
                                 update — tiltDeg is an additive 2nd arg,
                                 safe for callers that only read the 1st.
*/
(function () {
  "use strict";

  var supported = typeof window !== "undefined" && "DeviceOrientationEvent" in window;
  var listening = false;
  var raw = null, smooth = null;
  var rawTilt = null, smoothTilt = null;
  var subs = [];
  var API = { start: start, onChange: onChange, heading: null, tilt: null, supported: supported, active: false };

  // Returns an unsubscribe fn (Ridge Quest tears its map down and rebuilds it).
  function onChange(fn) {
    if (typeof fn !== "function") return function () {};
    subs.push(fn);
    return function () { var i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); };
  }

  // Adaptive circular smoothing — snap on a deliberate turn (big delta),
  // smooth out magnetometer jitter when roughly steady. Keeps the arrow
  // feeling immediate (à la Trailforks) without the raw needle wobble.
  function circSmooth(next, prev) {
    if (prev == null) return next;
    var d = ((next - prev + 540) % 360) - 180;
    var a = Math.abs(d) > 22 ? 0.65 : 0.28;
    return (prev + a * d + 360) % 360;
  }

  function emit() {
    for (var i = 0; i < subs.length; i++) { try { subs[i](smooth, smoothTilt); } catch (e) {} }
  }

  function screenAngle() {
    try {
      if (screen.orientation && typeof screen.orientation.angle === "number") return screen.orientation.angle;
    } catch (e) {}
    return (typeof window.orientation === "number") ? window.orientation : 0;
  }

  function onEvent(e) {
    var changed = false;
    var h = null;
    if (typeof e.webkitCompassHeading === "number" && !isNaN(e.webkitCompassHeading)) {
      // iOS Safari — already clockwise from true north.
      h = e.webkitCompassHeading;
    } else if (e.absolute === true && typeof e.alpha === "number" && !isNaN(e.alpha)) {
      // W3C spec: alpha is counter-clockwise from north; add the screen
      // rotation so a phone held in landscape still reads true.
      h = (360 - e.alpha + screenAngle()) % 360;
    }
    if (h != null && isFinite(h)) {
      raw = (h % 360 + 360) % 360;
      smooth = circSmooth(raw, smooth);
      API.heading = smooth;
      changed = true;
    }
    // Front-back tilt (0 = flat, 90 = upright either direction) — available
    // on the same event regardless of whether heading resolved above, so
    // this must NOT be gated behind the `h` check: plenty of real devices
    // (no magnetometer / no absolute-orientation support) never resolve a
    // heading at all, which used to skip this block entirely and leave
    // tilt stuck at its initial null (map pitch permanently flat). abs()
    // because a natural "hold the phone up to look at it" grip can read
    // beta on either side of 0 depending on exact hand angle — clamping
    // negative readings to 0 silently zeroed tilt out for some grips.
    // Plain EMA is enough (no wraparound like heading needs).
    if (typeof e.beta === "number" && !isNaN(e.beta)) {
      rawTilt = Math.max(0, Math.min(90, Math.abs(e.beta)));
      smoothTilt = smoothTilt == null ? rawTilt : smoothTilt + 0.25 * (rawTilt - smoothTilt);
      API.tilt = smoothTilt;
      changed = true;
    }
    if (!changed) return;
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

  // Stops listening (battery — 2026-09-17): the magnetometer/orientation
  // sensor otherwise keeps being read and smoothed for the rest of the
  // session once started, even on a screen with nothing subscribed to
  // onChange to actually show it (e.g. Ridge Quest's Home screen once "My
  // map" — the only consumer of this data — has been closed again). start()
  // is safe to call again later (re-attaches); permission, once granted,
  // doesn't need to be re-requested.
  function stop() {
    if (!listening) return;
    listening = false;
    window.removeEventListener("deviceorientationabsolute", onEvent, true);
    window.removeEventListener("deviceorientation", onEvent, true);
    API.active = false;
  }

  API.stop = stop;
  window.DeviceHeading = API;
})();
