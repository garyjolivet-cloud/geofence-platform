-- Ridge Quest splash flyby: admin-authored camera keyframes, captured via
-- the Fence Editor's "Splash Flyby" tool (a live 3D map — click "Add
-- keyframe" to record the current camera position/zoom/pitch/bearing).
-- NULL means "no custom flight authored yet" — ridge-quest.html falls
-- back to its own hardcoded default flight in that case. Stored as a
-- JSON array of {lon,lat,zoom,pitch,bearing,ms} points (ms = flight
-- duration from the previous point to this one; ignored on the first
-- point), same TEXT-blob convention as quest_activities/terrain_biome.
ALTER TABLE project ADD COLUMN splash_keyframes TEXT;
