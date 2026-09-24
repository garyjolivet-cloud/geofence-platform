-- Ridge Quest narration gate — per-project setting in the Fence Editor's
-- ⚙ project settings. 1 (the default, including every existing project) =
-- a corridor's TTS narration only plays when Corridor Guard is on for that
-- corridor for this rider (master ON and not muted, or master OFF and armed).
-- 0 = narrate every corridor, the behaviour before this setting existed.
-- Read-time injected into the bundle (bundle.narrateGuardedOnly), same live
-- pattern as project.season, so a change applies without a republish.
ALTER TABLE project ADD COLUMN narrate_guarded_only INTEGER NOT NULL DEFAULT 1;
