/* PipelineRuntime — local DAG execution for zone.pipeline
 * Shared by pipeline-editor.html (registry + validation only), geofence-engine.html,
 * and fence-editor.html's embedded simulator (registry + full tick() execution).
 * Lifecycle modeled on guidance-bot.js: load()/tick()/unload(), side effects only
 * via injected callbacks, degrades gracefully rather than throwing.
 */
(function(global){
"use strict";

/* ===================== BLOCK REGISTRY ===================== */
// Each block declares its ports (gate = pulse-only boolean, anything else = a named
// data value) and, for data/logic/action blocks, an eval(ctx) used by the runtime.
// `params` describes editable fields for the property panel (id, type, default, label).
const BLOCKS = {
  "trigger.zone_enter": {
    label: "On Zone Enter", category: "trigger",
    inputs: [], outputs: [{ id: "out", type: "gate" }],
    params: []
  },
  "trigger.zone_exit": {
    label: "On Zone Exit", category: "trigger",
    inputs: [], outputs: [{ id: "out", type: "gate" }],
    params: []
  },
  "trigger.dwell": {
    label: "On Dwell", category: "trigger",
    inputs: [], outputs: [{ id: "out", type: "gate" }],
    params: [{ id: "seconds", type: "number", default: 10, label: "Seconds" }]
  },
  "data.weather": {
    label: "Weather", category: "data",
    inputs: [],
    outputs: [
      { id: "tempC", type: "number" }, { id: "windKph", type: "number" },
      { id: "windDirDeg", type: "number" }, { id: "precip1hMm", type: "number" },
      { id: "precip24hMm", type: "number" }
    ],
    params: []
  },
  "data.snow_history": {
    label: "Snow History", category: "data",
    inputs: [],
    outputs: [{ id: "hn24Cm", type: "number" }, { id: "precip24hMm", type: "number" }, { id: "tempC", type: "number" }],
    params: []
  },
  "data.position": {
    label: "Position", category: "data",
    inputs: [],
    outputs: [{ id: "speedKmh", type: "number" }, { id: "headingDeg", type: "number" }, { id: "distFromZoneCenterM", type: "number" }],
    params: []
  },
  "data.dwell_time": {
    label: "Dwell Time", category: "data",
    inputs: [], outputs: [{ id: "seconds", type: "number" }],
    params: []
  },
  "data.zone_props": {
    label: "Zone Properties", category: "data",
    inputs: [],
    outputs: [{ id: "bearingDeg", type: "number" }, { id: "isHazard", type: "gate" }, { id: "id", type: "text" }],
    params: []
  },
  "logic.compare": {
    label: "Compare", category: "logic",
    inputs: [{ id: "in", type: "number" }, { id: "gate", type: "gate" }],
    outputs: [{ id: "out", type: "gate" }],
    params: [
      { id: "op", type: "select", options: ["gt", "lt", "eq"], default: "gt", label: "Operator" },
      { id: "value", type: "number", default: 0, label: "Value" }
    ]
  },
  "logic.and": {
    label: "And", category: "logic",
    inputs: [{ id: "a", type: "gate" }, { id: "b", type: "gate" }],
    outputs: [{ id: "out", type: "gate" }], params: []
  },
  "logic.or": {
    label: "Or", category: "logic",
    inputs: [{ id: "a", type: "gate" }, { id: "b", type: "gate" }],
    outputs: [{ id: "out", type: "gate" }], params: []
  },
  "logic.aspect_load": {
    label: "Aspect Load", category: "logic",
    inputs: [{ id: "windDirDeg", type: "number" }, { id: "bearingDeg", type: "number" }],
    outputs: [{ id: "out", type: "gate" }],
    params: [{ id: "toleranceDeg", type: "number", default: 90, label: "Tolerance (deg)" }]
  },
  "action.speak": {
    label: "Speak", category: "action",
    inputs: [{ id: "in", type: "gate" }], outputs: [],
    params: [{ id: "text", type: "text", default: "", label: "Text ({{node.port}} to interpolate)" }]
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
let dataCache = {}; // { weather:{...}, snowHistory:{...} } — shared across zones, refreshed on an interval
let dataTimer = null;
let callbacks = {};

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

  // fix: {lat,lon,speed,headingTravel,acc,t}; smoothedPos: Smoother output for this tick
  // evt: { entered:bool, exited:bool, dwellSeconds:number|null }
  tick(zoneId, fix, smoothedPos, evt) {
    const g = compiled[zoneId];
    if (!g) return;
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
          cache[id].speedKmh = smoothedPos && smoothedPos.speed != null ? smoothedPos.speed * 3.6 : null;
          cache[id].headingDeg = smoothedPos ? smoothedPos.headingTravel : null;
          cache[id].distFromZoneCenterM = evt.distFromZoneCenterM ?? null;
          break;
        }
        case "data.dwell_time": cache[id].seconds = evt.dwellSeconds ?? null; break;
        case "data.zone_props": {
          cache[id].bearingDeg = (g.zone && g.zone.bearingDeg != null) ? g.zone.bearingDeg : null;
          cache[id].isHazard = !!(g.zone && g.zone.isHazard);
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
};

global.PipelineRuntime = PipelineRuntime;
})(typeof window !== "undefined" ? window : this);
