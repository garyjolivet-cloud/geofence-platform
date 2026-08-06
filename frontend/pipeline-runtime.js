/* PipelineRuntime — local DAG execution for zone.pipeline
 * Shared by pipeline-editor.html (registry + validation only), geofence-engine.html,
 * and fence-editor.html's embedded simulator (registry + full tick() execution).
 * Lifecycle modeled on guidance-bot.js: load()/tick()/unload(), side effects only
 * via injected callbacks, degrades gracefully rather than throwing.
 */
(function(global){
"use strict";

// Must match migrations/0026_hazard_code_object.sql's seeded id — duplicated
// here rather than imported since this file loads standalone in the browser,
// same as fence-editor.html's and guidance-bot.js's own copies of this
// constant (this codebase's existing verbatim-mirror convention).
const HAZARD_CODE_OBJECT_ID="hazard-zone";

/* ===================== BLOCK REGISTRY ===================== */
// Each block declares its ports (gate = pulse-only boolean, anything else = a named
// data value) and, for data/logic/action blocks, an eval(ctx) used by the runtime.
// `params` describes editable fields for the property panel (id, type, default, label).
// Output ports also carry a human `label` (e.g. "% Complete" for pctComplete) —
// purely cosmetic for pipeline-editor.html's "insert value" picker and the
// chip tokens it builds in interpolatable text fields; the runtime itself
// only ever reads `id`/`type`, so this is safe to extend without touching
// eval logic below.
const BLOCKS = {
  "trigger.zone_enter": {
    label: "On Zone Enter", category: "trigger",
    inputs: [], outputs: [{ id: "out", type: "gate", label: "Triggered" }],
    params: []
  },
  "trigger.zone_exit": {
    label: "On Zone Exit", category: "trigger",
    inputs: [], outputs: [{ id: "out", type: "gate", label: "Triggered" }],
    params: []
  },
  "trigger.dwell": {
    label: "On Dwell", category: "trigger",
    inputs: [], outputs: [{ id: "out", type: "gate", label: "Triggered" }],
    params: [{ id: "seconds", type: "number", default: 10, label: "Seconds" }]
  },
  // For project-wide "global" pipelines only (attached via drag-onto-the-map
  // in fence-editor.html, not tied to any one zone) — zone_enter/exit/dwell
  // have no meaning with no owning zone to enter/exit, so a global pipeline's
  // only trigger is "evaluated every GPS tick, unconditionally." There's no
  // built-in rate limiting: wiring this straight into action.speak fires on
  // every tick (several times a second) — gate it through logic.* first.
  "trigger.always": {
    label: "On Every Tick", category: "trigger",
    inputs: [], outputs: [{ id: "out", type: "gate", label: "Triggered" }],
    params: []
  },
  "data.weather": {
    label: "Weather", category: "data",
    inputs: [],
    outputs: [
      { id: "tempC", type: "number", label: "Temperature (°C)" }, { id: "windKph", type: "number", label: "Wind Speed (km/h)" },
      { id: "windDirDeg", type: "number", label: "Wind Direction (°)" }, { id: "precip1hMm", type: "number", label: "Rain, Last Hour (mm)" },
      { id: "precip24hMm", type: "number", label: "Rain, Last 24h (mm)" }
    ],
    params: []
  },
  "data.snow_history": {
    label: "Snow History", category: "data",
    inputs: [],
    outputs: [{ id: "hn24Cm", type: "number", label: "New Snow, 24h (cm)" }, { id: "precip24hMm", type: "number", label: "Rain, Last 24h (mm)" }, { id: "tempC", type: "number", label: "Temperature (°C)" }],
    params: []
  },
  "data.position": {
    label: "Position", category: "data",
    inputs: [],
    outputs: [{ id: "speedKmh", type: "number", label: "Speed (km/h)" }, { id: "headingDeg", type: "number", label: "Heading (°)" }, { id: "distFromZoneCenterM", type: "number", label: "Distance from Zone Center (m)" }],
    params: []
  },
  "data.dwell_time": {
    label: "Dwell Time", category: "data",
    inputs: [], outputs: [{ id: "seconds", type: "number", label: "Seconds in Zone" }],
    params: []
  },
  "data.zone_props": {
    label: "Zone Properties", category: "data",
    inputs: [],
    outputs: [{ id: "bearingDeg", type: "number", label: "Bearing (°)" }, { id: "isHazard", type: "gate", label: "Is Hazard" }, { id: "id", type: "text", label: "Zone ID" }],
    params: []
  },
  // Only populated when the project has a Walking Path selected — see
  // PipelineRuntime.setPathProgress(), called once per GPS tick by whichever
  // host (geofence-engine.html, geofence-sim.html, fence-editor.html's
  // SimFencer) owns the live position + map-matching. All ports are null
  // when no path is active, or before the visitor has map-matched onto it.
  "data.walking_path_progress": {
    label: "Walking Path Progress", category: "data",
    inputs: [],
    outputs: [
      { id: "distanceCoveredM", type: "number", label: "Distance Walked (m)" }, { id: "distanceRemainingM", type: "number", label: "Distance Remaining (m)" },
      { id: "totalDistanceM", type: "number", label: "Total Distance (m)" }, { id: "pctComplete", type: "number", label: "% Complete" },
      { id: "elevGainSoFarM", type: "number", label: "Elevation Gained So Far (m)" }, { id: "elevLossSoFarM", type: "number", label: "Elevation Lost So Far (m)" },
      { id: "totalElevGainM", type: "number", label: "Total Elevation Gain (m)" }, { id: "totalElevLossM", type: "number", label: "Total Elevation Loss (m)" },
      { id: "etaSeconds", type: "number", label: "Time Remaining (sec)" }
    ],
    params: []
  },
  "logic.compare": {
    label: "Compare", category: "logic",
    inputs: [{ id: "in", type: "number" }, { id: "gate", type: "gate" }],
    outputs: [{ id: "out", type: "gate", label: "Triggered" }],
    params: [
      { id: "op", type: "select", options: ["gt", "lt", "eq"], default: "gt", label: "Operator" },
      { id: "value", type: "number", default: 0, label: "Value" }
    ]
  },
  "logic.and": {
    label: "And", category: "logic",
    inputs: [{ id: "a", type: "gate" }, { id: "b", type: "gate" }],
    outputs: [{ id: "out", type: "gate", label: "Triggered" }], params: []
  },
  "logic.or": {
    label: "Or", category: "logic",
    inputs: [{ id: "a", type: "gate" }, { id: "b", type: "gate" }],
    outputs: [{ id: "out", type: "gate", label: "Triggered" }], params: []
  },
  "logic.aspect_load": {
    label: "Aspect Load", category: "logic",
    inputs: [{ id: "windDirDeg", type: "number" }, { id: "bearingDeg", type: "number" }],
    outputs: [{ id: "out", type: "gate", label: "Triggered" }],
    params: [{ id: "toleranceDeg", type: "number", default: 90, label: "Tolerance (deg)" }]
  },
  "action.speak": {
    label: "Speak", category: "action",
    inputs: [{ id: "in", type: "gate" }], outputs: [],
    // interpolatable: true flags this specific param as one interpolate()
    // actually processes at tick time (see evalGraph's "action.speak" case) —
    // pipeline-editor.html uses this flag to decide which text fields get the
    // "insert value" picker + broken-reference validation, since e.g.
    // action.webhook's url param below looks like free text too but is
    // never run through interpolate().
    params: [{ id: "text", type: "text", default: "", label: "Text", interpolatable: true }]
  },
  "action.guide_to_zone": {
    label: "Guide To Zone", category: "action",
    inputs: [{ id: "in", type: "gate" }], outputs: [],
    params: [{ id: "targetZoneId", type: "zoneSelect", default: "", label: "Target zone" }]
  },
  "action.webhook": {
    label: "Webhook", category: "action",
    inputs: [{ id: "in", type: "gate" }], outputs: [],
    params: [
      { id: "url", type: "text", default: "", label: "URL" },
      { id: "includeDevice", type: "boolean", default: false, label: "Include device id" }
    ]
  }
};

/* ===================== GRAPH HELPERS ===================== */
// Kahn's algorithm. Returns { order, cyclic } — order is a valid topo-sorted node-id
// list (possibly partial if cyclic:true, in which case the graph must not be saved).
function topoSort(nodes, edges) {
  const ids = nodes.map(n => n.id);
  const indeg = {}; ids.forEach(id => indeg[id] = 0);
  const adj = {}; ids.forEach(id => adj[id] = []);
  edges.forEach(e => {
    if (!(e.from.n in adj) || !(e.to.n in indeg)) return; // ignore dangling edges
    adj[e.from.n].push(e.to.n);
    indeg[e.to.n]++;
  });
  const queue = ids.filter(id => indeg[id] === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    adj[id].forEach(next => { if (--indeg[next] === 0) queue.push(next); });
  }
  return { order, cyclic: order.length !== ids.length };
}

function findSourceEdge(edges, nodeId, portId) {
  return edges.find(e => e.to.n === nodeId && e.to.p === portId);
}

function interpolate(text, cache) {
  if (!text) return text;
  return text.replace(/\{\{(\w+)\.(\w+)\}\}/g, (m, n, p) => {
    const v = cache[n] && cache[n][p];
    return v == null ? "" : String(v);
  });
}

/* ===================== RUNTIME ===================== */
// One compiled graph per active zone, keyed by zone id.
const compiled = {};
// The project's global functions (Code Objects dropped on the map rather
// than a stop) — at most one compiled graph, ticked every GPS fix
// unconditionally rather than being gated by any zone's enter/exit/dwell.
// Compiled the same way a zone is (compile() below), just against a
// synthetic zone-less shape — see loadGlobal().
let globalCompiled = null;
let dataCache = {}; // { weather:{...}, snowHistory:{...} } — shared across zones, refreshed on an interval
let dataTimer = null;
let callbacks = {};

// Path-level (not per-zone) progress along the project's selected Walking
// Path — pushed in by the host once per GPS tick via setPathProgress(),
// since only the host owns live position + the path's map-matching/profile
// data. null until a path is active and the visitor has map-matched onto it.
let pathProgress = null;

// objectId@version -> {template:{v,nodes,edges}, paramSchema} — fetched once,
// cached forever per page load (a given version's definition is immutable).
const codeObjectDefCache = {};

async function fetchCodeObjectDef(objectId, version) {
  const key = objectId + "@" + version;
  if (key in codeObjectDefCache) return codeObjectDefCache[key];
  let def = null;
  try {
    const r = await fetch("/api/code-objects/" + encodeURIComponent(objectId));
    if (r.ok) def = await r.json();
  } catch (e) { /* degrade silently, same convention as refreshDataCache */ }
  codeObjectDefCache[key] = def;
  return def;
}

// Inlines each attached code object's template nodes/edges, namespaced per
// instance so multiple attachments (or the same object attached twice) never
// collide with each other or with the zone's own hand-built pipeline nodes.
async function resolveCodeObjects(zone) {
  const nodes = [], edges = [];
  if (!zone.codeObjects || !zone.codeObjects.length) return { nodes, edges };
  let idx = 0;
  for (const inst of zone.codeObjects) {
    const def = await fetchCodeObjectDef(inst.objectId, inst.version);
    idx++;
    if (!def || !def.template || !Array.isArray(def.template.nodes)) continue;
    const prefix = "co" + idx + "_";
    const idMap = {};
    def.template.nodes.forEach(n => { idMap[n.id] = prefix + n.id; });
    // Rewrite {{nodeId.port}} interpolation references (e.g. in action.speak's
    // text param) to the namespaced node ids — otherwise a template's own
    // internal references silently resolve to nothing once its nodes are
    // renamed, since interpolate() looks values up by the *compiled* node id.
    const rewriteRefs = (s) => typeof s === "string"
      ? s.replace(/\{\{(\w+)\.(\w+)\}\}/g, (m, n, p) => (n in idMap) ? "{{" + idMap[n] + "." + p + "}}" : m)
      : s;
    def.template.nodes.forEach(n => {
      const nid = idMap[n.id];
      const params = {};
      Object.keys(n.params || {}).forEach(k => { params[k] = rewriteRefs(n.params[k]); });
      (def.paramSchema || []).forEach(p => {
        if (p.nodeId === n.id && inst.params && inst.params[p.paramKey] !== undefined) {
          params[p.paramKey] = inst.params[p.paramKey];
        }
      });
      nodes.push({ ...n, id: nid, params });
    });
    (def.template.edges || []).forEach(e => {
      if (!(e.from.n in idMap) || !(e.to.n in idMap)) return; // dangling within its own template — ignore
      edges.push({ id: prefix + e.id, from: { n: idMap[e.from.n], p: e.from.p }, to: { n: idMap[e.to.n], p: e.to.p } });
    });
  }
  return { nodes, edges };
}

async function compile(zone) {
  const pipeline = (zone.pipeline && Array.isArray(zone.pipeline.nodes)) ? zone.pipeline : { nodes: [], edges: [] };
  const resolved = await resolveCodeObjects(zone);
  const nodes = [...pipeline.nodes, ...resolved.nodes];
  const edges = [...(pipeline.edges || []), ...resolved.edges];
  if (!nodes.length) return null;
  const { order, cyclic } = topoSort(nodes, edges);
  if (cyclic) { console.warn("[PipelineRuntime] zone", zone.id, "pipeline has a cycle — skipped"); return null; }
  const byId = {}; nodes.forEach(n => byId[n.id] = n);
  return { order, byId, edges, zone };
}

async function refreshDataCache() {
  // GET /api/weather returns the latest weather_cache row directly (or {error} on 404).
  try {
    const r = await fetch("/api/weather");
    if (r.ok) dataCache.weather = await r.json();
  } catch (e) { /* keep last-known value, degrade silently */ }
  // GET /api/snow-history returns snow_history rows, ORDER BY snapshot_date DESC — index 0 is most recent.
  try {
    const r = await fetch("/api/snow-history");
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length) dataCache.snowHistory = rows[0];
    }
  } catch (e) { /* keep last-known value */ }
}

