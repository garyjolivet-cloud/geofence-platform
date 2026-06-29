-- Geofence Platform — initial schema
-- Apply: npx wrangler d1 execute geofence-db --file=migrations/0001_schema.sql
-- Apply (remote): npx wrangler d1 execute geofence-db --remote --file=migrations/0001_schema.sql

-- -----------------------------------------------------------------------
-- Workspace: groups projects under a single tenant
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app (
  id          TEXT PRIMARY KEY,
  orgId       TEXT NOT NULL DEFAULT 'chase-life',
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);

-- -----------------------------------------------------------------------
-- Project: a named geofence tour/experience
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project (
  id            TEXT PRIMARY KEY,
  orgId         TEXT NOT NULL DEFAULT 'chase-life',
  appId         TEXT REFERENCES app(id),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'walking-tour',
  status        TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'live'
  bundleVersion INTEGER NOT NULL DEFAULT 1,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_appId     ON project(appId);
CREATE INDEX IF NOT EXISTS idx_project_updatedAt ON project(updatedAt DESC);
CREATE INDEX IF NOT EXISTS idx_project_slug      ON project(slug);

-- -----------------------------------------------------------------------
-- Published bundle: versioned JSON snapshot published by the editor
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS published_bundle (
  projectId   TEXT    NOT NULL REFERENCES project(id),
  version     INTEGER NOT NULL,
  json        TEXT    NOT NULL,
  publishedAt TEXT    NOT NULL,
  PRIMARY KEY (projectId, version)
);

CREATE INDEX IF NOT EXISTS idx_bundle_projectId ON published_bundle(projectId, version DESC);

-- -----------------------------------------------------------------------
-- API key: scoped bearer tokens (stored as SHA-256 hashes)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_key (
  id         TEXT PRIMARY KEY,
  keyHash    TEXT NOT NULL UNIQUE,  -- SHA-256 hex of the raw token
  appId      TEXT REFERENCES app(id),
  label      TEXT NOT NULL DEFAULT '',
  scopes     TEXT NOT NULL DEFAULT '*',  -- comma-separated: publish, analytics, audio, *
  createdAt  TEXT NOT NULL,
  lastUsedAt TEXT,
  revokedAt  TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_key_hash ON api_key(keyHash);

-- -----------------------------------------------------------------------
-- Audit log: immutable append-only record of admin actions
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id     TEXT PRIMARY KEY,
  ts     TEXT NOT NULL,
  keyId  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  ip     TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts DESC);

-- -----------------------------------------------------------------------
-- Device: anonymous visitor registration (upserted on each visit)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device (
  id        TEXT PRIMARY KEY,
  platform  TEXT NOT NULL DEFAULT 'web',
  lastSeen  TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

-- -----------------------------------------------------------------------
-- Consent: append-only record of user consent decisions
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consent (
  id            TEXT    PRIMARY KEY,
  deviceId      TEXT    NOT NULL REFERENCES device(id),
  scope         TEXT    NOT NULL,  -- e.g. 'store-history', 'location'
  granted       INTEGER NOT NULL,  -- 1 = granted, 0 = revoked
  version       TEXT    NOT NULL DEFAULT '1',
  retentionDays INTEGER,
  grantedAt     TEXT    NOT NULL,
  revokedAt     TEXT
);

CREATE INDEX IF NOT EXISTS idx_consent_device_scope ON consent(deviceId, scope, grantedAt DESC);

-- -----------------------------------------------------------------------
-- Event: analytics events, gated by consent
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event (
  id        TEXT    PRIMARY KEY,  -- client-generated UUID; INSERT OR IGNORE = idempotent
  projectId TEXT    NOT NULL REFERENCES project(id),
  userId    TEXT,
  deviceId  TEXT    NOT NULL REFERENCES device(id),
  type      TEXT    NOT NULL DEFAULT 'event',
  ts        INTEGER NOT NULL,     -- epoch ms
  data      TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_event_project_ts ON event(projectId, ts DESC);
CREATE INDEX IF NOT EXISTS idx_event_deviceId   ON event(deviceId);
