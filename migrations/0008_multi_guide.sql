-- Multiple guides per project (M:M)
CREATE TABLE IF NOT EXISTS project_guide (
  project_id  TEXT NOT NULL,
  guide_id    TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (project_id, guide_id)
);
CREATE INDEX IF NOT EXISTS idx_pg_guide   ON project_guide(guide_id);
CREATE INDEX IF NOT EXISTS idx_pg_project ON project_guide(project_id);

-- Walk link attribution: which guide owns this link
ALTER TABLE project_link ADD COLUMN guide_id TEXT;

-- Per-session event tracking: which walk link generated these events
ALTER TABLE event ADD COLUMN link_token TEXT;
