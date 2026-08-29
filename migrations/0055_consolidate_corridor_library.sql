-- Consolidate the "Path" / "Walking Path" / "Corridor" trio in the Fence
-- Editor down to one concept: a Corridor. The old separate `corridor` table
-- was already merged into `walking_path.width_m` (migration 0049); this
-- finishes the job by renaming `walking_path` -> `corridor` outright and
-- making `width_m` mandatory (every corridor has a width now; NULL used to
-- mean "a plain snap-guide path"). The "Path" zone shape type is retired in
-- the editor and its moving-audio behavior becomes a toggle on a corridor.
--
-- All pre-existing walking_path/corridor library data is disposable (user
-- confirmed) -- no rows are carried over. D1 refuses to DROP/RENAME a table
-- another table's FK still points at, and `walking_path.folder_id` ->
-- `walking_path_folder(id)` (and the same for the old `corridor` pair, in
-- case a partially-migrated env still has them from migration 0048), so
-- drop each child table before its folder table.
DROP TABLE IF EXISTS walking_path;
DROP TABLE IF EXISTS walking_path_folder;
DROP TABLE IF EXISTS corridor;
DROP TABLE IF EXISTS corridor_folder;

-- Create the folder table BEFORE `corridor` -- `corridor.folder_id` has a FK
-- into it.
CREATE TABLE IF NOT EXISTS corridor_folder (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL REFERENCES app(id),
  parent_id  TEXT REFERENCES corridor_folder(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS corridor_folder_app_idx ON corridor_folder(app_id, parent_id);

CREATE TABLE IF NOT EXISTS corridor (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL REFERENCES app(id),
  folder_id   TEXT REFERENCES corridor_folder(id),
  name        TEXT NOT NULL,
  points_json TEXT NOT NULL,              -- [[lon,lat,eleOrNull], ...] full-res, walked/drawn order
  width_m     REAL NOT NULL DEFAULT 10,   -- every corridor has a width now
  distance_m  REAL NOT NULL DEFAULT 0,
  elev_gain_m REAL NOT NULL DEFAULT 0,
  elev_loss_m REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS corridor_app_idx ON corridor(app_id);
