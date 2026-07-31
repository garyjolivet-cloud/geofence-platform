# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Geofence Platform

Cloudflare Workers app: static HTML tools + a D1-backed REST API + R2 audio storage. Zone behavior (speak/guide/webhook) is authored as a drag-and-drop pipeline and executed locally on the visitor's device.

## File Layout

```
geofence-platform/
├── backend/
│   └── worker.js            ← Cloudflare Worker: all /api/* routes + asset fallthrough + cron
├── frontend/
│   ├── index.html           ← Homepage — lists projects, links to tools
│   ├── dashboard.html       ← Admin dashboard (API key management, audit log)
│   ├── fence-editor.html    ← Geofence zone editor (publishes bundles to D1; auto-saves draft to localStorage; full map-interactive handles)
│   ├── geofence-engine.html ← Tour player / engine (loads published bundles; Kokoro TTS)
│   ├── guidance-bot.js      ← Guidance bot module (window.GuidanceBot)
│   ├── geofence-sim.html    ← Geofence simulator (tests zones without live GPS)
│   ├── audio-bench.html     ← Audio upload/playback sandbox (local-only, never touches R2)
│   ├── library.html         ← Shared audio Library (/library route) — full folder tree, trim, move, copy, combine/blend
│   ├── audio-studio.html    ← Multi-track audio editor (/studio route) — timeline, fades, spatial filter, drafts persist per-project in localStorage
│   ├── audio-tree.js        ← Shared folder/clip tree browser (window.AudioTree), used by audio-studio.html, fence-editor.html's Audio Palette, and library.html
│   ├── chatterbox-studio.html ← AI voice-cloning script editor (/chatterbox route) — org-scoped voices via /api/chatterbox/*, generation via Resemble AI
│   ├── pipeline-editor.html ← Drag-and-drop pipeline canvas (/pipeline route) — per-zone node/edge editor, opened from the Fence Editor
│   ├── pipeline-runtime.js  ← Shared block registry + local DAG execution engine (window.PipelineRuntime), loaded by geofence-engine.html and fence-editor.html
│   ├── share.html           ← Shareable project link page
│   └── sw.js                ← Service worker (network-first offline, cache-first for audio)
├── connect-iq/
│   ├── manifest.xml         ← CIQ app manifest (targets Instinct 2/2S/2X/Crossover)
│   └── source/
│       ├── GpsBridgeApp.mc
│       ├── GpsBridgeView.mc
│       ├── GpsBleDelegate.mc
│       └── GpsBridgeInputDelegate.mc
├── migrations/
│   ├── 0001_schema.sql      ← Core schema (7 tables: app, project, published_bundle, api_key, audit_log, device, consent, event)
│   ├── 0002_weather.sql     ← Weather tables (weather_cache, snow_history)
│   ├── 0003_bots.sql        ← Bot table (dropped by 0017 — see below)
│   └── 0017_drop_bots.sql   ← Drops the bot table; AI-chat bots replaced by the pipeline system
└── wrangler.jsonc           ← Wrangler config (D1 + R2 + AI bindings, assets: "./frontend", cron triggers)
```

## Development Commands

Run from the **project root** (not from backend/ or frontend/).

```bash
# Start the local Worker dev server (serves HTML + /api/* together)
npx wrangler dev

# Apply all migrations to local D1 (first-time setup) — run every file in
# migrations/ in numeric order; the excerpt below shows the pattern, not
# every file (0003 creates the bot table, 0017 drops it — apply both, in
# order, for the same net result as a fresh install)
npx wrangler d1 execute geofence-db --local --file=migrations/0001_schema.sql
npx wrangler d1 execute geofence-db --local --file=migrations/0002_weather.sql
# ... apply every migrations/000N_*.sql file in order ...
npx wrangler d1 execute geofence-db --local --file=migrations/0017_drop_bots.sql

# Apply migrations to remote D1 (same pattern, --remote)
npx wrangler d1 execute geofence-db --remote --file=migrations/0001_schema.sql

# Deploy to Cloudflare
npx wrangler deploy
```

After starting `npx wrangler dev`, open http://127.0.0.1:8787 in a browser. Keep the wrangler terminal running — it must stay alive to serve the site. Use a second terminal for all other commands.

## Local Development Setup

