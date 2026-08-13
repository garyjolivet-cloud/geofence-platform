-- Denormalized zone count on `project`, kept in sync with every bundle
-- publish (both the create and update paths in PUT /api/projects/:id/bundle).
-- Needed so GET /api/projects can report whether a project has at least one
-- published stop without fetching each project's full bundle JSON — the
-- top-nav progressive-gating feature (Audio Studio/Chatterbox/Code
-- Library/Record stay locked until a stop exists) depends on this being
-- cheap to read in the project list.
ALTER TABLE project ADD COLUMN zoneCount INTEGER DEFAULT 0;
