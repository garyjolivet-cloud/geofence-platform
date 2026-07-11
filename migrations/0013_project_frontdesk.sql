CREATE TABLE IF NOT EXISTS project_frontdesk (
  project_id   TEXT NOT NULL,
  frontdesk_id TEXT NOT NULL,
  assigned_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, frontdesk_id)
);
CREATE INDEX IF NOT EXISTS idx_pfd_frontdesk ON project_frontdesk(frontdesk_id);
CREATE INDEX IF NOT EXISTS idx_pfd_project   ON project_frontdesk(project_id);
