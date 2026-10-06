/* rq-hero.js — window.RQHero (2026-10-06): the 3D "today" picture at the top of Ridge Quest's Home.

   Gary: "show a 3D map with chutes today and boot packs highlighted ... it will be updated only when
   you get on gondola at bottom of hill" — and, the same day, "it needed to look exactly like the my
   map". The picture is drawn by the host with My map's own pieces (ridge-quest.html
   renderMyMapPicture: winter satellite, 3D terrain, every run in its difficulty colour + glow,
   today's track, skied-chute stripe and boot packs in green) — one off-screen render, kept as a
   JPEG in localStorage so Home shows it at once and never runs a live map (battery). The numbers
   over it are live HTML, not part of the image. This module is the cache + the when; the host
   passes the renderer.

   When it is redrawn:
     - reason "gondola": the host (ridge-quest.html Quest._onFix) calls refresh() when the rider gets
       on the main lift at its bottom station (see isMainLiftBoarding);
     - reason "first": Home opens and there is no picture for today yet;
     - a refresh asked for while the page is hidden (phone locked) is remembered (stale) and done the
       next time Home opens.
   Plain script; the pure parts (dayOf, isFreshFor, isMainLiftBoarding) are unit-tested.
*/
(function (root) {
  "use strict";

  var W = 780, H = 488;                    // 16:10, 2x a 390 px phone screen
  var MIN_GAP_MS = 10 * 60000;             // at most one gondola-triggered render per 10 min
  var BOARD_RADIUS_M = 250;                // "at the bottom of the hill": this close to the main lift's bottom end

  // v2 (2026-10-06): the picture is now My map's own look (ridge-quest.html renderMyMapPicture). The
  // key changed so a day's cached drawn-mountain fallback from the first version is ignored.
  function key(pid) { return "rq.hero.v2." + (pid || ""); }
  function load(pid) {
    try { var v = JSON.parse(root.localStorage.getItem(key(pid)) || "null"); return v && v.img ? v : null; } catch (e) { return null; }
  }
  function save(pid, v) { try { root.localStorage.setItem(key(pid), JSON.stringify(v)); } catch (e) {} }

  // A cached picture is good for Home when it was made on `day` (YYYY-MM-DD) and isn't marked stale.
  function isFreshFor(cached, day) { return !!(cached && cached.img && cached.day === day && !cached.stale); }

  function hav(a, b) {                     // [lat, lon]
    var R = 6371000, r = Math.PI / 180, dp = (b[0] - a[0]) * r, dl = (b[1] - a[1]) * r;
    var x = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  // The main lift = the lift that climbs the most (Kicking Horse: Golden Eagle Express Gondola). Its
  // bottom end: the lower end by elevation (lifts are drawn either way), else the drawn start.
  function mainLift(corridors) {
    var lifts = (corridors || []).filter(function (c) { return c && c.runType === "lift" && c.path && c.path.length >= 2; });
    if (!lifts.length) return null;
    var gain = function (c) { return Math.max(c.climbM || 0, c.descentM || 0); };
    lifts.sort(function (a, b) { return gain(b) - gain(a); });
    var c = lifts[0];
    var upAlong = c.climbM != null && c.descentM != null ? c.climbM > c.descentM : true;
    return { lift: c, bottom: upAlong ? c.path[0] : c.path[c.path.length - 1] };
  }
  // True when a rider at `pos` [lat, lon] who has just come onto a lift line is boarding the main
  // lift at its bottom station (and not, say, the top station or another chair).
  function isMainLiftBoarding(pos, corridors) {
    var m = mainLift(corridors);
    return !!(m && pos && hav(pos, m.bottom) <= BOARD_RADIUS_M);
  }

  var busy = false;
  var state = { pid: null, lastAt: 0, onUpdated: null };

  // Render now (or remember to). render() -> Promise<canvas | null> (the host's My-map picture). A null
  // (no WebGL, no runs loaded, a blank frame) is never saved: the old picture stays and the next
  // Home open tries again.
  async function refresh(pid, reason, render, day) {
    state.pid = pid;
    var now = Date.now();
    if (reason === "gondola" && now - state.lastAt < MIN_GAP_MS) return "skipped";
    state.lastAt = now;
    if (root.document && root.document.hidden) {           // locked phone: do it when Home is next opened
      var c = load(pid); if (c) { c.stale = true; save(pid, c); } else save(pid, { stale: true, day: day });
      return "stale";
    }
    if (busy) return "busy";
    busy = true;
    try {
      var canvas = await render();
      if (!canvas) { state.lastAt = 0; return "failed"; }   // keep the old picture; try again next time
      var v = { img: canvas.toDataURL("image/jpeg", 0.82), at: now, day: day, reason: reason };
      save(pid, v);
      if (state.onUpdated) state.onUpdated(v);
      return "done";
    } catch (e) {
      return "failed";
    } finally { busy = false; }
  }

  var api = { W: W, H: H, MIN_GAP_MS: MIN_GAP_MS, BOARD_RADIUS_M: BOARD_RADIUS_M,
    load: load, isFreshFor: isFreshFor, mainLift: mainLift, isMainLiftBoarding: isMainLiftBoarding,
    refresh: refresh, state: state };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RQHero = api;
})(typeof window !== "undefined" ? window : globalThis);
