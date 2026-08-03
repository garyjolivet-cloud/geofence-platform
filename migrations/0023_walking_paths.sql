-- Recorded walking paths: a continuous GPS trail (walked with Field Recorder,
-- filtered to drop humanly-impossible speed jumps, then named and saved) used
-- by the Fence Editor to let stops snap onto/slide along a real route, and by
-- the live visitor engine to map-match GPS fixes onto that route for more
-- accurate trigger detection. Flat list, no folders (confirmed with the user
-- — can be added later the same way stop/audio folders were, without
-- reworking storage). App-scoped (not project-scoped) so one recorded path
-- is reusable across every project in the same workspace — a genuinely new
-- scope tier: audio_folder/chatterbox_script are project-or-org, stop_folder
-- is project-only, nothing today scopes to app.id directly.
CREATE TABLE IF NOT EXISTS walking_path (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL REFERENCES app(id),
  name        TEXT NOT NULL,
  points_json TEXT NOT NULL,  -- [[lon,lat], ...] after filtering, in walked order
  distance_m  REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS walking_path_app_idx ON walking_path(app_id);