Create a `.dev.vars` file at the project root (gitignored) to set secrets for `npx wrangler dev`:

```ini
ADMIN_TOKEN=your-secret-token-here
RESEMBLE_API_TOKEN=your-resemble-token-here
# ALLOWED_ORIGIN not needed locally (defaults to *, all origins allowed)
# ORG_ID=chase-life
```

This file is never committed. In production, secrets are set via `npx wrangler secret put <NAME>`.

## Architecture

- **Worker** (`worker.js`): handles `/api/*` routes, falls through to `env.ASSETS` for everything else. Also has a `scheduled()` handler for cron jobs.
- **Friendly URLs**: the Worker maps `/editor` → `fence-editor.html`, `/sim` → `geofence-sim.html`, `/engine` → `geofence-engine.html`, `/dashboard` → `dashboard.html`, `/share` → `share.html`, `/audio` → `audio-bench.html`, `/library` → `library.html`, `/pipeline` → `pipeline-editor.html`.
- **D1** (`geofence-db`, binding `DB`): stores projects, published bundles, API keys, devices, consent records, events, weather cache, snow history.
- **R2** (`geofence-audio`, binding `AUDIO`): stores audio clips, served via `/api/audio/<key>`. See **Audio Storage** below for the key scheme.
- **AI** (binding `AI`): Cloudflare Workers AI — used for Whisper STT (`/api/transcribe`) and TTS (`/api/tts`).
- **Auth**: master token via `ADMIN_TOKEN` secret. Scoped per-app API keys stored as SHA-256 hashes in D1.
- **Cron**: `"0 * * * *"` (hourly) scrapes Kicking Horse weather into `weather_cache`; `"0 15 * * *"` (8am MST) saves daily snow snapshot to `snow_history`.

## D1 Schema

| Table | Purpose |
|-------|---------|
| `app` | Workspace — groups projects under a tenant |
| `project` | Named geofence tour/experience |
| `published_bundle` | Versioned JSON snapshots published by the editor |
| `api_key` | Scoped bearer tokens (stored as SHA-256 hashes) |
| `audit_log` | Immutable append-only record of admin actions |
| `device` | Anonymous visitor registration |
| `consent` | Append-only record of user consent decisions per scope |
| `event` | Analytics events, gated by `store-history` consent |
| `weather_cache` | Rolling hourly weather readings from Kicking Horse Resort (last 48) |
| `snow_history` | Daily 8am MST snow snapshots (last 14 days) |
| `chatterbox_voice` | Org-scoped Chatterbox Studio voice palette (name + Resemble AI voice UUID) |
| `audio_folder` | Real nested folder tree for audio clips (`scope`/`scope_id`/`parent_id`/`name`) — see **Audio Storage** below |
| `audio_clip` | Audio clip metadata + stable R2 key (`scope`/`scope_id`/`folder_id`/`name`/`r2_key`) — see **Audio Storage** below |
| `studio_session` | Saved Audio Studio timeline arrangements, living in the same `audio_folder` tree as clips (`folder_id`, `name`, `timeline_json`) — see **Audio Storage** below |

## Audio Storage

Audio clips are organized as a **real nested folder tree**, stored in D1 (`audio_folder` + `audio_clip`, `migrations/0019_audio_tree.sql`), fully decoupled from R2 key layout — an R2 key is a **permanent, opaque id** once assigned (`clip/<uuid>.<ext>` for anything uploaded/copied since this migration; legacy pre-migration objects keep whatever path-shaped key they already had, forever). Renaming or moving a folder or clip is purely a D1 metadata update — it never rewrites, copies, or touches the underlying R2 object, regardless of how many clips live in a subtree.

Two scopes, both fully nestable (arbitrary depth):

- **`scope='project'`, `scope_id=<projectId>`**: a project's own clips — recorded/uploaded via `fence-editor.html`'s Audio Palette or Audio Studio. Only ever visible while inside that owning project.
- **`scope='library'`, `scope_id=<orgId>`**: one company's shared clips, reusable across every project/app belonging to that org (same `orgId`/client id used everywhere else — `project.orgId`, `app.orgId`, `user_account.org_id`). Two companies never see each other's library even though rows live in the same tables.

