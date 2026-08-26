-- Artistic Fog-of-War Tiles: seasonal variants, added mid-build per direct
-- product feedback -- a ski resort's surrounding forest/meadow hexes should
-- render snow-dusted, not the green-summer look the first tile batch used,
-- and bike/hike ribbons need a distinct look from XC-ski/downhill ones.
--
-- Deliberately orthogonal to terrain_type/variant_index rather than baked
-- into the category name (e.g. NOT "forest_winter") -- the OSM/elevation
-- classifier (Phase B) assigns a bare terrain_type per cell with no concept
-- of season at all; season is resolved purely at tile-library LOAD time
-- (GET /api/tile-assets?season=) by picking which season's row backs a
-- given terrain_type. This means classify-terrain and tile-fog.js's
-- rendering/key logic need zero changes -- only the library filter does.
--
-- NULL season = season-neutral (rock_face/scree/urban_block/plaza/
-- landmarks/fog all look the same year-round, so they only ever have one
-- row with season NULL, always included regardless of the project's
-- season).
ALTER TABLE tile_asset ADD COLUMN season TEXT;

-- Single per-project season setting (a project is one season at a time --
-- realistically no tour mixes a summer bike corridor with a winter ski
-- corridor), same simple-per-project-setting pattern as terrain_biome.
ALTER TABLE project ADD COLUMN season TEXT;

-- Backfill the existing 55-tile batch: the 9 categories that meaningfully
-- change with season were generated in a green/summer palette -> tag them
-- 'summer' retroactively. 'snow' is inherently winter-only (a "summer snow"
-- tile is meaningless) -> tag it 'winter'. Everything else (rock_face,
-- scree, urban_block, plaza, fog, all 12 landmarks) stays NULL/season-
-- neutral, already correct as the default.
UPDATE tile_asset SET season='summer'
  WHERE terrain_type IN ('forest','scrub','meadow','farmland','water_lake','water_river','wetland','sand','trail');
UPDATE tile_asset SET season='winter' WHERE terrain_type='snow';
