-- Tag live zones with the guide who created them for per-guide isolation
ALTER TABLE live_zone ADD COLUMN guide_id TEXT;
CREATE INDEX IF NOT EXISTS idx_lz_guide ON live_zone(guide_id);
