CREATE TABLE IF NOT EXISTS live_zone (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  zone_json  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS live_zone_project ON live_zone(project_id, expires_at);
