-- Code Objects: reusable, parameterized behavior templates that can be
-- attached to many stops at once (zone.codeObjects: [{objectId,version,params}])
-- instead of hand-wiring the same pipeline graph per stop. Internally a code
-- object is still the same {v:1,nodes,edges} shape zone.pipeline already uses —
-- pipeline-runtime.js inlines a referenced template's nodes/edges alongside a
-- zone's own pipeline at compile time, so no second execution engine exists.
-- org_id NULL = built-in/system template, available to any org with a matching
-- org_entitlement grant (the upsell mechanism — default-deny, no blanket access).
CREATE TABLE IF NOT EXISTS code_object (
  id           TEXT PRIMARY KEY,
  org_id       TEXT,
  built_in     INTEGER NOT NULL DEFAULT 0,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  icon         TEXT NOT NULL DEFAULT '🧩',
  category     TEXT NOT NULL DEFAULT 'custom',
  version      INTEGER NOT NULL DEFAULT 1,
  template     TEXT NOT NULL,
  param_schema TEXT NOT NULL DEFAULT '[]',
  feature_key  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS code_object_org_idx ON code_object(org_id);
CREATE INDEX IF NOT EXISTS code_object_feature_idx ON code_object(feature_key);

CREATE TABLE IF NOT EXISTS org_entitlement (
  org_id      TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  granted_at  TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by  TEXT,
  PRIMARY KEY (org_id, feature_key)
);

-- Seed the flagship built-in example. zone_enter gates on hn24Cm>15cm AND the
-- stop's own bearing being on the wind-loaded (leeward) aspect; only speaks
-- once per entry via the same gate-pulse convention every other trigger uses.
INSERT OR IGNORE INTO code_object (id, org_id, built_in, name, description, icon, category, version, template, param_schema, feature_key)
VALUES (
  'snow-load-bearing-check',
  NULL,
  1,
  'Snow Load Bearing Check',
  'Warns visitors when overnight snowfall and wind direction indicate this stop''s aspect (bearing) is wind-loaded.',
  '❄️',
  'weather',
  1,
  '{"v":1,"nodes":[' ||
    '{"id":"n1","type":"trigger.zone_enter","x":40,"y":40,"params":{}},' ||
    '{"id":"n2","type":"data.snow_history","x":40,"y":140,"params":{}},' ||
    '{"id":"n3","type":"data.weather","x":40,"y":240,"params":{}},' ||
    '{"id":"n4","type":"data.zone_props","x":40,"y":340,"params":{}},' ||
    '{"id":"n5","type":"logic.compare","x":260,"y":140,"params":{"op":"gt","value":15}},' ||
    '{"id":"n6","type":"logic.aspect_load","x":260,"y":290,"params":{"toleranceDeg":90}},' ||
    '{"id":"n7","type":"logic.and","x":460,"y":190,"params":{}},' ||
    '{"id":"n8","type":"action.speak","x":660,"y":190,"params":{"text":"Careful here — {{n2.hn24Cm}} cm of snow overnight and this aspect looks wind-loaded."}}' ||
  '],"edges":[' ||
    '{"id":"e1","from":{"n":"n1","p":"out"},"to":{"n":"n5","p":"gate"}},' ||
    '{"id":"e2","from":{"n":"n2","p":"hn24Cm"},"to":{"n":"n5","p":"in"}},' ||
    '{"id":"e3","from":{"n":"n3","p":"windDirDeg"},"to":{"n":"n6","p":"windDirDeg"}},' ||
    '{"id":"e4","from":{"n":"n4","p":"bearingDeg"},"to":{"n":"n6","p":"bearingDeg"}},' ||
    '{"id":"e5","from":{"n":"n5","p":"out"},"to":{"n":"n7","p":"a"}},' ||
    '{"id":"e6","from":{"n":"n6","p":"out"},"to":{"n":"n7","p":"b"}},' ||
    '{"id":"e7","from":{"n":"n7","p":"out"},"to":{"n":"n8","p":"in"}}' ||
  ']}',
  '[{"id":"minSnowCm","nodeId":"n5","paramKey":"value","type":"number","default":15,"label":"Min overnight snow (cm)"}]',
  'snow-load-bearing-check'
);
