-- Saved Audio Studio arrangements ("sessions") — lets a play's Act/Scene
-- structure be built entirely out of the existing audio folder tree (an Act
-- and its Scenes are just regular audio_folder rows) with each scene's
-- Studio timeline saved as a small named entry inside that scene's folder,
-- right alongside the clips it uses. A session stores which clips are
-- arranged and how (trim points, fades, gain, spatial filter per segment) —
-- never raw audio — referencing clips by their permanent R2 URL, same as the
-- existing per-project localStorage timeline draft already does.
CREATE TABLE IF NOT EXISTS studio_session (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL DEFAULT 'project',  -- sessions only ever belong to a project, not the org Library
  scope_id      TEXT NOT NULL,                    -- projectId
  folder_id     TEXT REFERENCES audio_folder(id), -- NULL = project root; normally an Act/Scene folder
  name          TEXT NOT NULL,
  timeline_json TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS studio_session_scope_idx ON studio_session(scope, scope_id, folder_id);
