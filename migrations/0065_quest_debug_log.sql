-- Temporary field-debugging log for Corridor Guard (and any future
-- Ridge Quest on-device diagnostic) — a player field-testing outdoors
-- (biking/skiing) has no way to watch an on-screen readout, so ridge-
-- quest.html batches chute-guard.js's onWarn/onClear/onDisengage/onDebug
-- events here instead, for review after the fact via GET /api/quest-debug-log
-- (master-token only). No raw lat/lon stored — payload carries only derived
-- geometry (coverage/distance/heading/speed/excess/level), not location.
CREATE TABLE quest_debug_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  corridor_id TEXT,
  corridor_name TEXT,
  event TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_quest_debug_log_player_ts ON quest_debug_log(player_id, ts);
CREATE INDEX idx_quest_debug_log_project_ts ON quest_debug_log(project_id, ts);
