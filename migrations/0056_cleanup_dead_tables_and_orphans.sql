-- Housekeeping: drop pre-2026 schema tables that nothing reads any more, and
-- delete rows orphaned by parent deletes. Verified before writing this:
--   * all 8 dropped tables are empty and have zero references in worker.js
--     and zero FK dependents (SELECT ... FROM sqlite_master WHERE sql LIKE
--     '%REFERENCES <t>%' returned nothing).
--   * the relational zone/layer/content/trigger_rule/asset model was
--     replaced by the published_bundle JSON blob; app_user by user_account;
--     track by position_history/record_session; d1_migrations is unused
--     because this repo applies migrations via `wrangler d1 execute --file`,
--     never `wrangler d1 migrations apply`.
DROP TABLE IF EXISTS trigger_rule;   -- FK'd layer/content, both also dropped here
DROP TABLE IF EXISTS layer;          -- FK'd zone
DROP TABLE IF EXISTS asset;          -- FK'd content
DROP TABLE IF EXISTS content;
DROP TABLE IF EXISTS zone;
DROP TABLE IF EXISTS track;
DROP TABLE IF EXISTS app_user;
DROP TABLE IF EXISTS d1_migrations;

-- Orphaned rows. deleteProjectRows() never cleaned the AR asset tree
-- (asset_object / asset_folder), so every asset_object here belongs to a
-- project that no longer exists (jolivet-walk / new-tour / scally-mag /
-- tour-mt4mzm95qvfd). The worker fix that adds these two tables to
-- deleteProjectRows() ships separately; this clears the existing backlog.
DELETE FROM asset_object
  WHERE scope = 'project' AND scope_id NOT IN (SELECT id FROM project);
DELETE FROM asset_folder
  WHERE scope = 'project' AND scope_id NOT IN (SELECT id FROM project);

-- Expired staff sessions never get swept (logout deletes by token_hash;
-- expired-but-not-logged-out rows just pile up). Keep only the still-valid.
DELETE FROM user_session WHERE expires_at < strftime('%s','now') * 1000;

-- consent rows for players that have since been deleted (right-to-delete
-- removed the player_account but these predate that batch covering consent).
DELETE FROM consent
  WHERE playerId IS NOT NULL AND playerId NOT IN (SELECT id FROM player_account);
