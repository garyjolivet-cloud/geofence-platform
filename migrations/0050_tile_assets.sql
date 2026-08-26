-- Artistic Fog-of-War Tiles, Phase A: tile_asset is the shared, platform-
-- global library of curated board-game-style tile art (one row per PNG),
-- keyed by terrain_type + variant_index so the classifier (Phase B) and the
-- engine's tile renderer (Phase D) can look up "give me forest, variant 2"
-- without caring which project it's for -- the art itself is never
-- per-project or per-org, only its assignment to a given project's cells is.
CREATE TABLE IF NOT EXISTS tile_asset (
  id            TEXT PRIMARY KEY,
  terrain_type  TEXT NOT NULL,   -- e.g. 'forest', 'rock_face', 'water_lake', 'landmark_bridge', 'fog'
  variant_index INTEGER NOT NULL DEFAULT 0,
  r2_key        TEXT NOT NULL,   -- geofence-tiles bucket, 'tile/<uuid>.png'
  style         TEXT NOT NULL DEFAULT '',  -- free-text style/prompt label, e.g. 'wpa-poster-v1'
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tile_asset_type ON tile_asset(terrain_type);
