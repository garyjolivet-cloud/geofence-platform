-- Folder tree for organizing Walking Paths, same shape as stop_folder but
-- app-scoped (walking_path is app-level, not project-level — see
-- 0023_walking_paths.sql). Lets a workspace with many recorded routes
-- organize them instead of one flat list.
CREATE TABLE IF NOT EXISTS walking_path_folder (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL REFERENCES app(id),
  parent_id  TEXT REFERENCES walking_path_folder(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS walking_path_folder_app_idx ON walking_path_folder(app_id, parent_id);

ALTER TABLE walking_path ADD COLUMN folder_id TEXT REFERENCES walking_path_folder(id);
