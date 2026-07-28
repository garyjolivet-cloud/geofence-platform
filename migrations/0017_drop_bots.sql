-- Drop the bot table. The AI-chat bot system (region/visitor/guidance
-- personas, /api/bots, /api/chat) has been replaced by the drag-and-drop
-- pipeline system (zone.pipeline JSON inside published_bundle). Guidance
-- Bot itself (guidance-bot.js) is unaffected — it now runs off the
-- action.guide_to_zone pipeline block instead of a bot-table row.
DROP TABLE IF EXISTS bot;
