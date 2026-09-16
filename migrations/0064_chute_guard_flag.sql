-- Chute Guard — an eighth app-level feature flag, same shape/category as
-- hazard_aware_enabled: a live ski-safety toggle, baked into a project's
-- published bundle at Publish time (not read-time-injected — that pattern
-- exists only for tile_art_enabled/three_d_enabled, which needed to reach
-- Ridge Quest's "My map" without a republish). Warns a skier who drifts
-- outside a chute's authored width while actively skiing it.
-- Plain ADD COLUMN with DEFAULT — app has no inbound FK issue here, safe.
ALTER TABLE app ADD COLUMN chute_guard_enabled INTEGER NOT NULL DEFAULT 0;
