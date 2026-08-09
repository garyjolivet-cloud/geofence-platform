-- RECORD schedule: a per-project planning calendar for staff recording
-- windows (multiple dates per project). This is a planning/reference
-- calendar only, not an auto-trigger -- a record_session only ever gets
-- created because a device is physically running field-recorder.html with
-- an operator pressing Start/Stop (see migrations/0028_record_sessions.sql).
-- Nothing here changes that; a schedule row is just a plan staff can see
-- and work around.
CREATE TABLE IF NOT EXISTS record_schedule (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  starts_at  INTEGER NOT NULL,
  ends_at    INTEGER NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS record_schedule_project_idx ON record_schedule(project_id, starts_at);
