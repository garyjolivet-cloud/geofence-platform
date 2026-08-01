-- Folder tree for organizing map stops (zones) in the Fence Editor, when a
-- project has hundreds of them and a flat list becomes unusable. Deliberately
-- its own table, independent of audio_folder (Studio's Act/Scene audio
-- organization) — confirmed with the user that sharing the audio tree was
-- not useful in practice; stops get their own tree. Always project-scoped —
-- there's no "library" equivalent for stops.
CREATE TABLE IF NOT EXISTS stop_folder (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id  TEXT REFERENCES stop_folder(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS stop_folder_project_idx ON stop_folder(project_id, parent_id);
