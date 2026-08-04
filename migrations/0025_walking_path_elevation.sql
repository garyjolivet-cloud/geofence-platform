-- Elevation gain/loss totals for a walking path, computed once at Field
-- Recorder save time from smoothed GPS altitude (see smoothElevation()/
-- elevGainLoss() in field-recorder.html) and stored alongside distance_m —
-- same "compute once, store the summary" convention already used for
-- distance_m rather than recomputing on every read. Per-point elevation
-- itself lives inside points_json as a 3rd array element ([lon,lat,elevM]),
-- no schema change needed there since it's a flexible JSON blob column.
ALTER TABLE walking_path ADD COLUMN elev_gain_m REAL NOT NULL DEFAULT 0;
ALTER TABLE walking_path ADD COLUMN elev_loss_m REAL NOT NULL DEFAULT 0;