// Shared by tick() (per-zone, gated by enter/exit/dwell evt) and tickGlobal()
// (the project-wide graph, evaluated every fix with an empty evt) — the only
// difference between the two call sites is which compiled graph g they pass
// and what evt looks like; the node-by-node evaluation itself doesn't care
// whether g.zone is a real zone or null.
// fix: {lat,lon,speed,headingTravel,acc,t}; smoothedPos: Smoother output for this tick
// evt: { entered:bool, exited:bool, dwellSeconds:number|null } — {} for a global graph
function evalGraph(g, fix, smoothedPos, evt) {
  const cache = {}; // nodeId -> { portId: value }
  g.order.forEach(id => {
    const node = g.byId[id];
    const def = BLOCKS[node.type];
    if (!def) return;
    cache[id] = {};
    const getIn = (portId) => {
      const e = findSourceEdge(g.edges, id, portId);
      if (!e) return undefined;
      const src = cache[e.from.n];
      return src ? src[e.from.p] : undefined;
    };

    switch (node.type) {
      case "trigger.zone_enter": cache[id].out = !!evt.entered; break;
      case "trigger.zone_exit": cache[id].out = !!evt.exited; break;
      case "trigger.always": cache[id].out = true; break;
      case "trigger.dwell": {
        const need = (node.params && node.params.seconds) || 10;
        cache[id].out = evt.dwellSeconds != null && evt.dwellSeconds >= need;
        break;
      }
      case "data.weather": {
        const w = dataCache.weather || {};
        cache[id].tempC = w.ww_temp_c ?? null; cache[id].windKph = w.ww_wind_spd_kph ?? null;
        cache[id].windDirDeg = w.ww_wind_dir_deg ?? null; cache[id].precip1hMm = w.hour_precip_mm ?? null;
        cache[id].precip24hMm = w.precip_24hr_mm ?? null;
        break;
      }
      case "data.snow_history": {
        const s = dataCache.snowHistory || {};
        cache[id].hn24Cm = s.hn24_cm ?? null; cache[id].precip24hMm = s.precip_24hr_mm ?? null; cache[id].tempC = s.ww_temp_c ?? null;
        break;
      }
      case "data.position": {
        // Rounded before caching — unlike every other numeric pipeline output
        // (data.walking_path_progress rounds everything before exposing it),
        // this was left as a raw float. smoothedPos.speed*3.6 routinely comes
        // out as something like 7.046582164416, which interpolate()'s
        // String(v) then drops verbatim into Speak text — spoken aloud, a
        // 12-digit decimal tail reads as an endless run of digits.
        cache[id].speedKmh = smoothedPos && smoothedPos.speed != null ? Math.round(smoothedPos.speed * 3.6 * 10) / 10 : null;
        cache[id].headingDeg = smoothedPos && smoothedPos.headingTravel != null ? Math.round(smoothedPos.headingTravel) : null;
        cache[id].distFromZoneCenterM = evt.distFromZoneCenterM != null ? Math.round(evt.distFromZoneCenterM) : null;
        break;
      }
      case "data.dwell_time": cache[id].seconds = evt.dwellSeconds ?? null; break;
      case "data.walking_path_progress": {
        const p = pathProgress || {};
        cache[id].distanceCoveredM = p.distanceCoveredM ?? null;
        cache[id].distanceRemainingM = p.distanceRemainingM ?? null;
        cache[id].totalDistanceM = p.totalDistanceM ?? null;
        cache[id].pctComplete = p.pctComplete ?? null;
        cache[id].elevGainSoFarM = p.elevGainSoFarM ?? null;
        cache[id].elevLossSoFarM = p.elevLossSoFarM ?? null;
        cache[id].totalElevGainM = p.totalElevGainM ?? null;
        cache[id].totalElevLossM = p.totalElevLossM ?? null;
        cache[id].etaSeconds = p.etaSeconds ?? null;
        break;
      }
      case "data.zone_props": {
        cache[id].bearingDeg = (g.zone && g.zone.bearingDeg != null) ? g.zone.bearingDeg : null;
        cache[id].isHazard = !!(g.zone && (g.zone.isHazard || (g.zone.codeObjects||[]).some(co=>co.objectId===HAZARD_CODE_OBJECT_ID)));
        cache[id].id = g.zone ? g.zone.id : null;
        break;
      }
      case "logic.aspect_load": {
        const windDirDeg = getIn("windDirDeg"); const bearingDeg = getIn("bearingDeg");
        const tol = (node.params && node.params.toleranceDeg) || 90;
        let pass = false;
        if (windDirDeg != null && bearingDeg != null) {
          // "Loaded" aspect is the leeward side — roughly opposite the direction wind blows from.
          const leewardDeg = (windDirDeg + 180) % 360;
          let diff = Math.abs(bearingDeg - leewardDeg) % 360;
          if (diff > 180) diff = 360 - diff;
          pass = diff <= tol / 2;
        }
        cache[id].out = pass;
        break;
      }
      case "logic.compare": {
        const inVal = getIn("in"); const gate = getIn("gate");
        const op = (node.params && node.params.op) || "gt";
        const val = (node.params && node.params.value) || 0;
        let pass = false;
        if (inVal != null) {
          pass = op === "gt" ? inVal > val : op === "lt" ? inVal < val : inVal === val;
        }
        cache[id].out = !!gate && pass;
        break;
      }
      case "logic.and": cache[id].out = !!getIn("a") && !!getIn("b"); break;
      case "logic.or": cache[id].out = !!getIn("a") || !!getIn("b"); break;
      case "action.speak": {
        if (getIn("in") && callbacks.sayFn) {
          callbacks.sayFn(interpolate((node.params && node.params.text) || "", cache));
        }
        break;
      }
      case "action.guide_to_zone": {
        if (getIn("in") && callbacks.guideStartFn) {
          const targetId = node.params && node.params.targetZoneId;
          const targetZone = (callbacks.allZones || []).find(z => z.id === targetId);
          if (targetZone) callbacks.guideStartFn(targetZone);
        }
        break;
      }
      case "action.webhook": {
        if (getIn("in") && callbacks.webhookFn) {
          callbacks.webhookFn(node.params && node.params.url, node.params && node.params.includeDevice);
        }
        break;
      }
    }
  });
}

