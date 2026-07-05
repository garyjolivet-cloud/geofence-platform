# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Geofence Platform

Cloudflare Workers app: static HTML tools + a D1-backed REST API + R2 audio storage + AI chat via Groq.

## File Layout

```
geofence-platform/
├── backend/
│   └── worker.js            ← Cloudflare Worker: all /api/* routes + asset fallthrough + cron
├── frontend/
│   ├── index.html           ← Homepage — lists projects, links to tools
│   ├── dashboard.html       ← Admin dashboard (API key management, audit log)
│   ├── fence-editor.html    ← Geofence zone editor (publishes bundles to D1; auto-saves draft to localStorage)
│   ├── geofence-engine.html ← Tour player / engine (loads published bundles; Kokoro TTS)
│   ├── guidance-bot.js      ← Guidance bot module (window.GuidanceBot)
│   ├── geofence-sim.html    ← Geofence simulator (tests zones without live GPS)
│   ├── audio-bench.html     ← Audio upload/playback sandbox
│   ├── bot-library.html     ← Bot library manager (/bots route)
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
│   └── 0003_bots.sql        ← Bot table
└── wrangler.jsonc           ← Wrangler config (D1 + R2 + AI bindings, assets: "./frontend", cron triggers)
```

## Development Commands

Run from the **project root** (not from backend/ or frontend/).

```bash
# Start the local Worker dev server (serves HTML + /api/* together)
npx wrangler dev

# Apply all migrations to local D1 (first-time setup)
npx wrangler d1 execute geofence-db --local --file=migrations/0001_schema.sql
npx wrangler d1 execute geofence-db --local --file=migrations/0002_weather.sql
npx wrangler d1 execute geofence-db --local --file=migrations/0003_bots.sql

# Apply migrations to remote D1
npx wrangler d1 execute geofence-db --remote --file=migrations/0001_schema.sql
npx wrangler d1 execute geofence-db --remote --file=migrations/0002_weather.sql
npx wrangler d1 execute geofence-db --remote --file=migrations/0003_bots.sql

# Deploy to Cloudflare
npx wrangler deploy
```

After starting `npx wrangler dev`, open http://127.0.0.1:8787 in a browser. Keep the wrangler terminal running — it must stay alive to serve the site. Use a second terminal for all other commands.

## Local Development Setup

Create a `.dev.vars` file at the project root (gitignored) to set secrets for `npx wrangler dev`:

```ini
ADMIN_TOKEN=your-secret-token-here
GROQ_API_KEY=your-groq-key-here
# ALLOWED_ORIGIN not needed locally (defaults to *, all origins allowed)
# ORG_ID=chase-life
```

This file is never committed. In production, secrets are set via `npx wrangler secret put <NAME>`.

## Architecture

- **Worker** (`worker.js`): handles `/api/*` routes, falls through to `env.ASSETS` for everything else. Also has a `scheduled()` handler for cron jobs.
- **Friendly URLs**: the Worker maps `/editor` → `fence-editor.html`, `/sim` → `geofence-sim.html`, `/engine` → `geofence-engine.html`, `/dashboard` → `dashboard.html`, `/share` → `share.html`, `/audio` → `audio-bench.html`, `/bots` → `bot-library.html`.
- **D1** (`geofence-db`, binding `DB`): stores projects, published bundles, API keys, devices, consent records, events, bots, weather cache, snow history.
- **R2** (`geofence-audio`, binding `AUDIO`): stores audio clips, served via `/api/audio/<key>`.
- **AI** (binding `AI`): Cloudflare Workers AI — used for Whisper STT (`/api/transcribe`) and TTS (`/api/tts`).
- **Groq**: LLaMA 3.3 70B via `GROQ_API_KEY` secret — used for chat (`/api/chat`), streaming SSE.
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
| `bot` | Reusable AI personas (region bots + visitor/client bots) |
| `weather_cache` | Rolling hourly weather readings from Kicking Horse Resort (last 48) |
| `snow_history` | Daily 8am MST snow snapshots (last 14 days) |

