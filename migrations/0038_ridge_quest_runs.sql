-- Ridge Quest (R1): quest_run — one row per completed corridor crossing
-- (ski/lift/hike), classified client-side by ridge-quest.html's own
-- self-contained GPS-watch + corridor-detector (zero changes to
-- geofence-engine.html/geofence-sim.html/fence-editor.html, see
-- decision-ridge-quest-fog-of-war-game memory / the plan file's R1 section
-- for why). No quest_session table — day-grouping derives from
-- date(started_at) directly at read time.
CREATE TABLE IF NOT EXISTS quest_run (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES player_account(id),
  app_id        TEXT NOT NULL,
  zone_id       TEXT NOT NULL,
  run_name      TEXT,
  difficulty    TEXT,
  run_type      TEXT,
  activity      TEXT NOT NULL,  -- 'ski' | 'lift' | 'hike'
  started_at    TEXT NOT NULL,
  ended_at      TEXT NOT NULL,
  duration_s    REAL NOT NULL,
  vertical_m    REAL,
  distance_m    REAL,
  avg_speed_mps REAL,
  max_speed_mps REAL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS quest_run_player_started ON quest_run(player_id, started_at DESC);
