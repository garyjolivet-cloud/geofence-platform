-- Corridor authoring split (2026-09): a run's difficulty / run type / activity
-- move OUT of the Fence Editor's per-zone bundle fields and become first-class
-- columns on the app-scoped `corridor` library row, authored solely in the GPX
-- Editor. The Fence Editor's corridor stop reads them back read-only and still
-- bakes them into the published bundle at publish time, so ridge-quest.html /
-- geofence-engine / geofence-sim / tile-fog are unchanged.
--
-- Defaults match makeZone()'s corridor defaults in frontend/fence-editor.html
-- (base.difficulty=null, base.runType="run", base.activityType="hike") so
-- existing rows and any caller that omits the fields land on the same values
-- the editor already assumes. SQLite: one column per ALTER TABLE ADD COLUMN;
-- a constant DEFAULT is legal alongside NOT NULL.
ALTER TABLE corridor ADD COLUMN difficulty    TEXT;
ALTER TABLE corridor ADD COLUMN run_type      TEXT NOT NULL DEFAULT 'run';
ALTER TABLE corridor ADD COLUMN activity_type TEXT NOT NULL DEFAULT 'hike';
