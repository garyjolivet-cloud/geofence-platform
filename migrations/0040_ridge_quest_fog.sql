-- Ridge Quest (R2): player_fog_cell — one row per (player, H3 res-10 cell)
-- ever revealed. `state` follows the RTS three-state fog model (see
-- decision-ridge-quest-fog-of-war-game memory / the plan file's design
-- section): 1="Fog" (seen from a viewpoint, R4 — not written yet), 2=
-- "Visible" (actually skied, R2 — the only state this phase ever writes).
-- Absence of a row for a cell means Shroud (never seen) — no row is ever
-- written for that. State only ever upgrades (never downgrades), enforced
-- by the upsert's MAX(state, excluded.state) rather than a plain overwrite.
CREATE TABLE IF NOT EXISTS player_fog_cell (
  player_id  TEXT NOT NULL REFERENCES player_account(id),
  h3_cell    TEXT NOT NULL,
  state      INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id, h3_cell)
);
