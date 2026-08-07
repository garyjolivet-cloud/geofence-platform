// Per-visitor, per-project "tour state": which stops have been visited so
// far this walk, plus arbitrary named flags/counters a pipeline author can
// set and read back — the shared memory a stop's pipeline needs to know
// about *other* stops (progressive unlocking, branching narrative,
// cumulative tour-wide tallies). See frontend/pipeline-runtime.js's
// logic.stop_visited/action.set_flag/data.tour_progress etc.
//
// Deliberately localStorage-only, no D1/API round trip — this app's own
// established convention (gp.device, gp.consent, gp.bundle.<projectId>) is
// local-first/client-authoritative, and the GPS/pipeline tick loop must
// keep working with zero server dependency on a spotty trail connection.
(function () {
  "use strict";

  let _session = null; // the live in-memory record; null until init() runs
  let _key = null;      // the localStorage key the current session is stored under

  const TTL_MS = 24 * 3600 * 1000;

  function keyFor(projectId, ns) {
    return "gp.tourstate." + (ns || "") + "." + projectId;
  }

  function load(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || s.v !== 1) return null;
      return s;
    } catch (e) { return null; }
  }

  function persist() {
    if (!_session || !_key) return;
    _session.updatedAt = Date.now();
    try { localStorage.setItem(_key, JSON.stringify(_session)); } catch (e) { /* degrade to in-memory-only */ }
  }

  function fresh(projectId, totalStops, bundleVersion) {
    const now = Date.now();
    return { v: 1, projectId, bundleVersion: bundleVersion || 0, startedAt: now, updatedAt: now,
             totalStops: totalStops || 0, visited: {}, flags: {}, counters: {} };
  }

  // Idempotent — safe to call more than once (e.g. every bundle refresh).
  // Resumes a stored session if it exists, is within the 24h TTL, and its
  // bundleVersion matches what's passed in; otherwise (or if forceReset)
  // starts clean. totalStops always overwrites the stored value, so a
  // resumed session still reflects the current stop count.
  function init(projectId, totalStops, opts) {
    opts = opts || {};
    if (!projectId) { _session = null; _key = null; return; }
    _key = keyFor(projectId, opts.ns);
    const bundleVersion = opts.bundleVersion || 0;
    const stored = opts.forceReset ? null : load(_key);
    const stale = stored && (Date.now() - (stored.updatedAt || 0) > TTL_MS || stored.bundleVersion !== bundleVersion);
    _session = (stored && !stale) ? stored : fresh(projectId, totalStops, bundleVersion);
    _session.totalStops = totalStops || 0;
    persist();
  }

  function markVisited(stopId) {
    if (!_session || !stopId || _session.visited[stopId]) return;
    _session.visited[stopId] = true;
    persist();
  }
  function isVisited(stopId) {
    return !!(_session && stopId && _session.visited[stopId]);
  }

  function setFlag(name, value) {
    if (!_session || !name) return;
    _session.flags[name] = value;
    persist();
  }
  function getFlag(name) {
    return (_session && name && name in _session.flags) ? _session.flags[name] : null;
  }

  function incrementCounter(name, by) {
    if (!_session || !name) return 0;
    const delta = by == null ? 1 : by;
    _session.counters[name] = (_session.counters[name] || 0) + delta;
    persist();
    return _session.counters[name];
  }
  function getCounter(name) {
    return (_session && name && _session.counters[name]) || 0;
  }

  function stopsVisitedCount() {
    return _session ? Object.keys(_session.visited).length : 0;
  }
  function progress() {
    const visitedCount = stopsVisitedCount();
    const totalStops = _session ? (_session.totalStops || 0) : 0;
    const pctComplete = totalStops > 0 ? Math.round(visitedCount / totalStops * 1000) / 10 : null;
    return { visitedCount, totalStops, pctComplete };
  }

  // Clears whatever session is currently active (the one from the last
  // init() call) — both in memory and its localStorage row.
  function reset() {
    if (_key) { try { localStorage.removeItem(_key); } catch (e) {} }
    _session = null; _key = null;
  }

  window.TourState = {
    init, markVisited, isVisited, setFlag, getFlag,
    incrementCounter, getCounter, stopsVisitedCount, progress, reset
  };
})();
