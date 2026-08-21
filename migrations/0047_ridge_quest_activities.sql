-- Ridge Quest: per-project "which activities are relevant here" filter.
-- NULL means "show all activities" (backward compat — every existing
-- project keeps today's exact behavior until staff explicitly curates it).
-- Stored as a JSON array of activity strings (e.g. '["hike","xcski"]'),
-- validated at the API layer against QUEST_LEADERBOARD_ACTIVITIES, not
-- enforced by the column type (TEXT, same convention as other JSON-blob
-- columns in this schema).
ALTER TABLE project ADD COLUMN quest_activities TEXT;
