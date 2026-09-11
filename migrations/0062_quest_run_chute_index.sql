-- Serves GET /api/players/:id/chutes/daily and /season ("Your Chutes"),
-- which filter quest_run on player_id + run_type='chute'. Previously only
-- quest_run_player_started (player_id, started_at DESC) existed, which
-- still works but scans every run type for that player.
CREATE INDEX IF NOT EXISTS quest_run_player_runtype ON quest_run(player_id, run_type, started_at DESC);
