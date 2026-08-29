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
│   ├── audio-studio.html    ← Multi-track audio editor (/studio route) — timeline, fades, spatial filter, drafts persist per-project in localStorage
│   ├── audio-tree.js        ← Shared folder/clip tree browser (window.AudioTree), used by audio-studio.html and fence-editor.html's Audio Palette
│   ├── chatterbox-studio.html ← AI voice-cloning script editor (/chatterbox route) — org-scoped voices via /api/chatterbox/*, generation via Resemble AI
│   ├── pipeline-editor.html ← Drag-and-drop pipeline canvas (/pipeline route) — per-zone node/edge editor, opened from the Fence Editor
│   ├── pipeline-runtime.js  ← Shared block registry + local DAG execution engine (window.PipelineRuntime), loaded by geofence-engine.html and fence-editor.html
│   ├── corridor-tree.js    ← Shared corridor folder/library tree (window.CorridorTree) over the app-scoped `corridor` table; mounted by gpx-editor.html and fence-editor.html's Corridors palette
│   ├── tile-fog.js          ← Artistic Fog-of-War Tiles shared module (window.TileFog) — H3 reveal state machine + MapLibre hex/corridor rendering, loaded by geofence-engine.html, geofence-sim.html, fence-editor.html's Test Mode, and map-paint.html (revealAll mode)
│   ├── map-paint.html       ← Map Paint (/paint route) — polygon-region select + tile-palette brush editor for a project's H3 fog-of-war terrain map (terrain_cell); auto-fill reuses the classify-terrain endpoint, hand-paints persist as source='manual'
│   ├── share.html           ← Shareable project link page
│   └── sw.js                ← Service worker (network-first offline, cache-first for audio)
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
- **Friendly URLs**: the Worker maps `/editor` → `fence-editor.html`, `/sim` → `geofence-sim.html`, `/engine` → `geofence-engine.html`, `/dashboard` → `dashboard.html`, `/share` → `share.html`, `/audio` → `audio-bench.html`, `/pipeline` → `pipeline-editor.html`, `/paint` → `map-paint.html`.
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
| `corridor` | App-scoped corridor library — a drawn/recorded GPS line (`points_json` `[[lon,lat,ele?],…]`, `width_m NOT NULL DEFAULT 10`, `distance_m`, `elev_gain_m`/`elev_loss_m`, `folder_id`). Consolidated from Path/Walking Path/Corridor (migration `0055`). See **Add-a-stop picker** / **Corridor** notes. |
| `corridor_folder` | App-scoped folder tree for `corridor` (`parent_id` self-FK) — same shape as `stop_folder`; folder delete moves corridors up to the parent, doesn't destroy them. |
| `audio_folder` | Real nested folder tree for audio clips (`scope`/`scope_id`/`parent_id`/`name`) — see **Audio Storage** below |
| `audio_clip` | Audio clip metadata + stable R2 key (`scope`/`scope_id`/`folder_id`/`name`/`r2_key`) — see **Audio Storage** below |
| `studio_session` | Saved Audio Studio timeline arrangements, living in the same `audio_folder` tree as clips (`folder_id`, `name`, `timeline_json`) — see **Audio Storage** below |
| `tile_asset` | Shared, platform-global library of curated board-game-style tile art (`terrain_type`, `variant_index`, `season`, `r2_key`) — see **Artistic Fog-of-War Tiles** below |
| `terrain_cell` | Per-project terrain assignment, one row per H3 cell (`project_id`, `h3_cell`, `terrain_type`, `variant_index`, `source`) — `source` is `osm`/`elevation`/`biome-fallback` from the classifier, or `manual` for a Map Paint hand-paint (which the classifier never overwrites or deletes) — see **Artistic Fog-of-War Tiles** below |
| `tile_fog_cell` | Per-device reveal state, one row per (device, project, H3 cell) ever revealed — see **Artistic Fog-of-War Tiles** below |

## Audio Storage

Audio clips are organized as a **real nested folder tree**, stored in D1 (`audio_folder` + `audio_clip`, `migrations/0019_audio_tree.sql`), fully decoupled from R2 key layout — an R2 key is a **permanent, opaque id** once assigned (`clip/<uuid>.<ext>` for anything uploaded/copied since this migration; legacy pre-migration objects keep whatever path-shaped key they already had, forever). Renaming or moving a folder or clip is purely a D1 metadata update — it never rewrites, copies, or touches the underlying R2 object, regardless of how many clips live in a subtree.

Two scopes, both fully nestable (arbitrary depth):

- **`scope='project'`, `scope_id=<projectId>`**: a project's own clips — recorded/uploaded via `fence-editor.html`'s Audio Palette or Audio Studio. Only ever visible while inside that owning project.
- **`scope='library'`, `scope_id=<orgId>`**: one company's shared clips, reusable across every project/app belonging to that org (same `orgId`/client id used everywhere else — `project.orgId`, `app.orgId`, `user_account.org_id`). Two companies never see each other's library even though rows live in the same tables.

**`frontend/audio-tree.js`** (`window.AudioTree`) is the one shared tree-browser widget behind both surfaces — no per-page reimplementation:
- **Audio Studio** (`/studio`) and the **Fence Editor's Audio Palette** both mount it in **project mode** (`GET /api/audio/tree?project=<id>[&org=<orgId>]`), which returns the project's own tree **plus** its org's Library tree pinned alongside it in the same widget — Library is just a folder node, not a separate tab/button. The Palette mounts it `readOnly:true` (drag-source only; all editing happens in Studio); Studio mounts it read-write. The optional `&org=` override lets the Fence Editor pick a Library via its own "Customer" dropdown even before the project has a persisted `orgId` (a project row doesn't exist in D1 until first Publish, but Record/Upload work before that).
- `AudioTree.mount()` also supports a **library mode** (`GET /api/audio/tree?scope=library&org=<orgId>`, no project tree, just that org's Library as the root) and the backend still serves it — it just has no live caller today. The standalone `/library` page that used to mount it this way was retired (no page ever linked to it after the persistent top-nav rollout, and its only real capability gap vs. Audio Studio — organizing a company's shared clips with no project open — was accepted as out of scope) rather than re-linking a barely-used surface.

**Folder/clip CRUD** (`backend/worker.js`), all authed the same way `/api/audio-list` used to be (`scopeOk`/`libraryScopeOk` against the row's own `scope`/`scope_id`, not a parsed key):
- `POST /api/audio-folder`, `PATCH`/`DELETE /api/audio-folder/:id`, `POST /api/audio-folder/:id/copy` — create/rename+reparent+move/cascade-delete/deep-copy, all any-scope-to-any-scope. A cross-scope folder `PATCH` (`rescopeFolderSubtree` in `worker.js`) bulk-updates every descendant folder's and clip's `scope`/`scope_id` in a couple of statements — no R2 rewrite, no per-row recursion — then reparents just the moved folder's own `parent_id`. Cycle-checking (`wouldCreateCycle`) only applies to same-scope reparents; a cross-scope move can't create one by construction, since the target parent (if any) already lives in a scope disjoint from the folder's own subtree before the move.
- `POST /api/audio-clip` (upload, replaces the old path-driven `PUT`), `PATCH`/`DELETE /api/audio-clip/:id`, `POST /api/audio-clip/:id/copy` — rename/move (including **cross-scope**, since a clip move is one row update)/delete/duplicate (always a true copy — separate R2 object + separate row, per explicit product decision: trimming or deleting one copy must never affect the other).
- `GET /api/audio/:key` (streaming) and the legacy `GET /api/audio-list`, `POST /api/audio/move`, `DELETE /api/audio/folder` are all unchanged and still work during rollout, but are superseded by the tree endpoints above — remove them once every surface is confirmed migrated.

**`POST /api/audio/migrate-legacy`** (master-token only, idempotent) backfills `audio_folder`/`audio_clip` rows from whatever R2 objects already exist, recording each object's **existing** key as-is (never rewritten) — root-level `audio_clip` rows for every project's `<projectId>/` prefix, and one `audio_folder` + `audio_clip` rows for each company's flat `library/<orgId>/[<folder>/]` layout. Safe to re-run (skips any `r2_key` already present) — needed again any time a surface still writing through the legacy `PUT /api/audio/:key` path (e.g. Field Recorder, intentionally untouched by this migration) produces new objects that haven't been backfilled yet.

**Combine** (Audio Studio) lets you select 2+ clips and blend them: a Main sequence (played back to back) plus an optional Background lane (looped/blended underneath at its own volume) get rendered client-side through the same `OfflineAudioContext` → lamejs MP3 pipeline the single-clip Trim tool already uses (`_reenc`/`_reencBlend`), then uploaded as a new clip via `POST /api/audio-clip`. **Trim** on an already-uploaded clip uploads the trimmed bytes as a new clip in the same folder, then deletes the original — there's no "overwrite this key in place" shortcut once keys are opaque/stable.

**Studio sessions** (`studio_session` table, `migrations/0020_studio_sessions.sql`) let a saved Audio Studio timeline be reopened and kept working on later — `frontend/audio-studio.html`'s Save/Save As/Open, `frontend/audio-tree.js`'s `renderSessionRow`/session menu. A session stores which clips are arranged and how (trim points, fades, gain, spatial filter per segment, referencing each clip by its permanent R2 URL) — never audio itself — using the exact same shape as the pre-existing per-project localStorage timeline draft (`serializeTimeline()`/`applyTimelineData()` in `audio-studio.html`, factored out of `persistTimelineDraft()`/`restoreTimelineDraft()` when sessions were added). Sessions live in the same `audio_folder` tree as clips (always `scope='project'` — there's no Library session), so a play's Act/Scene structure is just regular folders with each scene's mix saved as a session inside its own scene folder, right alongside the clips it uses. CRUD: `POST /api/studio-session`, `GET/PATCH/DELETE /api/studio-session/:id`, `POST /api/studio-session/:id/copy` — same auth pattern as clips/folders (`audioScopeAuthOk`).

## Pipeline System (replaced the AI-chat bot system, 2026-07-27)

Zone behavior (what happens on enter/exit/dwell) is authored as a visual drag-and-drop node graph and executed **locally on the visitor's device**, tick-by-tick, alongside the GPS/geofence engine — no server round-trip to decide what fires.

- **`frontend/pipeline-editor.html`** (`/pipeline` route): the canvas. Opened via `?project=<id>&zone=<zoneId>` from the "Edit Pipeline" button in the Fence Editor's per-zone Advanced panel. Hand-rolled vanilla JS/SVG (no framework) — palette of draggable block cards, node drag, port-to-port edge connect, a property panel for the selected node's params. Reads/writes the zone's `pipeline` field via the existing `GET/PUT /api/projects/:id/bundle` — no dedicated pipeline endpoint.
- **`frontend/pipeline-runtime.js`** (`window.PipelineRuntime`): shared block registry (`BLOCKS`) + the local DAG execution engine. Loaded by `geofence-engine.html` (production) and `fence-editor.html` (its built-in test simulator). API mirrors `guidance-bot.js`'s lifecycle: `load(zone, callbacks)` / `tick(zoneId, fix, smoothedPos, {entered,exited,dwellSeconds})` / `unload(zoneId)`. Side effects only via injected callbacks (`sayFn`, `guideStartFn`, `webhookFn`) — never touches DOM/audio directly.
- **Schema**: `zone.pipeline = { v:1, nodes:[{id,type,x,y,params}], edges:[{id,from:{n,p},to:{n,p}}] }`, stored inside the zone object in `published_bundle` — same place `zone.bots` used to live. No new top-level bundle key, no schema migration for `published_bundle` itself (already a JSON blob column).
- **v1 blocks**: `trigger.zone_enter`/`trigger.zone_exit`/`trigger.dwell`, `data.weather`/`data.snow_history`/`data.position`/`data.dwell_time`, `logic.compare`/`logic.and`/`logic.or`, `action.speak`/`action.guide_to_zone`/`action.webhook`. `action.guide_to_zone` is the direct replacement for the old bot-based guidance trigger — it calls the untouched `GuidanceBot.start()`.
- **Offline behavior**: pipeline JSON is already local once a bundle is fetched (same as zones/audio, cached via `sw.js`). `data.weather`/`data.snow_history` fetch on load then refresh on a 5-minute interval, not per GPS tick; a stale/missing fetch just leaves those output ports `null`, and `logic.compare` treats `null` as "not met" — so a weather-gated branch silently doesn't fire offline while everything else keeps working.
- **Not in scope**: device-sensor blocks (accelerometer/barometer) — nothing in this codebase reads either sensor today, only `geolocation.watchPosition`'s lat/lon/speed/heading/accuracy.

## Artistic Fog-of-War Tiles (in progress, started 2026-08-24)

Replaces the real satellite/topo/street basemap, inside a visitor's tour corridor only, with a finite set of hand-styled board-game tile art (Carcassonne/Catan-in-the-real-world) that gets progressively revealed as the visitor physically walks — everywhere outside a corridor's buffer still renders the ordinary basemap untouched. Generalizes `ridge-quest.html`'s existing H3-hex fog-of-war (reveal-on-tick, server-persisted, MapLibre shroud rendering) off its ski-only, `player_account`-gated form onto the platform's generic `device`/`project` tables, so it works for anonymous visitors on any project type (ski hill, bike trail, XC ski, walking tour, city walk) — not just Ridge Quest. Full design log lives in the build's plan file; this section is the durable reference.

- **Grid**: H3 hexagonal, resolution 10 (~66m edge) — same `FOG_RESOLUTION` Ridge Quest uses, via `h3-js@4` (npm dependency server-side in `worker.js`, matching CDN version `frontend/*.html` already load client-side — cell IDs must match exactly between the two).
- **Tile art**: AI-generated via the existing `/api/texture-gen` Flux route (`@cf/black-forest-labs/flux-1-schnell`), one locked style prompt template (flat WPA-poster-style gouache, top-down, seamless) — proven far more reliable (zero composition failures across 15 categories) than three alternate styles tried (antique engraving injected fake map-label text; a WPA+engraving blend broke tileability inconsistently; a vintage alpine-poster style kept reverting to horizon/sky vista compositions despite explicit exclusion). **Workers AI's free daily neuron quota (10,000/day) is shared across every model on the account** — hitting it blocks all image generation platform-wide, not just tile art, until the daily reset or a Workers Paid upgrade.
- **Terrain classification**: fully automatic per H3 cell — OpenStreetMap tags (one Overpass API query per `classify-terrain` call, never per-cell — fair-use policy) in priority order, then an elevation/slope heuristic (Terrarium DEM tiles, same source the 3D terrain feature already uses, fetched+decoded server-side via `fast-png`), then a per-project `terrain_biome` fallback default. **Overpass rejects requests with no `User-Agent` header (406)** — confirmed live this silently degraded every classification to elevation+biome-fallback only, since the caller treats a thrown fetch error as "offline" and moves on; fixed by always sending one.
- **Corridor ribbon graphics**: the corridor/path itself gets a continuous, activity-typed ribbon graphic on top of the hex terrain (not just generic "trail" hex fill) — `zone.activityType` (`hike`/`bike`/`xcountry`/`ski_chute`/`walking_city`) sets both a real-world width (2m/2m/5m/20m/3m) and a distinct texture (dirt+grass / dirt+grass / double-track+skate-lane / open powder / paved), rendered via MapLibre's `line-pattern` on the corridor's LineString. Real-world line width in MapLibre is always screen pixels, not meters — solved with an *exact* (not approximated) conversion: pixels-per-meter scales as precisely `2^zoom` in Web Mercator, so an `["interpolate", ["exponential", 2], ["zoom"], ...]` expression anchored at two zoom stops for a feature's own reference latitude reproduces the true meter width at every zoom.
- **Season**: modeled as a column orthogonal to `terrain_type`/`variant_index` (`tile_asset.season`, `project.season` — `'summer'`/`'winter'`/`null`), not baked into the category name — the classifier assigns a bare `terrain_type` with no concept of season at all; season is resolved purely at tile-library **load** time via `GET /api/tile-assets?season=`, which returns that season's rows plus every season-neutral one (`season IS NULL` — rock_face/scree/urban_block/plaza/landmarks/fog look the same year-round; `snow` is winter-only by nature). A project is one season at a time.
- **`frontend/tile-fog.js`** (`window.TileFog`): the one real shared module behind all three consumers (`geofence-engine.html`, `geofence-sim.html`, `fence-editor.html` Test Mode) — deliberately built as a genuine shared file from day one, not copy-pasted three times, specifically to avoid the "verbatim mirror" bug class documented below (Geofencer/`editorToSimBundle()`). `load({projectId,deviceId,season})` / `reveal(lat,lon,acc,accuracyCapM)` (mirrors Ridge Quest's `_revealFog` k=1-disk "torch radius" exactly) / `attachToMap(map)` / `renderCorridors(corridors)` / `isRevealed(h3Cell)`.
- **Bundle plumbing**: `bundle.tileArtEnabled` (from `app.tile_art_enabled`), `bundle.terrainBiome`, and `bundle.season` are injected into `GET /api/projects/:id/bundle` at read time — same live-owner-injection pattern as `bundle.orgId`/`bundle.questActivities` — none of the three are part of the published bundle JSON itself. **`BUNDLE.project` (or a loaded bundle's `.project` field) is never populated** — the project id is known from the route/URL, not embedded in the bundle JSON — confirmed live; pass the caller's own known project id into `TileFog.load()` explicitly, never `bundle.project`.
- **Reveal persistence**: `tile_fog_cell` (`device_id`, `project_id`, `h3_cell`, `state`) generalizes Ridge Quest's `player_fog_cell` onto the generic `device` table — anonymous, no bearer auth, `deviceId` in the request body (same convention as `POST /api/events`). State only ever upgrades (`MAX(state, excluded.state)` on upsert), never downgrades.
- **`frontend/map-paint.html`** (`/paint`, top-nav "Map Paint", admin-only): a paint editor over `terrain_cell`. Draw a polygon region → **Auto-fill** POSTs `{polygons:[ring]}` to the same `classify-terrain` route (extended to accept `polygons` alongside `corridors`; the polygon ring feeds `h3.polygonToCells(...,10,true)` directly, no buffering) → then brush/eraser/fill-region hand-painting from a tile-library palette (a client-side tree over `GET /api/tile-assets?season=`, grouped season → terrain family → variants — no new schema). Hand-paints persist via `POST /api/projects/:id/terrain-cells` (`{paint:[{h3Cell,terrainType,variantIndex}], erase:[...]}`, scoped `publish`) as `source='manual'`; the classifier's `manualCells` guard (`partitionManualCells`) and its `DELETE ... WHERE source<>'manual'` mean re-running Auto-fill never touches them. Hex rendering is `TileFog` in `revealAll:true` mode (`TileFog.setCells`/`redraw`); editor-only overlay layers (region polygon, brush hover, manual-cell outline) are added by the page after `attachToMap`. `?view=1` is a chrome-less read-only render + there's a canvas `toDataURL` PNG export (`preserveDrawingBuffer:true`). Pure helpers `partitionManualCells`/`normalizeTerrainPaint` are exported from `worker.js` for `tests/terrain-paint.test.js`.
- **Status**: feature complete. Backend (classifier, reveal/fog routes, tile library CRUD) fully built and tested against real OSM/elevation data across ski/alpine (Kicking Horse), city (central London), and mountain-bike-trail (Whistler Bike Park) locations, including a 56-cell multi-segment corridor stress test confirming the D1 batch-upsert logic. Permanent regression tests live in `tests/terrain-classifier.test.js` (OSM taxonomy priority order, elevation/slope thresholds, biome fallback, deterministic variant hashing) — `classifyFromOsm`/`classifyElevationSlope`/`TERRAIN_TAXONOMY`/etc. are exported as named exports from `worker.js` specifically to support this, same pattern `kalman-filter.js`'s `_internal` export already uses. Client-side data pipeline (load/reveal/persist) verified via a Node harness driving the real `tile-fog.js` module against the live server. Tile library is complete: **100 tiles** (14 hex categories — 9 with summer+winter pairs, 5 season-neutral — × 3 variants, 12 landmarks, 1 fog placeholder, 18 corridor ribbon textures across 5 activities/6 season combos), all generated and uploaded. **Visual rendering confirmed working** in a real browser (via user screenshots, since Claude-in-Chrome browser automation was unstable this session) — `fill-pattern` correctly renders visually distinct tile art per terrain type (forest hexes with tree icons, rock/scree hexes with rock texture, unrevealed cells showing the fog placeholder), and a real SIM walkthrough triggered live `ENTER`/`EXIT` corridor geofence events.
- **Bugs found and fixed during this build, worth knowing about if touching this area again**: (1) a hand-crafted test bundle had `ref`/zone `center` in `[lon,lat]` order instead of the engine's actual `[lat,lon]` convention, which parked the map at `[0,0]` and showed Esri's "no imagery data" placeholder tiles — confirmed by cross-checking a real published bundle's coordinate order; not a product bug. (2) `package.json` briefly had `"type": "module"` (added for `worker.js`'s `import * as h3 from "h3-js"` syntax) which silently broke all pre-existing CommonJS test files in `tests/` — turned out unnecessary, since Wrangler bundles the Worker via its own esbuild step independent of Node's `package.json` `"type"` field; removed, confirmed a fresh `wrangler dev` boot still resolves the import correctly.

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

## Geofence Trigger Engine — Position Smoothing (EKF since 2026-08-07)

The enter/exit trigger state machine (`Geofencer` in `frontend/geofence-engine.html`, mirrored identically in `frontend/geofence-sim.html` and `frontend/fence-editor.html`'s Test Mode) decides zone entry/exit from a **smoothed** GPS position, not the raw fix — raw GPS jitter would otherwise cause spurious enter/exit flicker.

Smoothing is done by a real shared module, **`frontend/kalman-filter.js`** (`window.GPSFilter`), loaded by all three files — this replaced the older speed-adaptive dual-EMA `Smoother`/`SimSmoother`/`makeSimSmoother()` (deleted entirely from all three copies). It's a true Extended Kalman Filter in geographic coordinates: state `[lat, lon, v_north, v_east]`, Jacobian re-linearized every step, measurement noise weighted by `fix.acc` (the old EMA ignored GPS accuracy entirely), and a self-scaling normalized-innovation-squared outlier gate (structurally replaces the old hardcoded speed-based spike-reject clamp, which was the root cause of a real "stuck at 0 above 90 km/h" bug and had already drifted between different values across the three old copies within the same week). API: `GPSFilter.push(fix)` / `GPSFilter.reset()`. Permanent regression tests live in `tests/kalman-filter.test.js` and `tests/gpsfilter-trigger-comparison.test.js` (run with `node --test tests/`) — re-run these before trusting any future change to this file.

If trigger behavior ever regresses again (stops staying "active" past their radius, new stops failing to fire, speed readings sticking at 0), check this module first — and check all **three call sites** (`geofence-engine.html`, `geofence-sim.html`, `fence-editor.html`), since the *smoothing* logic is now shared but the surrounding `Geofencer`/`TUNING`/`SIM_TUNING` trigger-detection code around it is still a deliberate "verbatim mirror," duplicated three times (real extraction is still pending, tracked as future work in `geofence-sim.html`'s own header comment).

## Fence Editor Test Mode — `editorToSimBundle()` needs every per-stop field added elsewhere too

Test Mode (`fence-editor.html`'s built-in walk simulator) doesn't read the live `zones` array directly — it snapshots one into a separate `simBundle` via `editorToSimBundle()`, an object-literal function that copies each per-stop field over by hand (`volume`, `bearingDeg`, `spatialClearM`, `ttsVoice`, etc.). **This has silently dropped a newly-added field three separate times** (a per-stop volume slider, 2026-07-23; `ttsVoice`, 2026-08-07 — confirmed live via a diagnostic log showing every stop's TTS call requesting the default voice regardless of what was actually published, even though the publish/export path itself was correct) — the field works everywhere except Test Mode, and nothing errors, it just silently uses whatever default the missing field falls back to.

**Any time a new per-stop field is added to the zone schema in `fence-editor.html`, grep all three of these together and confirm the new field appears in each**: `editorToSimBundle(` (Test Mode's snapshot), `exportBundle(`/the zone-export helper feeding it (Publish), and `engineToZone(` (import/reload path). Same root cause class as the engine-core "verbatim mirror" trap above — three separate places that all need to agree on the zone shape, with nothing structurally enforcing it.

## Fence Editor — Code Object attach/detach must call `autoSave()`

Per-stop Code Object attach/detach has three call sites in `fence-editor.html` (the floating palette's card-click/`−`-button via `CodeObjects.mount()`'s `onZonesChanged` callback — the one most likely actually used; the map-canvas drag-drop handler; the stop-list-row drag-drop handler) plus one for *global* (project-wide) objects. All four must call `autoSave()` after mutating `zone.codeObjects`/`globalCodeObjects` — confirmed live (2026-08-07) that all three **per-stop** sites were missing it (only the global one had it), so an attach/detach only ever lived in the in-memory `zones` array, silently reverting to whatever was last actually published on any page reload or navigation away (e.g. the "Code Library →" round-trip). If a future report says an attach/detach "didn't stick" or a previously-removed object "came back," check for this pattern on whatever new call site triggered it before assuming a fresh bug.

## iOS Audio Playback — Two Distinct Restrictions

Two separate iOS Safari/WebKit rules block audio in different ways. Conflating them wastes a fix cycle — confirmed the hard way:

1. **Hardware ring/silent-switch mutes raw `AudioContext` output.** Affects `SpatialVoice`/`AmbientVoice` in `geofence-engine.html` (WebAudio-routed spoken/ambient audio). Fixed in `Audio.unlock()`: play a real, unmuted, looping, silent-WAV `<audio>` **element** once inside a genuine tap — this shifts the page's audio session category so `AudioContext` output is heard regardless of the switch.
2. **Plain `<audio>`-element playback requires a user gesture, per element.** A `new Audio(url)` created later from a non-gesture context (a `geolocation.watchPosition` callback, a timer) does **not** inherit permission just because a *different* element played successfully earlier — only that *same* element stays "activated." Affects `field-recorder.html`'s `playStopAudio()`/`checkProximityAudio()` (GPS-triggered proximity auto-play). Fixed by reusing **one** shared `<audio>` element for all playback (manual taps and auto-play alike) instead of instantiating a fresh one per call.
3. **`speechSynthesis.speak()` has no durable unlock at all on iOS Safari/WebKit (including Chrome-on-iOS, same engine).** Unlike restriction 2's `<audio>` element, there is no "stays activated" state to reuse — confirmed live (2026-08-07): a direct button tap plays fine every time, but the identical `speechSynthesis.speak()` call from `checkProximityAudio`'s `geolocation.watchPosition` callback stayed silent regardless of how recently a real tap had occurred, priming with a dummy utterance on tap, or re-arming on every subsequent tap. There is no known pure-JS fix — don't spend another cycle on unlock tricks for this API specifically. **Fixed by not using `speechSynthesis` for background-triggered speech at all**: `field-recorder.html`'s `playCandidate()`/`sayViaTts()` sends the `say` text to `POST /api/tts` (server-side Workers AI, already used elsewhere as a TTS fallback tier) and plays the returned audio back through the same restriction-2-safe shared `<audio>` element, with `speechSynthesis` kept only as a last-resort fallback if `/api/tts` is unreachable (offline).

**Diagnostic tell**: if a manual tap-triggered play works but an automatic/programmatic one is silent, it's restriction 2 or 3 (gesture requirement) — restriction 1's fix (a separate silent loop) will not help. If everything *looks* like it's playing (event log shows success, gain computed correctly) but nothing is audible regardless of trigger source, ask about the hardware mute switch first (restriction 1). If the silent call specifically is `speechSynthesis.speak()` (not an `<audio>`/WebAudio path), go straight to restriction 3 — don't re-attempt an unlock/re-arm trick for it, generate the audio server-side instead.

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

**Zone body interaction:** Click any zone to select + fly to it. Drag any zone body to move the entire zone. Click empty map to deselect. **Right-click or double-click a zone** opens a Rename/Copy/Move to…/Delete menu (`openZoneMenu`, same function the stop-tree's "⋯" button uses) positioned at the cursor; double-click-to-zoom is disabled map-wide as a result (MapLibre has no per-layer toggle for it).

**Add-a-stop picker:** the Circle/Polygon/Tripline/Corridor tools + "Import GPX as Corridor" are collapsed behind one "add a stop — pick a shape" button (`#shapePickerBtn`) instead of separate always-visible buttons.

**Corridor (consolidated, migration `0055`):** "Path", "Walking Path", and "Corridor" were three overlapping line features; now there is one — a **Corridor**. One draw tool, one library (`corridor`/`corridor_folder` tables, app-scoped, `/api/corridor*`), one tree UI (`corridor-tree.js`, mounted in the `#gpxPalette` "Corridors" palette and in the GPX Editor). A corridor's `shape` is `{type:"corridor", coords, widthM}`; every corridor has a width (`width_m NOT NULL DEFAULT 10`). Two optional behaviors, both toggles in the property panel / palette:
- **`zone.movingAudio`** — an ambient audio bed travels the line at `speedKmh`/`loopMode` (the former "Path"). When on, `zoneToEngine`/`editorToSimBundle` serialize the zone to the old Path bundle form (top-level `zo.path` + `movementMode`/`speedKmh`/`loopMode`/`ambientAudioUrl` + circle-at-moving-point layers) so the engine's existing `centerNow()` moving-audio path runs unchanged; `engineToZone` detects a top-level `zo.path` and restores `movingAudio`. All 3 mirror functions must keep this in sync (CLAUDE.md's verbatim-mirror rule) — guarded by `tests/fence-editor-corridor-mirror.test.js`.
- **map-matching** — ticked per corridor in the palette; the active set is `bundle.mapMatchCorridorIds` (was `bundle.walkingPathIds`). The runtime (`geofence-engine.html`/`geofence-sim.html` `loadWalkingPaths`, `WALKING_PATHS`) fetches geometry from public `GET /api/corridor/:id`. `zone.snapCorridorId` (was `zone.onPathId`) is editor-only glue linking a circle stop's drag-slide to a specific corridor. Runtime identifiers keep the historical `walkingPath*`/`WALKING_PATHS` names deliberately (internal, triple-mirrored). The pipeline block type string `data.walking_path_progress` is unchanged (published-bundle value); its label is "Corridor Progress".

**Stop list:** the search box, Bulk-assign/Move… controls, and the stop-folder tree are collapsed behind a "stops (n) — click to edit" toggle button (`#stopsToggleBtn`/`#stopsBody`).

**Project settings:** customer picker, "this is a template" checkbox, and four dot-badge buttons (voice range, full vol, visitor, stop visibility) live in a popover opened from the ⚙ button in the panel header (`#projSettingsPopover`, toggled via `#projSettingsBtn`) — not inline in the panel body. Click a dot → inline slider opens + ghost ring appears on map centered on all zones. Click again to close. Any future fixed-position popover here must be a **top-level sibling of `#mainPanel`**, never nested inside it — `.panel` uses `backdrop-filter`, which creates a new CSS containing block for `position:fixed` descendants, so a popover nested inside it positions/clips relative to the panel's own box instead of the viewport.

**Panel is floating and resizable:** drag the header (breadcrumb row, `#mainPanelHead`) to move `#mainPanel` anywhere; resize from the bottom-right corner (native `resize:both`, matching `#audioPalette`'s existing pattern). ◀ button collapses panel to 36px strip; ▶ expands.

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
| PATCH | `/api/projects/:id` | scoped (`publish`); partial update — `record_retention_days`, `questPublic` (Ridge Quest R7 public-picker opt-in, second of two levels alongside `app.questEnabled`), `questActivities` (array of `ski`/`hike`/`bike`/`drive`/`xcski`, or `null` for all — which activities this project's picker/leaderboard offer), `terrainBiome` (Artistic Fog-of-War Tiles classification fallback), and/or `season` (`summer`/`winter`/`null`) |
| PUT | `/api/projects/:id/app` | master |
| GET/POST | `/api/apps` | GET public, POST master |
| PUT | `/api/apps/:id` | master; partial update of name/description and seven boolean flags (`threeDEnabled`/`terrainAltitudeEnabled`/`visitorsFly`/`hazardAwareEnabled`/`fogEnabled`/`questEnabled`/`tileArtEnabled`) |
| DELETE | `/api/apps/:id` | master (`?cascade=true` deletes all projects too) |
| GET | `/api/quest-workspaces` | public; Ridge Quest's in-app resort picker — only apps with `questEnabled=1`, returns `id`+`name` only |
| GET | `/api/quest-projects?app=` | public; only projects under a `questEnabled` app that are themselves `questPublic=1`, returns `id`+`name` only |
| POST | `/api/quest-backfill-activity-stats` | master; idempotent rebuild of `player_day_activity_stats` from `quest_run` history |
| GET/POST/DELETE | `/api/keys` | master |
| GET | `/api/audit` | master |
| GET | `/api/auth-check` | any valid token |
| POST | `/api/devices` | public |
| POST | `/api/devices/:id/forget` | public (right-to-delete) |
| GET/POST | `/api/consent` | public |
| POST | `/api/events` | public (requires stored `store-history` consent) |
| GET | `/api/analytics` | scoped (`analytics`) |
| GET/POST | `/api/corridor` | GET requires `?appId=` (omits `points_json`); POST creates. Both scoped (`audio` or `publish`) on the app + same-org. |
| GET/PATCH/DELETE | `/api/corridor/:id` | GET **public** (live engine map-match fetch, returns full `points`); PATCH/DELETE scoped (`audio`/`publish`) on the row's app. |
| GET/POST | `/api/corridor-folder` | GET requires `?appId=`; POST creates. Scoped (`audio`/`publish`) on the app. |
| PATCH/DELETE | `/api/corridor-folder/:id` | scoped (`audio`/`publish`) on the row's app; rename/reparent (cycle-checked) / subtree-delete (corridors moved up to parent). |
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
| POST | `/api/tile-asset` | master; upload a curated tile PNG + metadata (`?terrainType=&variantIndex=&season=&style=`) into the shared library |
| GET | `/api/tiles/:r2Key` | public (streaming, immutable cache) |
| GET | `/api/tile-assets` | public; `?terrainType=`/`?season=` filters (season also always includes season-neutral rows) |
| POST | `/api/projects/:id/classify-terrain` | scoped (`publish`); OSM + elevation terrain classifier, body `{corridors?:[{coords,widthM}], polygons?:[[[lon,lat],...]]}` (at least one); never re-classifies or deletes `source='manual'` cells |
| GET | `/api/projects/:id/terrain-cells` | public; a project's terrain cells (`h3Cell`, `terrainType`, `variantIndex`, `source`) |
| POST | `/api/projects/:id/terrain-cells` | scoped (`publish`); Map Paint hand-paints — body `{paint:[{h3Cell,terrainType,variantIndex}], erase:[h3Cell,...]}`, writes `source='manual'`, max 2000 cells/call |
| POST | `/api/projects/:id/reveal-cells` | public, device-scoped (`deviceId` in body, no bearer auth — same pattern as `/api/events`) |
| GET | `/api/projects/:id/fog?device=` | public; a device's already-revealed cells for a project |
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

## Bluetooth GPS

`frontend/ble-gps.js` (`window.BleGPS`) is a shared module — matching the `kalman-filter.js`/`guidance-bot.js` callback-injection pattern — used by `geofence-engine.html`, `geofence-sim.html`, `fence-editor.html` (Test Mode), and `field-recorder.html`. Supports two BLE GPS protocols, auto-detected on connect:

| Protocol | BLE Service | Who uses it |
|----------|-------------|-------------|
| LNS | GATT `0x1819` | Dedicated BLE GPS receivers broadcasting the standard service, no pairing app needed |
| NUS (UART) | `6e400001-...` | DIY/custom dongles broadcasting GPS as text lines over Bluetooth UART |

NUS also carries optional altitude fields (`alt_m`, `alt_acc_m`) for a barometric-equipped dongle — see `frontend/kalman-filter.js`'s EKF altitude fusion.

Only works in Chrome or Edge (Web Bluetooth API).

## Guardrails

- **Never** hardcode or commit Cloudflare account IDs, API tokens, or `ADMIN_TOKEN`.
- Secrets go in `wrangler.jsonc` secret bindings or `.dev.vars` (gitignored) for local dev.
- The `database_id` in `wrangler.jsonc` is not a secret — committing it is fine.
- Secret scanning: `gitleaks` runs in CI (`.github/workflows/secret-scan.yml`) on every push/PR
  to `main`, and locally via `.githooks/pre-commit`. Enable the hook once per clone with
  `git config core.hooksPath .githooks`. Config + public-value allowlist: `.gitleaks.toml`.
  See `SECURITY.md`.
