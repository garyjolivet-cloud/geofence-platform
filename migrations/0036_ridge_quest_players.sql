-- Ridge Quest (R0): player accounts, distinct from user_account (staff-only:
-- admin/operator/guide/front_desk). Mirrors user_account/user_session's
-- proven shape (migrations/0006_users_projects.sql) rather than inventing a
-- new auth pattern. email is unique per app_id, not globally, since the same
-- email could plausibly play at more than one resort's own Ridge Quest
-- instance on this platform (unlike staff accounts, which are effectively
-- platform-wide).
CREATE TABLE IF NOT EXISTS player_account (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  app_id        TEXT NOT NULL,
  display_name  TEXT,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS player_account_email_app ON player_account(app_id, email);
CREATE INDEX IF NOT EXISTS player_account_app ON player_account(app_id);

CREATE TABLE IF NOT EXISTS player_session (
  id          TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  ip          TEXT
);

CREATE INDEX IF NOT EXISTS player_session_token ON player_session(token_hash);
CREATE INDEX IF NOT EXISTS player_session_player ON player_session(player_id);

-- Rebuild `consent` so it can carry PLAYER acceptances (the mandatory
-- data-privacy / liability-waiver / responsibility-code onboarding gate),
-- not just anonymous-device consent. The existing append-only/versioned
-- shape (migrations/0001_schema.sql) is exactly right for this, so this
-- reuses the table rather than adding a parallel one — but deviceId's
-- NOT NULL + FK constraint can't be altered in place in SQLite, hence the
-- rebuild-and-swap instead of a plain ALTER TABLE ADD COLUMN.
CREATE TABLE consent_new (
  id            TEXT    PRIMARY KEY,
  deviceId      TEXT    REFERENCES device(id),
  playerId      TEXT    REFERENCES player_account(id),
  scope         TEXT    NOT NULL,  -- device scopes e.g. 'store-history', 'location';
                                    -- player scopes: 'data-privacy', 'liability-waiver', 'responsibility-code'
  granted       INTEGER NOT NULL,
  version       TEXT    NOT NULL DEFAULT '1',
  retentionDays INTEGER,
  grantedAt     TEXT    NOT NULL,
  revokedAt     TEXT
);

INSERT INTO consent_new (id,deviceId,playerId,scope,granted,version,retentionDays,grantedAt,revokedAt)
  SELECT id,deviceId,NULL,scope,granted,version,retentionDays,grantedAt,revokedAt FROM consent;

DROP TABLE consent;
ALTER TABLE consent_new RENAME TO consent;

CREATE INDEX IF NOT EXISTS idx_consent_device_scope ON consent(deviceId, scope, grantedAt DESC);
CREATE INDEX IF NOT EXISTS idx_consent_player_scope ON consent(playerId, scope, grantedAt DESC);
