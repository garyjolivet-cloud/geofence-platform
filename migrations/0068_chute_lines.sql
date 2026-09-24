-- Ridge Quest chute lines — a rider's saved GPS line for each verified chute
-- descent made while Corridor Guard was on for that chute. Only the verified
-- start->finish slice of the pass is stored, as [[lon,lat],...] (no speed or
-- time per point). Smoothing happens at display time, so the raw line is kept.
-- visible = the rider's per-entry on/off toggle; a new line starts on and the
-- server switches off anything beyond the newest 3 of that chute.
-- player_id is an FK to player_account, so "forget my data" and workspace
-- delete must remove these rows first (worker.js does).
CREATE TABLE IF NOT EXISTS chute_line (
  id          TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES player_account(id),
  app_id      TEXT NOT NULL,
  zone_id     TEXT NOT NULL,
  run_name    TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT NOT NULL,
  points_json TEXT NOT NULL,
  visible     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chute_line_player_zone ON chute_line(player_id, zone_id, started_at DESC);
