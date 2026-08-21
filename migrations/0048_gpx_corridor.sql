-- Corridor library: app-scoped run/chute/trail definitions, saved from the
-- GPX Editor. Exact structural mirror of walking_path/walking_path_folder
-- (0023-0025) so the same tree UI, CRUD pattern, and points_json shape
-- ([lon,lat,eleOrNull], full resolution, unsampled) can be reused.
--
-- This is a *library* entity (editable, re-openable) — distinct from the
-- inline zone shape {type:"corridor", coords, widthM} that
-- importCorridorFromGPX() already writes directly into a project's
-- published_bundle.json. Wiring this library into that zone-creation flow
-- (i.e. attaching a saved corridor to a project) is a deliberate future
-- follow-up, out of scope here.
--
-- Unlike walking_path (which added folder_id in a later migration, 0024),
-- both tables get folder_id from the start — there's no legacy corridor
-- data to backfill.
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
  points_json TEXT NOT NULL,  -- [[lon,lat,eleOrNull], ...] full resolution, GPX Editor order
  width_m     REAL NOT NULL DEFAULT 10,
  distance_m  REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS corridor_app_idx ON corridor(app_id);
