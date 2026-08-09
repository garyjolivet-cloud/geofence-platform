-- RECORD program: a general-purpose, security-DVR-style tool for reviewing
-- GPS/motion data over time (freeride run judging, patrol end-of-day
-- sweeps, danger-zone liability tracking, bike/nordic club trail-use
-- recording, and future uses) — rather than the "latest position only"
-- presence table or the discrete zone-transition event log.
--
-- record_session is an explicit start/stop recording. `type` is a
-- free-form activity label (not a fixed enum) since different clubs/orgs
-- need their own vocabulary — real organization is the folder tree below,
-- same as every other kind of data in this app (audio_folder, stop_folder,
-- walking_path_folder).
--
-- incident_clip-style sessions (source_session_id set) are a real copy of
-- a trimmed range from a source session, not a saved pointer into it —
-- this lets a flagged incident survive the source session's own retention
-- sweep, mirroring "protect this clip" on a security DVR.
--
-- record_folder mirrors stop_folder/walking_path_folder: its own table,
-- always project-scoped (no library tier — confirmed pattern is that each
-- domain gets its own tree rather than sharing audio_folder's). Folder
-- delete moves contents up to the parent instead of destroying them, same
-- reasoning as walking_path_folder ("a physically-recorded field walk —
-- expensive to redo, not just re-uploadable"), which applies at least as
-- strongly here given the liability use case.
CREATE TABLE IF NOT EXISTS record_folder (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id  TEXT REFERENCES record_folder(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS record_folder_project_idx ON record_folder(project_id, parent_id);

CREATE TABLE IF NOT EXISTS record_session (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id),
  folder_id         TEXT REFERENCES record_folder(id),
  type              TEXT NOT NULL DEFAULT '',
  user_id           TEXT,
  label             TEXT NOT NULL DEFAULT '',
  notes             TEXT NOT NULL DEFAULT '',
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  locked            INTEGER NOT NULL DEFAULT 0,
  source_session_id TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS record_session_project_idx ON record_session(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS record_session_folder_idx ON record_session(folder_id);

CREATE TABLE IF NOT EXISTS position_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES record_session(id),
  project_id TEXT NOT NULL,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  acc        REAL,
  heading    REAL,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS position_history_session_idx ON position_history(session_id, ts);
CREATE INDEX IF NOT EXISTS position_history_project_idx ON position_history(project_id, ts);

-- NULL = retention disabled (keep recordings indefinitely, subject to
-- manual deletion only). Set from the project settings gear popover.
ALTER TABLE project ADD COLUMN record_retention_days INTEGER;
