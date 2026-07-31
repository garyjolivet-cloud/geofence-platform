-- Real nested folder tree for audio clips, replacing the old "R2 key prefix
-- IS the folder path" model (flat project clips, one-flat-level Library).
-- The tree lives entirely here in D1; R2 keys become permanent, opaque ids
-- that never change on rename/move — only new uploads/copies get a fresh
-- r2_key, so folder rename/move/copy are instant metadata operations
-- regardless of depth or how many clips live underneath. Existing R2 objects
-- keep their current path-shaped key forever (see the migrate-legacy
-- endpoint in worker.js) — this is a one-way decoupling, not a bulk rewrite.
--
-- scope='project' + scope_id=<projectId>: a project's own clips, now
-- foldered (previously explicitly flat). scope='library' + scope_id=<orgId>:
-- one company's shared library, foldered and nestable (previously one flat
-- level). parent_id/folder_id NULL = root of that scope's tree.
CREATE TABLE IF NOT EXISTS audio_folder (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,  -- 'project' | 'library'
  scope_id   TEXT NOT NULL,  -- projectId or orgId
  parent_id  TEXT REFERENCES audio_folder(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS audio_folder_scope_idx ON audio_folder(scope, scope_id, parent_id);

CREATE TABLE IF NOT EXISTS audio_clip (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,  -- 'project' | 'library'
  scope_id   TEXT NOT NULL,  -- projectId or orgId
  folder_id  TEXT REFERENCES audio_folder(id),
  name       TEXT NOT NULL,  -- display filename incl. extension
  r2_key     TEXT NOT NULL UNIQUE,
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS audio_clip_scope_idx ON audio_clip(scope, scope_id, folder_id);
