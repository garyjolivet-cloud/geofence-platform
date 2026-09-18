-- Reverts 0065: the server-side field-debug log was replaced same-day by a
-- simpler local "Export log" download button (matching the pattern already
-- proven in fence-editor.html's Test Mode) — no backend/auth/connectivity
-- needed, so this table and its two endpoints were removed before ever
-- being used (0 rows written).
DROP TABLE IF EXISTS quest_debug_log;
