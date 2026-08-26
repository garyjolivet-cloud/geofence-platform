-- Artistic Fog-of-War Tiles, Phase B: terrain_cell is the per-project result
-- of the OSM/elevation classifier -- one row per H3 res-10 cell inside a
-- project's corridor buffers, recording which tile_asset terrain_type (Phase
-- A's shared library) that cell should render as once revealed.
-- variant_index is a deterministic hash of h3_cell (not random) so
-- re-running the classifier after a corridor edit doesn't visually reshuffle
-- tiles a visitor has already walked past.
CREATE TABLE IF NOT EXISTS terrain_cell (
  project_id    TEXT    NOT NULL REFERENCES project(id),
  h3_cell       TEXT    NOT NULL,
  terrain_type  TEXT    NOT NULL,
  variant_index INTEGER NOT NULL DEFAULT 0,
  elevation_m   REAL,
  slope_deg     REAL,
  source        TEXT    NOT NULL DEFAULT 'auto',  -- 'osm' | 'elevation' | 'biome-fallback'
  classified_at TEXT    NOT NULL,
  PRIMARY KEY (project_id, h3_cell)
);

-- Single per-project fallback biome, used only when a cell has no OSM tag
-- match and the elevation/slope heuristic is inconclusive -- keeps
-- classification fully automatic while still giving it a sane default for
-- OSM-sparse backcountry. NULL means "use the generic default".
ALTER TABLE project ADD COLUMN terrain_biome TEXT;
