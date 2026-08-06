-- Folder tree for organizing Code Objects, same shape as walking_path_folder
-- but org-scoped (code_object is org-level like the audio Library, not
-- app-level — see 0018_code_objects.sql's codeObjectScopeOk). Lets an org
-- with many custom behaviors organize them instead of one flat list.
CREATE TABLE IF NOT EXISTS code_object_folder (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  parent_id  TEXT REFERENCES code_object_folder(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS code_object_folder_org_idx ON code_object_folder(org_id, parent_id);

ALTER TABLE code_object ADD COLUMN folder_id TEXT REFERENCES code_object_folder(id);
