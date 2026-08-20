-- Ridge Quest (R6): player_day_activity_stats — a PARALLEL per-activity
-- rollup, NOT a rebuild of player_day_stats (0041). player_day_stats's PK
-- (player_id, date) is a fixed shape, and its runs_count/lift_rides/hikes
-- columns are three mutually-exclusive counters keyed to ski/lift/hike
-- specifically — there is no clean way to extend it for bike/drive without
-- an activity dimension in the PK, which would mean a destructive rebuild
-- (the exact DROP/RENAME-on-an-FK-referenced-table trap this platform has
-- already hit once — see the D1 FK rebuild gotcha memory). Adding this
-- table instead means zero migration risk to existing rows or the existing
-- combined daily/season leaderboard, which keeps reading player_day_stats
-- completely unchanged.
--
-- Written in the SAME D1 batch as quest_run/player_day_stats at insert
-- time (POST /api/quest-runs) — never a separate write path, so it can't
-- drift out of sync with them. activity is never 'lift' here (a lift ride
-- always earns 0 points and has no leaderboard value).
CREATE TABLE IF NOT EXISTS player_day_activity_stats (
  player_id  TEXT NOT NULL REFERENCES player_account(id),
  app_id     TEXT NOT NULL,
  date       TEXT NOT NULL,
  season_id  TEXT NOT NULL,
  activity   TEXT NOT NULL,  -- 'ski' | 'hike' | 'bike' | 'drive'
  points     INTEGER NOT NULL DEFAULT 0,
  vertical_m REAL NOT NULL DEFAULT 0,
  distance_m REAL NOT NULL DEFAULT 0,
  runs_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, date, activity)
);

CREATE INDEX IF NOT EXISTS pdas_season ON player_day_activity_stats(player_id, season_id, date DESC);
CREATE INDEX IF NOT EXISTS pdas_leaderboard_daily ON player_day_activity_stats(app_id, date, activity, points DESC);
CREATE INDEX IF NOT EXISTS pdas_leaderboard_season ON player_day_activity_stats(app_id, season_id, activity, points DESC);
