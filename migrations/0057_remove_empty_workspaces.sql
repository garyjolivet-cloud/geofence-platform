-- Remove three abandoned workspaces (user-confirmed) that have zero projects
-- and never got any real content. Verified before writing: no rows in
-- project / api_key / corridor / corridor_folder / chatterbox_voice /
-- code_object / code_object_folder / org_entitlement reference these app ids
-- or their org ids. The only attached data is the golden-nordic org's
-- library audio (6 clips + 2 folders), also removed here; its R2 objects
-- under library/golden-nordic/... are deleted out-of-band.
DELETE FROM audio_clip   WHERE scope = 'library' AND scope_id = 'golden-nordic';
DELETE FROM audio_folder WHERE scope = 'library' AND scope_id = 'golden-nordic';

DELETE FROM app WHERE id IN ('golden-nordic', 'schocker', '3d-jolivets');
