-- One-time backfill for zoneCount (added in 0031 with DEFAULT 0). That
-- migration only keeps the column in sync going forward (PUT
-- .../bundle's create/update paths) — every project last published BEFORE
-- 0031 existed stayed stuck at the column's default regardless of its real
-- stop count. Confirmed live 2026-08-13: Macbeth (4 real zones, last
-- published 2026-07-31) still read zoneCount=0, which silently locked
-- Audio Studio/Chatterbox/Code Library/Record in the top-nav's progressive
-- gating even though the project has real stops. Recomputes zoneCount from
-- each project's own latest published_bundle row (matched on
-- project.bundleVersion) rather than trusting the stale column.
UPDATE project
SET zoneCount = (
  SELECT COALESCE(json_array_length(pb.json, '$.zones'), 0)
  FROM published_bundle pb
  WHERE pb.projectId = project.id AND pb.version = project.bundleVersion
)
WHERE id IN (SELECT DISTINCT projectId FROM published_bundle);
