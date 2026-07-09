CREATE TABLE IF NOT EXISTS presence (
  device_id  TEXT NOT NULL,
  project_id TEXT NOT NULL,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  label      TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, project_id)
);
CREATE INDEX IF NOT EXISTS presence_project ON presence(project_id, updated_at);
