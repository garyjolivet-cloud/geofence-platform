-- Artistic Fog-of-War Tiles, Phase C: per-app toggle, same pattern as
-- fog_enabled (0043) and quest_enabled (0045) -- decoupled from those two,
-- since this feature is platform-wide (any project type), not Ridge
-- Quest/ski-only.
ALTER TABLE app ADD COLUMN tile_art_enabled INTEGER NOT NULL DEFAULT 0;
