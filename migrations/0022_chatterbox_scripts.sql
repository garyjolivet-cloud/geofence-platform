-- Saved Chatterbox scripts — lets a script (pasted text, per-line voice
-- tagging, generated-audio-URL state) be saved, reopened, and organized in
-- the same audio_folder tree Chatterbox already saves its rendered clips
-- into, mirroring studio_session's exact pattern (a non-audio "saved
-- document" living alongside the audio it references, in the same Act/Scene
-- folders). Always project-scoped — no Library scripts, same restriction
-- sessions already have.
CREATE TABLE IF NOT EXISTS chatterbox_script (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL DEFAULT 'project',
  scope_id    TEXT NOT NULL,                    -- projectId
  folder_id   TEXT REFERENCES audio_folder(id), -- NULL = project root; normally an Act/Scene folder
  name        TEXT NOT NULL,
  script_json TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS chatterbox_script_scope_idx ON chatterbox_script(scope, scope_id, folder_id);
