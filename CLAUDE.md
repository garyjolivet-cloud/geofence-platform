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
```

This file is never committed. In production, set `ADMIN_TOKEN` via `npx wrangler secret put ADMIN_TOKEN`.

## Architecture

- **Worker** (`worker.js`): handles `/api/*` routes, falls through to `env.ASSETS` for everything else.
- **Friendly URLs**: the Worker maps `/editor` → `fence-editor.html`, `/sim` → `geofence-sim.html`, `/engine` → `geofence-engine.html`, `/dashboard` → `dashboard.html`, `/share` → `share.html`.
- **D1** (`geofence-db`, binding `DB`): stores projects, published bundles, API keys, devices, consent records, and events.
- **R2** (`geofence-audio`, binding `AUDIO`): stores audio clips, served via `/api/audio/<key>`.
- **Auth**: master token via `ADMIN_TOKEN` secret (env var). Scoped per-app API keys stored as SHA-256 hashes in D1.

## Key API Endpoints

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/health` | public |
| GET/POST | `/api/projects` | GET public, POST master |
| GET/PUT | `/api/projects/:id/bundle` | GET public, PUT scoped |
| GET/POST | `/api/apps` | GET public, POST master |
| GET/POST/DELETE | `/api/keys` | master |
| GET | `/api/audit` | master |
| POST | `/api/devices` | public |
| POST | `/api/consent` | public |
| POST | `/api/events` | public (requires stored consent) |
| GET | `/api/analytics` | scoped |
| GET/PUT/DELETE | `/api/audio/:key` | GET public, PUT/DELETE scoped |

## Guardrails

- **Never** hardcode or commit Cloudflare account IDs, API tokens, or `ADMIN_TOKEN` values.
- Secrets go in `wrangler.jsonc` secret bindings or `.dev.vars` (gitignored) for local dev.
- The `database_id` in `wrangler.jsonc` is not a secret — committing it is fine.