const PipelineRuntime = {
  BLOCKS, topoSort, // exposed for pipeline-editor.html's validation/property-panel use

  async load(zone, opts) {
    callbacks = opts || {};
    const g = await compile(zone);
    if (g) compiled[zone.id] = g;
    if (!dataTimer) {
      refreshDataCache();
      dataTimer = setInterval(refreshDataCache, 5 * 60 * 1000);
    }
  },

  // Compiles the project's global functions (Code Objects dropped on the map,
  // not on any stop) into one graph, reusing compile()/resolveCodeObjects()
  // against a synthetic zone-less shape — its data.zone_props block (if one's
  // wired in) just reads null/false off a zone that doesn't exist, same
  // null-propagation convention every other missing-data case here already
  // uses. Pass an empty array (or null) to clear it. Call once per bundle/
  // session load, same lifecycle as prefetch() below.
  async loadGlobal(globalCodeObjectRefs, opts) {
    callbacks = opts || callbacks || {};
    const g = await compile({ id: "__global__", codeObjects: globalCodeObjectRefs || [], pipeline: null });
    globalCompiled = g; // g is null when there's nothing wired in — tickGlobal() no-ops on null
    if (!dataTimer) {
      refreshDataCache();
      dataTimer = setInterval(refreshDataCache, 5 * 60 * 1000);
    }
  },

  // Warms codeObjectDefCache for every zone in a bundle before any GPS event
  // fires, so the per-zone `await load()` on actual entry resolves instantly
  // instead of racing the first tick against a network fetch.
  async prefetch(zones) {
    const seen = new Set();
    for (const zone of (zones || [])) {
      for (const inst of (zone.codeObjects || [])) {
        const key = inst.objectId + "@" + inst.version;
        if (seen.has(key)) continue;
        seen.add(key);
        await fetchCodeObjectDef(inst.objectId, inst.version);
      }
    }
  },

  unload(zoneId) {
    delete compiled[zoneId];
  },

  // p: {distanceCoveredM,distanceRemainingM,totalDistanceM,pctComplete,
  //     elevGainSoFarM,elevLossSoFarM,totalElevGainM,totalElevLossM,etaSeconds}
  // or null (no path active / not yet map-matched onto it). Call once per GPS
  // tick, before tick() — every zone's data.walking_path_progress block reads
  // the same shared value, same pattern as weather's refreshDataCache().
  setPathProgress(p) {
    pathProgress = p;
  },

  // fix: {lat,lon,speed,headingTravel,acc,t}; smoothedPos: Smoother output for this tick
  // evt: { entered:bool, exited:bool, dwellSeconds:number|null }
  tick(zoneId, fix, smoothedPos, evt) {
    const g = compiled[zoneId];
    if (!g) return;
    evalGraph(g, fix, smoothedPos, evt);
  },

  // Runs the project's global graph (see loadGlobal()) for this GPS fix, with
  // no enter/exit/dwell lifecycle — call once per fix, same cadence as the
  // per-zone tick() calls, independent of which (if any) zone the visitor is
  // currently inside.
  tickGlobal(fix, smoothedPos) {
    if (!globalCompiled) return;
    evalGraph(globalCompiled, fix, smoothedPos, {});
  }
};

global.PipelineRuntime = PipelineRuntime;
})(typeof window !== "undefined" ? window : this);
