CREATE TABLE IF NOT EXISTS project_link (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  expires_at INTEGER,
  label      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS project_link_token ON project_link(token);
CREATE INDEX IF NOT EXISTS project_link_proj  ON project_link(project_id);
