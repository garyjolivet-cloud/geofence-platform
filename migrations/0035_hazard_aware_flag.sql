-- Fourth app-level flag alongside three_d_enabled/terrain_altitude_enabled/
-- visitors_fly (Phase 5a, forward hazard raycasting, 2026-08-17). Gates the
-- proactive "walking toward a hazard" warning (checkHazardAhead() in
-- geofence-engine.html/geofence-sim.html/fence-editor.html's SimFencer) —
-- the safety feature for the cm-accurate/off-grid "hazard aware" tier.
-- DEFAULT 0 means no existing project's behavior changes until a workspace
-- owner explicitly opts in (and republishes — denormalized into the
-- published bundle at publish time, same pattern as its three siblings).
ALTER TABLE app ADD COLUMN hazard_aware_enabled INTEGER NOT NULL DEFAULT 0;
