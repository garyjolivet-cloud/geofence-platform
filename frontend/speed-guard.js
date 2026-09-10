/* ===================== "EYES UP" SPEED GUARD (window.SpeedGuard) =====================

   Shared safety lockout for every phone-in-hand-while-moving surface
   (ridge-quest.html, geofence-engine.html, field-recorder.html). When GPS
   speed shows the user is moving — skiing / biking / walking — it blanks the
   screen with a full-viewport warning and restores it once they've been
   stopped for a few seconds, enforcing the liability-waiver line "Never
   operate this app while in motion".

   Purely visual. consider(p) is called on EVERY fix; it never throws and
   never changes host state, so tracking / recording / audio / geofence
   triggers all keep running underneath the blank.

   Hysteresis (deterministic, timed by fix `p.t` so it survives tab
   throttling): blocks instantly on one fix over `blockMps`; clears only
   after speed stays under `clearMps` continuously for `clearDwellMs`. A gap
   between fixes longer than `maxFixGapMs` (backgrounded tab, GPS loss)
   resets the clear-dwell so one stale post-resume fix can't satisfy it. No
   fixes at all => stays blocked (fail-safe).

   Host wiring:
     <script src="/speed-guard.js"></script>   (after /kalman-filter.js)
     SpeedGuard.configure({ ...overrides })            // optional
     SpeedGuard.setExemptFn(fn)                         // optional: fn(p)->bool suppresses the blank
     SpeedGuard.noteStarted()                           // when tracking/recording begins (one-time notice)
     SpeedGuard.consider(p)                             // every fix — p = {speed?, t, lat?, lon?}
     SpeedGuard.reset()                                 // on teardown / stop
   `p.speed` (m/s, e.g. GPSFilter.push().speed) is used when present; else it
   is derived by haversine from the previous fix's lat/lon/t.

   ?guard=0 disables it anywhere (escape hatch). A host in a sim/test mode
   sets configure({suppressed:true}); ?guard=1 forces it back on there.
*/
(function (global) {
  "use strict";

  var CFG = {
    enabled: true,
    blockMps: 0.7,          // ~2.5 km/h — one fix over this blanks immediately
    clearMps: 0.5,          // ~1.8 km/h — speed must sit under this…
    clearDwellMs: 4000,     // …continuously this long (by fix p.t) to restore
    maxFixGapMs: 15000,     // a longer gap between fixes resets the clear-dwell
    suppressed: false,      // host sets true in its own sim/test mode
    headline: "Eyes up",
    body: "Don’t look at your screen while moving. Stop to check the map.",
    consent: "Looking at a screen reduces your awareness of terrain, obstacles, "
      + "and other people. Only check the app while safely stopped, off to the side of a trail.",
    noticeText: "This app hides the screen while you're moving — check it while stopped.",
    onNotice: null          // optional fn(text) — host toast; else the module renders its own
  };

  var _exemptFn = null;      // optional fn(p) -> bool

  var _blocked = false;
  var _clearSince = null;    // p.t of the first fix in the current continuous below-clear streak
  var _lastSpeed = 0;
  var _lastT = null;
  var _lastLL = null;        // {lat, lon, t} of the previous positioned fix (for the speed fallback)
  var _noticeShown = false;

  function q(name) {
    try { return new URLSearchParams(global.location.search).get(name); }
    catch (e) { return null; }
  }
  function enabled() {
    if (!CFG.enabled) return false;
    if (q("guard") === "0") return false;
    if (CFG.suppressed && q("guard") !== "1") return false;
    return true;
  }

  function configure(opts) {
    if (!opts) return;
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) CFG[k] = opts[k];
  }
  function setExemptFn(fn) { _exemptFn = (typeof fn === "function") ? fn : null; }

  function haversineM(la1, lo1, la2, lo2) {
    var R = 6371000, d2r = Math.PI / 180;
    var p1 = la1 * d2r, p2 = la2 * d2r;
    var dp = (la2 - la1) * d2r, dl = (lo2 - lo1) * d2r;
    var x = Math.sin(dp / 2) * Math.sin(dp / 2)
      + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  // Prefer p.speed (the EKF's smoothed m/s); else derive from the last fix.
  function speedOf(p) {
    if (typeof p.speed === "number" && isFinite(p.speed)) return p.speed;
    if (_lastLL && typeof p.lat === "number" && typeof p.lon === "number"
      && typeof p.t === "number" && p.t > _lastLL.t) {
      var dt = (p.t - _lastLL.t) / 1000;
      if (dt > 0) return haversineM(_lastLL.lat, _lastLL.lon, p.lat, p.lon) / dt;
    }
    return null;
  }

  function consider(p) {
    if (!enabled()) return;
    if (!p || typeof p.t !== "number") return;
    var sp = speedOf(p);
    if (typeof p.lat === "number" && typeof p.lon === "number") _lastLL = { lat: p.lat, lon: p.lon, t: p.t };
    if (sp == null || !isFinite(sp)) { _lastT = p.t; return; } // can't judge speed — hold current state

    // A long gap between fixes isn't "held still" — don't let one post-resume slow fix satisfy the dwell.
    if (_lastT != null && p.t - _lastT > CFG.maxFixGapMs) _clearSince = null;
    _lastT = p.t; _lastSpeed = sp;

    var exempt = _exemptFn ? !!_exemptFn(p) : false;

    if (!_blocked) {
      if (sp > CFG.blockMps && !exempt) _block();
      return;
    }
    if (sp >= CFG.clearMps && !exempt) { _clearSince = null; _render(); return; } // still moving — reset the dwell
    if (_clearSince == null) _clearSince = p.t;
    else if (p.t - _clearSince >= CFG.clearDwellMs) { _unblock(); return; }
    _render();
  }

  function _block() {
    _blocked = true; _clearSince = null;
    if (global.navigator && typeof global.navigator.vibrate === "function") global.navigator.vibrate(150);
    _maybeNotice();
    _show(); _render();
  }
  function _unblock() { _blocked = false; _clearSince = null; _hide(); }
  function reset() { _blocked = false; _clearSince = null; _lastT = null; _lastLL = null; _hide(); }
  function noteStarted() { _maybeNotice(); }
  function _maybeNotice() {
    if (_noticeShown) return;
    _noticeShown = true;
    if (typeof CFG.onNotice === "function") { try { CFG.onNotice(CFG.noticeText); } catch (e) {} }
    else _showNotice(CFG.noticeText);
  }

  /* ---- self-contained overlay: one injected <style> + one <div> ---- */

  var STYLE_ID = "sgOverlayCss";
  function _ensureStyle() {
    if (!global.document || global.document.getElementById(STYLE_ID)) return;
    var st = global.document.createElement("style");
    st.id = STYLE_ID;
    // Theme tokens are picked up where the host defines them; the fallbacks
    // (Ridge Quest's palette) keep it looking right on pages that don't.
    st.textContent =
      '#sgOverlay{position:fixed;inset:0;z-index:2147480000;'
      + 'background:var(--night,#0a1018);display:none;flex-direction:column;align-items:center;'
      + 'justify-content:center;text-align:center;padding:32px;pointer-events:auto;'
      + '-webkit-tap-highlight-color:transparent;overscroll-behavior:contain;touch-action:none}'
      + '#sgOverlay.show{display:flex}'
      + '#sgOverlay .sgInner{max-width:34ch}'
      + '#sgOverlay .sgHead{font-family:"Barlow Condensed",system-ui,sans-serif;font-weight:700;'
      + 'text-transform:uppercase;letter-spacing:.06em;line-height:.95;margin:0 0 18px;'
      + 'font-size:clamp(46px,15vw,96px);color:var(--coral,#ff6a3d)}'
      + '#sgOverlay .sgBody{font-family:"Barlow Condensed",system-ui,sans-serif;'
      + 'font-size:clamp(18px,5vw,26px);color:var(--snow,#eef4fb);margin:0 0 20px}'
      + '#sgOverlay .sgConsent{font-size:13px;line-height:1.5;color:var(--ice,#8fb6d4);margin:0 0 22px}'
      + '#sgOverlay .sgResume{font-family:"Barlow Condensed",system-ui,sans-serif;text-transform:uppercase;'
      + 'letter-spacing:.4px;font-size:13px;color:var(--fog,#5b7088);margin:0}'
      + '#sgOverlay .sgSpeed{font-family:"Barlow Condensed",system-ui,sans-serif;font-size:12px;'
      + 'color:var(--fog,#5b7088);opacity:.7;margin:8px 0 0;min-height:1em}'
      + '#sgNotice{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);'
      + 'background:var(--slate,#141d2b);border:1px solid var(--rim,#26344a);color:var(--snow,#eef4fb);'
      + 'border-radius:10px;padding:10px 16px;font-family:"Barlow Condensed",system-ui,sans-serif;'
      + 'font-size:13px;letter-spacing:.3px;opacity:0;pointer-events:none;'
      + 'transition:opacity .2s,transform .2s;z-index:2147480001;max-width:80vw;text-align:center}'
      + '#sgNotice.show{opacity:1;transform:translateX(-50%) translateY(0)}';
    (global.document.head || global.document.documentElement).appendChild(st);
  }
  function _el() {
    if (!global.document) return null;
    var d = global.document.getElementById("sgOverlay");
    if (!d) {
      _ensureStyle();
      d = global.document.createElement("div");
      d.id = "sgOverlay";
      d.setAttribute("role", "alert");
      d.setAttribute("aria-live", "assertive");
      d.innerHTML =
        '<div class="sgInner">'
        + '<div class="sgHead"></div>'
        + '<p class="sgBody"></p>'
        + '<p class="sgConsent"></p>'
        + '<p class="sgResume" id="sgResume"></p>'
        + '<p class="sgSpeed" id="sgSpeed"></p>'
        + '</div>';
      global.document.body.appendChild(d);
      // Fill copy from CFG (allows per-host wording).
      d.querySelector(".sgHead").textContent = CFG.headline;
      d.querySelector(".sgBody").textContent = CFG.body;
      d.querySelector(".sgConsent").textContent = CFG.consent;
    }
    return d;
  }
  function _show() { var d = _el(); if (d) d.classList.add("show"); }
  function _hide() {
    if (!global.document) return;
    var d = global.document.getElementById("sgOverlay");
    if (d) d.classList.remove("show");
  }
  function _render() {
    if (!global.document) return;
    var r = global.document.getElementById("sgResume");
    var s = global.document.getElementById("sgSpeed");
    if (r) r.textContent = _clearSince != null ? "Stopped — hold still…" : "Screen returns a few seconds after you stop.";
    if (s) s.textContent = (_blocked && _clearSince == null) ? (Math.round(_lastSpeed * 3.6) + " km/h") : "";
  }
  function _showNotice(text) {
    if (!global.document) return;
    _ensureStyle();
    var t = global.document.getElementById("sgNotice");
    if (!t) { t = global.document.createElement("div"); t.id = "sgNotice"; global.document.body.appendChild(t); }
    t.textContent = text;
    t.classList.add("show");
    if (typeof global.setTimeout === "function") {
      if (_showNotice._t) global.clearTimeout(_showNotice._t);
      _showNotice._t = global.setTimeout(function () { t.classList.remove("show"); }, 4200);
      if (_showNotice._t && typeof _showNotice._t.unref === "function") _showNotice._t.unref(); // don't hold a Node test process open
    }
  }

  global.SpeedGuard = {
    configure: configure,
    setExemptFn: setExemptFn,
    consider: consider,
    reset: reset,
    noteStarted: noteStarted,
    blocked: function () { return _blocked; },
    _internal: { speedOf: speedOf, haversineM: haversineM, CFG: CFG }
  };
})(typeof window !== "undefined" ? window : globalThis);
