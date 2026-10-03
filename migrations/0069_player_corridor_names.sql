-- Ridge Quest: a rider's own names for chutes / runs / boot packs / lifts (2026-10-03).
-- Shown only to that rider, on their own screens and in the voice. NEVER used for the
-- leaderboard, the runs sent to the server (quest_run.run_name keeps the resort's name) or the
-- social media image (user: "I can't have poor names under the name Kicking Horse").
-- Saved on the account so it lasts the season and follows the rider to another phone.
-- player_id is an FK to player_account, so "forget my data" and workspace delete must remove
-- these rows first (worker.js does).
CREATE TABLE IF NOT EXISTS player_corridor_name (
  player_id   TEXT NOT NULL REFERENCES player_account(id),
  zone_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (player_id, zone_id)
);