## Bot System

Bots are reusable AI personas stored in D1 (`bot` table) and managed at `/bots`.

**Three bot types:**

| Type | Where used | Purpose |
|------|-----------|---------|
| `region` | Assigned to a zone in the fence editor | Greets and chats with visitors who enter that zone |
| `visitor` | Assigned to the whole project as a "client bot" | Travels with the visitor, accumulates zone history context |
| `guidance` | Assigned to a trigger zone; targets another zone | Guides visitor to a GPS spot and bearing using relative directions only |

**Bot fields:** `id`, `app_id`, `name`, `type`, `avatar` (emoji), `persona`, `knowledge`, `greeting`, `created_at`, `updated_at`

**In the fence editor:**
- Bot tray shows all region and guidance bots as draggable cards
- Drag a bot card → map zone polygon to assign it (point-in-polygon drop target)
- Drag a bot card → zone list row to assign it
- Zones with bots show the avatar emoji floating above the zone on the map
- Up to 3 bot avatars shown per zone
- Zones can have multiple region bots with priority ordering (drag to reorder)
- **Guidance bot slot**: when a guidance bot is assigned, a "Guide to zone" dropdown appears — select the destination zone

## Guidance Bot (`frontend/guidance-bot.js`)

Standalone IIFE module exposing `window.GuidanceBot`. Phone-in-pocket precision positioning — all instructions relative (turn left/right, bear, slow down), no compass directions.

**Zone fields added for guidance:**

| Field | Type | Purpose |
|-------|------|---------|
| `bearingDeg` | `number\|null` | Direction visitor should face on arrival (0–359°) |
| `isHazard` | `boolean` | Marks zone as a routing obstacle (renders red on map) |

**Two phases:**
1. `navigate` — guides to within 8m of target zone center
2. `align` — tells visitor to face `bearingDeg` using GPS travel heading

**Direction instructions** use a state machine with 10° hysteresis: STRAIGHT / BEAR / TURN / AROUND. Heading source is GPS travel heading only (phone in pocket — device compass unreliable). Circular EMA (α=0.15) smooths heading.

**Hazard avoidance**: Turf.js (lazy CDN load) buffers hazard zones 5m, checks if direct path intersects, routes tangent waypoints around them. Graceful degradation if offline.

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
- Amber dashed line shows `bearingDeg` direction from zone center
- Green arrow on sim avatar points toward current waypoint/target during guidance

**Chat API** (`/api/chat`): proxies to Groq streaming, builds a system prompt from:
- Bot persona + knowledge base
- Current weather (from `weather_cache`)
- 14-day snow history (from `snow_history`)
- Visitor's geofence state (zone, dwell, speed, heading, zone history, tracker states)

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
| GET | `/api/audio-list` | scoped (`audio` or `publish`) |
| GET/PUT/DELETE | `/api/audio/:key` | GET public, PUT/DELETE scoped (`audio` or `publish`) |
| POST | `/api/transcribe` | public (Workers AI Whisper STT) |
| POST | `/api/tts` | public (Workers AI speecht5_tts → WAV) |
| GET | `/api/weather` | public (latest cached reading) |
| POST | `/api/weather` | master (manual scrape trigger) |
| GET | `/api/snow-history` | public (14-day daily snapshots) |
| POST | `/api/snow-history` | master (manual snapshot trigger) |
| GET/POST | `/api/bots` | GET public, POST scoped (`publish`) |
| PUT/DELETE | `/api/bots/:id` | PUT scoped (`publish`), DELETE master |
| POST | `/api/chat` | public (Groq SSE stream) |
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

- **Never** hardcode or commit Cloudflare account IDs, API tokens, `ADMIN_TOKEN`, or `GROQ_API_KEY`.
- Secrets go in `wrangler.jsonc` secret bindings or `.dev.vars` (gitignored) for local dev.
- The `database_id` in `wrangler.jsonc` is not a secret — committing it is fine.
