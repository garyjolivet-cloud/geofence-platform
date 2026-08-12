-- AR/3D Object Layer, Phase 0 (foundation). See
-- C:\Users\garyj\.claude\plans\design-a-best-in-cosmic-pudding.md for the
-- full architecture. Two independent pieces:
--
-- 1. `three_d_enabled` on `app` — the single tenant-level flag that governs
--    the whole 3D upgrade (terrain rendering across all 5 map surfaces, plus
--    whether the Fence Editor exposes AR-object authoring at all). Deliberately
--    one flag, not split per-feature, per explicit user direction ("all maps
--    should be 3d").
-- 2. `asset_folder`/`asset_object` — a 3D-model library, structurally
--    identical to `audio_folder`/`audio_clip` (migrations/0019_audio_tree.sql):
--    same project/library scoping, same folder-tree shape, same
--    permanent-opaque-r2_key convention (rename/move is a metadata update,
--    never touches R2). `asset_object` additionally supports `kind='url'`
--    (an externally-hosted glTF, e.g. a Sketchfab link) as a lighter
--    alternative to uploading — those rows have no r2_key at all.
ALTER TABLE app ADD COLUMN three_d_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS asset_folder (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,  -- 'project' | 'library'
  scope_id   TEXT NOT NULL,  -- projectId or orgId
  parent_id  TEXT REFERENCES asset_folder(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS asset_folder_scope_idx ON asset_folder(scope, scope_id, parent_id);

CREATE TABLE IF NOT EXISTS asset_object (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,  -- 'project' | 'library'
  scope_id   TEXT NOT NULL,  -- projectId or orgId
  folder_id  TEXT REFERENCES asset_folder(id),
  name       TEXT NOT NULL,  -- display filename incl. extension
  kind       TEXT NOT NULL DEFAULT 'upload',  -- 'upload' | 'url'
  r2_key     TEXT UNIQUE,    -- set when kind='upload', NULL when kind='url'
  source_url TEXT,           -- set when kind='url', NULL when kind='upload'
  format     TEXT NOT NULL DEFAULT 'glb',  -- 'glb' | 'gltf'
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS asset_object_scope_idx ON asset_object(scope, scope_id, folder_id);
