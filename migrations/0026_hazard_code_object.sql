-- Hazard marking moved from a per-zone boolean checkbox to a Code Object,
-- consistent with every other reusable behavior in this app (drag onto a
-- stop from the floating palette instead of a one-off UI toggle). This is a
-- pure presence marker (empty template) — nothing about it executes through
-- pipeline-runtime.js; guidance-bot.js and pipeline-runtime.js's
-- data.zone_props both check for its attachment by this fixed id
-- ('hazard-zone') rather than running its (empty) node graph.
INSERT OR IGNORE INTO code_object (id, org_id, built_in, name, description, icon, category, version, template, param_schema, feature_key)
VALUES (
  'hazard-zone',
  NULL,
  1,
  'Hazard Zone',
  'Marks this stop as a routing obstacle — Guidance Bot automatically routes visitors around it instead of through it.',
  '⚠️',
  'safety',
  1,
  '{"v":1,"nodes":[],"edges":[]}',
  '[]',
  'hazard-zone'
);
