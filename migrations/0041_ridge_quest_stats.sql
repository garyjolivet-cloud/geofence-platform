-- Ridge Quest (R3-core): player_day_stats — one row per (player, day
-- bucket), incrementally upserted as each quest_run completes (folded into
-- POST /api/quest-runs's own batch, never a separate write path — see the
-- R3-core plan section for why). Feeds daily/season leaderboards and
-- streak computation (derived at read time from these rows, not stored).
-- season_id is included from the start, not added later — adding a column
-- to an FK-referenced table later means a rebuild-and-swap migration (see
-- feedback-d1-fk-rebuild-gotcha memory).
-- app_id is denormalized here (not joined from player_account), same choice
-- quest_run already made — a leaderboard query scans many players' rows and
-- needs to filter by app without a join on every read.
CREATE TABLE IF NOT EXISTS player_day_stats (
  player_id  TEXT NOT NULL REFERENCES player_account(id),
  app_id     TEXT NOT NULL,
  date       TEXT NOT NULL,  -- YYYY-MM-DD, fixed -7h (Golden BC) bucket — see questDateBucket() in worker.js
  season_id  TEXT NOT NULL,  -- e.g. "2026-2027" — see questSeasonId() in worker.js
  points     INTEGER NOT NULL DEFAULT 0,
  vertical_m REAL NOT NULL DEFAULT 0,
  runs_count INTEGER NOT NULL DEFAULT 0,
  lift_rides INTEGER NOT NULL DEFAULT 0,
  hikes      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, date)
);

CREATE INDEX IF NOT EXISTS player_day_stats_season ON player_day_stats(player_id, season_id, date DESC);
CREATE INDEX IF NOT EXISTS player_day_stats_leaderboard_daily ON player_day_stats(app_id, date, points DESC);
CREATE INDEX IF NOT EXISTS player_day_stats_leaderboard_season ON player_day_stats(app_id, season_id, points DESC);
