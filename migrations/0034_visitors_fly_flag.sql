-- Third app-level 3D-mode flag, separate from three_d_enabled and
-- terrain_altitude_enabled (item A, paraglider/drone stops, 2026-08-14).
-- applyTerrainAltFallback() (geofence-engine.html) overrides a visitor's
-- altitude with ground elevation at their horizontal position whenever
-- terrain_altitude_enabled is on — correct for a walking-tour visitor,
-- silently wrong for anyone flying above the ground. DEFAULT 0 means no
-- existing project's behavior changes until a workspace owner explicitly
-- opts in (and republishes — this is denormalized into the published
-- bundle at publish time, same pattern as its two siblings).
ALTER TABLE app ADD COLUMN visitors_fly INTEGER NOT NULL DEFAULT 0;
