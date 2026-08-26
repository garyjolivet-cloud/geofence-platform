-- Artistic Fog-of-War Tiles, Phase D: tile_fog_cell is the reveal state,
-- generalizing Ridge Quest's player_fog_cell (migration 0040) off the
-- ski-only, login-gated player_account table onto the platform's generic
-- device table -- so reveal works for anonymous visitors on any project
-- type, not just Ridge Quest. State only ever upgrades (never downgrades),
-- enforced by the upsert's MAX(state, excluded.state) rather than a plain
-- overwrite, same rule Ridge Quest's fog already uses. Absence of a row for
-- a cell means "never revealed" -- no row is ever written for that.
CREATE TABLE IF NOT EXISTS tile_fog_cell (
  device_id  TEXT NOT NULL REFERENCES device(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  h3_cell    TEXT NOT NULL,
  state      INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_id, project_id, h3_cell)
);
