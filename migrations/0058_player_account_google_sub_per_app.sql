-- Two fixes to Ridge Quest player accounts:
--
-- 1. google_sub uniqueness was GLOBAL (CREATE UNIQUE INDEX ... ON
--    player_account(google_sub)), but every lookup in the OAuth handler is
--    per-workspace (WHERE app_id=? AND google_sub=?), same as email login
--    and password reset. So a Google account that already has a player row
--    under workspace A can't sign in to workspace B's /quest at all — the
--    INSERT hits "UNIQUE constraint failed: player_account.google_sub".
--    Swap the index to (app_id, google_sub) so the constraint matches the
--    per-workspace model. NULL google_sub (email-only accounts) stays
--    unconstrained since SQLite treats each NULL as distinct.
DROP INDEX IF EXISTS player_account_google_sub;
CREATE UNIQUE INDEX player_account_google_sub ON player_account(app_id, google_sub);

-- 2. Orphan cleanup: the app-delete cascade never removed player_* rows, so
--    deleting a workspace (migration 0057) left its players behind — and a
--    stale google_sub then blocks that person signing up anywhere. Clear
--    every player whose workspace no longer exists, plus their child rows
--    (same table set as POST /api/players/:id/forget).
DELETE FROM player_session            WHERE player_id IN (SELECT id FROM player_account WHERE app_id NOT IN (SELECT id FROM app));
DELETE FROM quest_run                 WHERE player_id IN (SELECT id FROM player_account WHERE app_id NOT IN (SELECT id FROM app));
DELETE FROM player_fog_cell           WHERE player_id IN (SELECT id FROM player_account WHERE app_id NOT IN (SELECT id FROM app));
DELETE FROM player_day_stats          WHERE player_id IN (SELECT id FROM player_account WHERE app_id NOT IN (SELECT id FROM app));
DELETE FROM player_day_activity_stats WHERE player_id IN (SELECT id FROM player_account WHERE app_id NOT IN (SELECT id FROM app));
DELETE FROM consent                   WHERE playerId  IN (SELECT id FROM player_account WHERE app_id NOT IN (SELECT id FROM app));
DELETE FROM player_account            WHERE app_id NOT IN (SELECT id FROM app);
