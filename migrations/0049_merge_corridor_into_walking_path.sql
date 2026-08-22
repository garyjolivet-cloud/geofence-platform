-- Unify the Corridor library into walking_path. A corridor was always
-- structurally "a path with a width" -- 0048's own comment already called
-- it "an exact structural mirror of walking_path" -- so collapsing the two
-- into one table + one nullable width_m column removes a duplicate
-- table/API/tree-UI surface with no loss of capability. NULL width_m means
-- a plain path (used as a snap-guide for stops); a real width_m means it's
-- used as a buffered corridor trigger-zone import instead.
ALTER TABLE walking_path ADD COLUMN width_m REAL;

-- Carry over any existing corridor rows, preserving id/folder_id so nothing
-- referencing a corridor by id breaks. folder_id pointed at corridor_folder
-- before; walking_path_folder gets identical rows copied in first (same
-- ids), so the reference still resolves after the copy. elev_gain_m/
-- elev_loss_m aren't selected -- corridor never tracked them, so those
-- columns fall back to their existing NOT NULL DEFAULT 0.
INSERT INTO walking_path_folder (id, app_id, parent_id, name, created_at, updated_at)
  SELECT id, app_id, parent_id, name, created_at, updated_at FROM corridor_folder;

INSERT INTO walking_path (id, app_id, folder_id, name, points_json, width_m, distance_m, created_at, updated_at)
  SELECT id, app_id, folder_id, name, points_json, width_m, distance_m, created_at, updated_at FROM corridor;

-- corridor has a FK into corridor_folder, so it must be dropped first --
-- D1 refuses to drop/rename a table another table's FK still points at.
DROP TABLE corridor;
DROP TABLE corridor_folder;
