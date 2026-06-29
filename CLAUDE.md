# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Geofence Platform

Cloudflare Workers app: static HTML tools + a D1-backed REST API + R2 audio storage.

## File Layout

```
geofence-platform/
├── backend/
│   └── worker.js            ← Cloudflare Worker: all /api/* routes + asset fallthrough
├── frontend/
│   ├── index.html           ← Homepage — lists projects, links to tools
│   ├── dashboard.html       ← Admin dashboard (API key management, audit log)
│   ├── fence-editor.html    ← Geofence zone editor (publishes bundles to D1)
│   ├── geofence-engine.html ← Tour player / engine (loads published bundles)
│   ├── geofence-sim.html    ← Geofence simulator (tests zones without live GPS)
│   ├── audio-bench.html     ← Audio upload/playback sandbox
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
│   └── 0001_schema.sql      ← Full D1 schema (7 tables)
└── wrangler.jsonc           ← Wrangler config (D1 + R2 bindings, assets: "./frontend")
```

## Development Commands

Run from the **project root** (not from backend/ or frontend/).

```bash
# Start the local Worker dev server (serves HTML + /api/* together)
npx wrangler dev

# Apply schema to local D1 (first-time setup)
npx wrangler d1 execute geofence-db --file=migrations/0001_schema.sql

# Apply schema to remote D1
npx wrangler d1 execute geofence-db --remote --file=migrations/0001_schema.sql

# Check migration status
npx wrangler d1 migrations list geofence-db

# Deploy to Cloudflare
npx wrangler deploy
```

## Local Development Setup

Create a `.dev.vars` file at the project root (gitignored) to set secrets for `npx wrangler dev`:

```ini
ADMIN_TOKEN=your-secret-token-here
# ALLOWED_ORIGIN not needed locally (defaults to *, all origins allowed)
# ORG_ID=chase-life
```

This file is never committed. In production, `ADMIN_TOKEN` is set via `npx wrangler secret put ADMIN_TOKEN` and `ORG_ID`/`ALLOWED_ORIGIN` are set in `wrangler.jsonc`.

## Architecture

- **Worker** (`worker.js`): handles `/api/*` routes, falls through to `env.ASSETS` for everything else.
- **Friendly URLs**: the Worker maps `/editor` → `fence-editor.html`, `/sim` → `geofence-sim.html`, `/engine` → `geofence-engine.html`, `/dashboard` → `dashboard.html`, `/share` → `share.html`, `/audio` → `audio-bench.html`.
- **D1** (`geofence-db`, binding `DB`): stores projects, published bundles, API keys, devices, consent records, and events.
- **R2** (`geofence-audio`, binding `AUDIO`): stores audio clips, served via `/api/audio/<key>`.
- **Auth**: master token via `ADMIN_TOKEN` secret (env var). Scoped per-app API keys stored as SHA-256 hashes in D1.

## D1 Schema (7 tables)

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

## Key API Endpoints

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/health` | public |
| GET/POST | `/api/projects` | GET public, POST master |
| GET/PUT | `/api/projects/:id/bundle` | GET public, PUT scoped (`publish`) |
| PUT | `/api/projects/:id/app` | master |
| GET/POST | `/api/apps` | GET public, POST master |
| GET/POST/DELETE | `/api/keys` | master |
| GET | `/api/audit` | master |
| GET | `/api/auth-check` | any valid token |
| POST | `/api/devices` | public |
| POST | `/api/devices/:id/forget` | public (right-to-delete) |
| GET/POST | `/api/consent` | public |
| POST | `/api/events` | public (requires stored `store-history` consent) |
| GET | `/api/analytics` | scoped (`analytics`) |
| GET | `/api/audio-list` | scoped (`audio`) |
| GET/PUT/DELETE | `/api/audio/:key` | GET public, PUT/DELETE scoped (`audio`) |

**Size guards:** bundles are rejected over 1 MB; event payloads over 500 KB.

## Security Model

**Two token types:**

| Token | Where it lives | What it can do |
|-------|---------------|----------------|
| `ADMIN_TOKEN` | Wrangler secret (never in code) | Everything — master key |
| Scoped API key | D1 `api_key` table (hashed) | Only the scopes you grant: `publish`, `analytics`, `audio` |

**Rule: never use `ADMIN_TOKEN` in a browser.** The editor and dashboard ask for a token in the browser UI. Use a scoped API key there, not the master token.

**Create a scoped key for browser use:**
```bash
curl -X POST https://geofence-platform.gary-jolivet.workers.dev/api/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"editor-browser","appId":"your-app-id","scopes":["publish"]}'
```
Copy the returned `key` value — it is shown once. Use it in the browser tool instead of the master token.

**CORS:** Write/admin endpoints are restricted to `ALLOWED_ORIGIN` (set in `wrangler.jsonc`). Public read endpoints allow `*`. For local dev, `ALLOWED_ORIGIN` is unset so all origins are allowed.

**Environment variables** (non-secret, set in `wrangler.jsonc`):
- `ORG_ID` — organisation slug (default: `chase-life`)
- `ALLOWED_ORIGIN` — browser origin allowed on write endpoints

## Bluetooth GPS (Garmin Instinct)

The geofence engine supports two BLE GPS protocols, auto-detected on connect:

| Protocol | BLE Service | Who uses it |
|----------|-------------|-------------|
| LNS | GATT `0x1819` | Dedicated BLE GPS receivers, some Garmin Edge units |
| NUS (UART) | `6e400001-...` | Garmin Instinct 2/Crossover/2X via Connect IQ app |

**Garmin Instinct compatibility:**

| Model | Connect IQ | BLE GPS |
|-------|-----------|---------|
| Instinct (1st gen) | Limited | Not recommended |
| Instinct 2 / Solar | Full CIQ 3.x | ✓ via NUS app |
| Instinct Crossover | Full CIQ 3.x | ✓ via NUS app |
| Instinct 2X Solar | Full CIQ 3.x | ✓ via NUS app |

**Connect IQ companion app** (`connect-iq/`): a Widget that broadcasts GPS over the Nordic UART Service (NUS). Sends one line per second over the TX characteristic (`6e400003-b5a3-f393-e0a9-e50e24dcca9e`).

Accepted formats (web app parses all of these):
```
lat,lon                     →  51.302757,-117.054644
lat,lon,acc_m               →  51.302757,-117.054644,3.5
$GPRMC sentence (NMEA)
$GPGGA sentence (NMEA)
```

Requires the `Ble` module and `communications` permission in the CIQ manifest.
Only works in Chrome or Edge (Web Bluetooth API).

## Guardrails

- **Never** hardcode or commit Cloudflare account IDs, API tokens, or `ADMIN_TOKEN` values.
- Secrets go in `wrangler.jsonc` secret bindings or `.dev.vars` (gitignored) for local dev.
- The `database_id` in `wrangler.jsonc` is not a secret — committing it is fine.