**`frontend/audio-tree.js`** (`window.AudioTree`) is the one shared tree-browser widget behind all three surfaces — no per-page reimplementation:
- **Audio Studio** (`/studio`) and the **Fence Editor's Audio Palette** both mount it in **project mode** (`GET /api/audio/tree?project=<id>[&org=<orgId>]`), which returns the project's own tree **plus** its org's Library tree pinned alongside it in the same widget — Library is just a folder node, not a separate tab/button. The Palette mounts it `readOnly:true` (drag-source only; all editing happens in Studio); Studio mounts it read-write. The optional `&org=` override lets the Fence Editor pick a Library via its own "Customer" dropdown even before the project has a persisted `orgId` (a project row doesn't exist in D1 until first Publish, but Record/Upload work before that).
- The standalone **`/library`** page mounts it in **library mode** (`GET /api/audio/tree?scope=library&org=<orgId>`) — no project tree, just that org's Library as the root.

**Folder/clip CRUD** (`backend/worker.js`), all authed the same way `/api/audio-list` used to be (`scopeOk`/`libraryScopeOk` against the row's own `scope`/`scope_id`, not a parsed key):
- `POST /api/audio-folder`, `PATCH`/`DELETE /api/audio-folder/:id`, `POST /api/audio-folder/:id/copy` — create/rename+reparent+move/cascade-delete/deep-copy, all any-scope-to-any-scope. A cross-scope folder `PATCH` (`rescopeFolderSubtree` in `worker.js`) bulk-updates every descendant folder's and clip's `scope`/`scope_id` in a couple of statements — no R2 rewrite, no per-row recursion — then reparents just the moved folder's own `parent_id`. Cycle-checking (`wouldCreateCycle`) only applies to same-scope reparents; a cross-scope move can't create one by construction, since the target parent (if any) already lives in a scope disjoint from the folder's own subtree before the move.
- `POST /api/audio-clip` (upload, replaces the old path-driven `PUT`), `PATCH`/`DELETE /api/audio-clip/:id`, `POST /api/audio-clip/:id/copy` — rename/move (including **cross-scope**, since a clip move is one row update)/delete/duplicate (always a true copy — separate R2 object + separate row, per explicit product decision: trimming or deleting one copy must never affect the other).
- `GET /api/audio/:key` (streaming) and the legacy `GET /api/audio-list`, `POST /api/audio/move`, `DELETE /api/audio/folder` are all unchanged and still work during rollout, but are superseded by the tree endpoints above — remove them once every surface is confirmed migrated.

**`POST /api/audio/migrate-legacy`** (master-token only, idempotent) backfills `audio_folder`/`audio_clip` rows from whatever R2 objects already exist, recording each object's **existing** key as-is (never rewritten) — root-level `audio_clip` rows for every project's `<projectId>/` prefix, and one `audio_folder` + `audio_clip` rows for each company's flat `library/<orgId>/[<folder>/]` layout. Safe to re-run (skips any `r2_key` already present) — needed again any time a surface still writing through the legacy `PUT /api/audio/:key` path (e.g. Field Recorder, intentionally untouched by this migration) produces new objects that haven't been backfilled yet.

**Combine** (Audio Studio, and standalone `/library`) lets you select 2+ clips and blend them: a Main sequence (played back to back) plus an optional Background lane (looped/blended underneath at its own volume) get rendered client-side through the same `OfflineAudioContext` → lamejs MP3 pipeline the single-clip Trim tool already uses (`_reenc`/`_reencBlend`), then uploaded as a new clip via `POST /api/audio-clip`. **Trim** on an already-uploaded clip uploads the trimmed bytes as a new clip in the same folder, then deletes the original — there's no "overwrite this key in place" shortcut once keys are opaque/stable.

**Studio sessions** (`studio_session` table, `migrations/0020_studio_sessions.sql`) let a saved Audio Studio timeline be reopened and kept working on later — `frontend/audio-studio.html`'s Save/Save As/Open, `frontend/audio-tree.js`'s `renderSessionRow`/session menu. A session stores which clips are arranged and how (trim points, fades, gain, spatial filter per segment, referencing each clip by its permanent R2 URL) — never audio itself — using the exact same shape as the pre-existing per-project localStorage timeline draft (`serializeTimeline()`/`applyTimelineData()` in `audio-studio.html`, factored out of `persistTimelineDraft()`/`restoreTimelineDraft()` when sessions were added). Sessions live in the same `audio_folder` tree as clips (always `scope='project'` — there's no Library session), so a play's Act/Scene structure is just regular folders with each scene's mix saved as a session inside its own scene folder, right alongside the clips it uses. CRUD: `POST /api/studio-session`, `GET/PATCH/DELETE /api/studio-session/:id`, `POST /api/studio-session/:id/copy` — same auth pattern as clips/folders (`audioScopeAuthOk`).

## Pipeline System (replaced the AI-chat bot system, 2026-07-27)

Zone behavior (what happens on enter/exit/dwell) is authored as a visual drag-and-drop node graph and executed **locally on the visitor's device**, tick-by-tick, alongside the GPS/geofence engine — no server round-trip to decide what fires.

- **`frontend/pipeline-editor.html`** (`/pipeline` route): the canvas. Opened via `?project=<id>&zone=<zoneId>` from the "Edit Pipeline" button in the Fence Editor's per-zone Advanced panel. Hand-rolled vanilla JS/SVG (no framework) — palette of draggable block cards, node drag, port-to-port edge connect, a property panel for the selected node's params. Reads/writes the zone's `pipeline` field via the existing `GET/PUT /api/projects/:id/bundle` — no dedicated pipeline endpoint.
- **`frontend/pipeline-runtime.js`** (`window.PipelineRuntime`): shared block registry (`BLOCKS`) + the local DAG execution engine. Loaded by `geofence-engine.html` (production) and `fence-editor.html` (its built-in test simulator). API mirrors `guidance-bot.js`'s lifecycle: `load(zone, callbacks)` / `tick(zoneId, fix, smoothedPos, {entered,exited,dwellSeconds})` / `unload(zoneId)`. Side effects only via injected callbacks (`sayFn`, `guideStartFn`, `webhookFn`) — never touches DOM/audio directly.
- **Schema**: `zone.pipeline = { v:1, nodes:[{id,type,x,y,params}], edges:[{id,from:{n,p},to:{n,p}}] }`, stored inside the zone object in `published_bundle` — same place `zone.bots` used to live. No new top-level bundle key, no schema migration for `published_bundle` itself (already a JSON blob column).
- **v1 blocks**: `trigger.zone_enter`/`trigger.zone_exit`/`trigger.dwell`, `data.weather`/`data.snow_history`/`data.position`/`data.dwell_time`, `logic.compare`/`logic.and`/`logic.or`, `action.speak`/`action.guide_to_zone`/`action.webhook`. `action.guide_to_zone` is the direct replacement for the old bot-based guidance trigger — it calls the untouched `GuidanceBot.start()`.
- **Offline behavior**: pipeline JSON is already local once a bundle is fetched (same as zones/audio, cached via `sw.js`). `data.weather`/`data.snow_history` fetch on load then refresh on a 5-minute interval, not per GPS tick; a stale/missing fetch just leaves those output ports `null`, and `logic.compare` treats `null` as "not met" — so a weather-gated branch silently doesn't fire offline while everything else keeps working.
- **Not in scope**: device-sensor blocks (accelerometer/barometer) — nothing in this codebase reads either sensor today, only `geolocation.watchPosition`'s lat/lon/speed/heading/accuracy.

## Guidance Bot (`frontend/guidance-bot.js`)

Standalone IIFE module exposing `window.GuidanceBot`. Phone-in-pocket precision positioning — all instructions relative (turn left/right, bear, slow down), no compass directions.

**Zone fields added for guidance:**

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `bearingDeg` | `number` | `90` | Direction visitor should face on arrival (0–359°); amber arrow always shown on map |
| `isHazard` | `boolean` | `false` | Marks zone as a routing obstacle (renders red on map) |

**Two phases:**
1. `navigate` — guides to within 8m of target zone center
2. `align` — tells visitor to face `bearingDeg` using GPS travel heading

**Direction instructions** use a state machine with 10° hysteresis: STRAIGHT / BEAR / TURN / AROUND. Heading source is GPS travel heading only (phone in pocket — device compass unreliable). Circular EMA (α=0.15) smooths heading.

**Hazard avoidance**: Turf.js (lazy CDN load) buffers hazard zones 15m, uses convex-hull tangent waypoints (proper geometric tangent — path to waypoint is guaranteed clear). Re-checks only when `_waypointQueue` is empty to avoid overwriting an in-progress bypass. Graceful degradation if offline.

**API:**
```js
GuidanceBot.start({ targetZone, allZones, sayFn, onComplete, onInstruction })
GuidanceBot.update(fix)  // { lat, lon, speed, headingTravel, acc, t }
GuidanceBot.stop()
GuidanceBot.active       // boolean
GuidanceBot.phase        // 'navigate' | 'align' | 'done' | null
GuidanceBot.targetBearing // current arrow bearing (toward waypoint in navigate, bearingDeg in align)
```

**TTS chain** (both engine and editor simulator): Kokoro neural (82M ONNX, browser-cached) → Workers AI speecht5_tts → browser speechSynthesis fallback.

**Fence editor map visuals:**
- Hazard zones render red (`#ff2f4e`) instead of coral
- Amber solid line + draggable tip handle shows `bearingDeg` from zone center (default 90°)
- Blue dotted ring shows `audioM` fade distance
- Orange dotted ring shows `broadcastRadiusM` (tracker circles only)
- Green arrow on sim avatar points toward current waypoint/target during guidance

## Geofence Trigger Engine — Position Smoothing (fixed 2026-07-23)

The enter/exit trigger state machine (`Geofencer` in `frontend/geofence-engine.html`, mirrored identically in `frontend/geofence-sim.html` and `frontend/fence-editor.html`'s `makeSimSmoother()`/`SIM_TUNING`) decides zone entry/exit from a **smoothed** GPS position (`Smoother`/`SimSmoother`), not the raw fix — raw GPS jitter would otherwise cause spurious enter/exit flicker.

That smoothing is **speed-adaptive**, not a fixed coefficient:

| Constant | Value | Meaning |
|---|---|---|
| `SMOOTH_TAU_MAX_S` | 2.3s | smoothing time constant at/below walking pace — matches the original field-validated (2026-06-23) walking behavior |
| `SMOOTH_TAU_MIN_S` | 0.6s | time constant at/above bike/ski pace — keeps lag well under `EXIT_BUFFER_M` |
| `SMOOTH_SPEED_LO_MPS` / `SMOOTH_SPEED_HI_MPS` | 2.0 / 8.0 | speed range the time constant interpolates across |
| `SPEED_TAU_S` | 2.3s | separate smoothing applied to the *speed estimate itself*, computed from raw (pre-smoothing) fix deltas so the estimate isn't lagged by the filter it drives |

**Why this exists**: a fixed-coefficient position filter lags a moving target by `speed × tau`. At walking speed that's a few meters — invisible next to the 20m `EXIT_BUFFER_M`. At bike/ski speed (7–15 m/s) a fixed `tau≈2.3s` produces 16–35m of lag, comparable to or larger than the exit buffer itself — zones stuck "in" past their real boundary, and new zone entries failing to confirm. If trigger behavior ever regresses again (stops staying "active" past their radius, or new stops failing to fire), check this first — and check **all three** copies of this logic, since they're a deliberate "verbatim mirror" (real extraction to a shared module is still pending, tracked as future work in `geofence-sim.html`'s own header comment) rather than one shared implementation.

## iOS Audio Playback — Two Distinct Restrictions

Two separate iOS Safari/WebKit rules block audio in different ways. Conflating them wastes a fix cycle — confirmed the hard way:

1. **Hardware ring/silent-switch mutes raw `AudioContext` output.** Affects `SpatialVoice`/`AmbientVoice` in `geofence-engine.html` (WebAudio-routed spoken/ambient audio). Fixed in `Audio.unlock()`: play a real, unmuted, looping, silent-WAV `<audio>` **element** once inside a genuine tap — this shifts the page's audio session category so `AudioContext` output is heard regardless of the switch.
2. **Plain `<audio>`-element playback requires a user gesture, per element.** A `new Audio(url)` created later from a non-gesture context (a `geolocation.watchPosition` callback, a timer) does **not** inherit permission just because a *different* element played successfully earlier — only that *same* element stays "activated." Affects `field-recorder.html`'s `playStopAudio()`/`checkProximityAudio()` (GPS-triggered proximity auto-play). Fixed by reusing **one** shared `<audio>` element for all playback (manual taps and auto-play alike) instead of instantiating a fresh one per call.

**Diagnostic tell**: if a manual tap-triggered play works but an automatic/programmatic one is silent, it's restriction 2 (gesture requirement) — restriction 1's fix (a separate silent loop) will not help. If everything *looks* like it's playing (event log shows success, gain computed correctly) but nothing is audible regardless of trigger source, ask about the hardware mute switch first (restriction 1).

## Fence Editor — Map-Interactive Handles

Every zone shows an amber bearing arrow at all times. When a zone is **selected** (click on map or in list), 6 draggable handles appear:

| Handle | Color | Position | Controls |
|--------|-------|----------|---------|
| Bearing tip | Amber | Arrow end | `bearingDeg` — swing in circle |
| Circle radius | Green | East | `shape.radiusM` — resize fill |
| Audio fade | Blue | South | `audioM` — resize dotted ring; also the real per-stop fade-in distance used by `SpatialVoice`/`AmbientVoice` for a recorded clip (fixed 2026-07-26 — previously exported but silently ignored once a stop had a clip) |
| Broadcast | Orange | West | `broadcastRadiusM` (tracker only) |
| Polygon vertex | White square | Each corner | `shape.coords[i]` |
| Tripline endpoint | Cyan | Each end | `shape.from` / `shape.to` |

`approachM` (the old "approach ring") still exists internally as the zone's broader trigger-detection radius, but is no longer user-adjustable — its only adjustable purpose was arming the compass-needle direction arrow, which was removed (2026-07-26) along with the whole device-compass subsystem. Spatial audio panning still works, now sourced from GPS travel heading (`TravelHeading` in `geofence-engine.html`, same technique as Guidance Bot's heading) instead of the device magnetometer.

Each handle shows a floating label on hover that updates live while dragging (e.g. `approach: 45 m`).

**Zone body interaction:** Click any zone to select + fly to it. Drag any zone body to move the entire zone. Click empty map to deselect.

**Global settings** (Project Settings section): three dot-badge buttons (voice range, full vol, visitor). Click a dot → inline slider opens + ghost ring appears on map centered on all zones. Click again to close.

**Panel minimize:** ◀ button collapses panel to 36px strip; ▶ expands.

**Map Key:** ⬤ Key button (top-right, below base selector) opens modal legend describing all handles.

**Geometry helpers in fence-editor.html:**
- `destPoint(center, distM, bearing)` → `[lon, lat]` — destination point at distance/bearing
- `bearingTo(a, b)` → 0–360° — compass bearing between two `[lon, lat]` points
- `haversineM(a, b)` → metres — distance between two `[lon, lat]` points (existing)

## Key API Endpoints

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/health` | public |
| GET/POST | `/api/projects` | GET public, POST master |
| GET/PUT | `/api/projects/:id/bundle` | GET public, PUT scoped (`publish`) |
| PUT | `/api/projects/:id/app` | master |
| GET/POST | `/api/apps` | GET public, POST master |
| DELETE | `/api/apps/:id` | master (`?cascade=true` deletes all projects too) |
| GET/POST/DELETE | `/api/keys` | master |
| GET | `/api/audit` | master |
| GET | `/api/auth-check` | any valid token |
| POST | `/api/devices` | public |
| POST | `/api/devices/:id/forget` | public (right-to-delete) |
| GET/POST | `/api/consent` | public |
| POST | `/api/events` | public (requires stored `store-history` consent) |
| GET | `/api/analytics` | scoped (`analytics`) |
| GET | `/api/audio/tree` | requires `?project=[&org=]` or `?scope=library&org=`; scoped (`audio`/`publish`) + same-org; returns the D1-backed folder+clip tree |
| POST | `/api/audio-folder` | scoped (`audio` or `publish`) + same scope/org; create |
| PATCH/DELETE | `/api/audio-folder/:id` | scoped + same scope/org; rename/reparent (same-scope only) / cascade-delete |
| POST | `/api/audio-folder/:id/copy` | scoped on source + target; deep-copies a folder subtree, any scope → any scope |
| POST | `/api/audio-clip` | scoped (`audio` or `publish`) + same scope/org; upload, replaces path-driven `PUT /api/audio/:key` |
| PATCH/DELETE | `/api/audio-clip/:id` | scoped on source + target; rename/move (cross-scope allowed) / delete |
| POST | `/api/audio-clip/:id/copy` | scoped on source + target; true duplicate (new R2 object + row), any scope → any scope |
| POST | `/api/audio/migrate-legacy` | master; idempotent backfill of `audio_folder`/`audio_clip` from existing R2 objects |
| GET | `/api/audio-list` | deprecated, still works during rollout — requires `?project=`, `?scope=library&org=`, or `?scope=all`; scoped (`audio`/`publish`) + same-org, `?scope=all` is master-only |
| GET/PUT/DELETE | `/api/audio/:key` | GET public (streaming, unchanged), PUT/DELETE deprecated legacy path-driven upload/delete, scoped (`audio` or `publish`) + same-org for `library/` keys |
| POST | `/api/audio/move` | deprecated, still works during rollout — scoped (`audio` or `publish`); Library keys move within same org, project keys rename in place within same project |
| DELETE | `/api/audio/folder?org=&folder=` | deprecated, still works during rollout — scoped (`audio` or `publish`) + same-org; deletes every file under that flat Library folder |
| POST | `/api/transcribe` | public (Workers AI Whisper STT) |
| POST | `/api/tts` | public (Workers AI speecht5_tts → WAV) |
| GET | `/api/weather` | public (latest cached reading) |
| POST | `/api/weather` | master (manual scrape trigger) |
| GET | `/api/snow-history` | public (14-day daily snapshots) |
| POST | `/api/snow-history` | master (manual snapshot trigger) |
| GET/POST | `/api/chatterbox/voices` | GET/POST scoped like Library (`audio`/`publish`) + same-org, requires `?org=`/body `org` |
| PATCH/DELETE | `/api/chatterbox/voices/:id` | scoped like Library + same-org (org looked up from the voice row) |
| POST | `/api/chatterbox/generate` | scoped like Library + same-org; proxies Resemble AI (`RESEMBLE_API_TOKEN` secret), returns a WAV |
| DELETE | `/api/nuke` | master (wipes all rows, keeps schema) |

**Size guards:** bundles rejected over 1 MB; event payloads over 500 KB.

## Security Model

**Two token types:**

| Token | Where it lives | What it can do |
|-------|---------------|----------------|
| `ADMIN_TOKEN` | Wrangler secret (never in code) | Everything — master key |
| Scoped API key | D1 `api_key` table (hashed) | Only the scopes you grant: `publish`, `analytics`, `audio` |

**Rule: never use `ADMIN_TOKEN` in a browser.** Use a scoped API key there instead.

**Create a scoped key for browser use:**
```bash
curl -X POST https://geofence-platform.gary-jolivet.workers.dev/api/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"editor-browser","appId":"your-app-id","scopes":["publish"]}'
```

**CORS:** Write/admin endpoints are restricted to `ALLOWED_ORIGIN`. Public read endpoints allow `*`.

**Environment variables** (non-secret, set in `wrangler.jsonc`):
- `ORG_ID` — organisation slug (default: `chase-life`)
- `ALLOWED_ORIGIN` — browser origin allowed on write endpoints

## Bluetooth GPS (Garmin Instinct)

The geofence engine supports two BLE GPS protocols, auto-detected on connect:

| Protocol | BLE Service | Who uses it |
|----------|-------------|-------------|
| LNS | GATT `0x1819` | Dedicated BLE GPS receivers, some Garmin Edge units |
| NUS (UART) | `6e400001-...` | Garmin Instinct 2/Crossover/2X via Connect IQ app |

**Connect IQ companion app** (`connect-iq/`): a Widget that broadcasts GPS over NUS. Sends one line per second over TX characteristic (`6e400003-b5a3-f393-e0a9-e50e24dcca9e`).

Only works in Chrome or Edge (Web Bluetooth API).

## Guardrails

- **Never** hardcode or commit Cloudflare account IDs, API tokens, or `ADMIN_TOKEN`.
- Secrets go in `wrangler.jsonc` secret bindings or `.dev.vars` (gitignored) for local dev.
- The `database_id` in `wrangler.jsonc` is not a secret — committing it is fine.
