-- Ridge Quest (R3-core): quest_run gets its own points/snow_bonus columns,
-- not just the player_day_stats rollup — a run row should be a complete
-- historical record of what it actually earned. Deliberately NOT derived
-- live from the current weight tables: if difficulty/runType/snow-bonus
-- weights get retuned later, past runs must keep the points they actually
-- earned at the time, not be silently recomputed under new weights.
ALTER TABLE quest_run ADD COLUMN points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quest_run ADD COLUMN snow_bonus REAL NOT NULL DEFAULT 1;
