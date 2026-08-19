-- Ridge Quest: Google Sign-In support. password_hash/salt need to become
-- nullable (a Google-only account has no password) and a new google_sub
-- column (Google's stable per-user id) needs to be added, unique when set —
-- SQLite permits multiple NULLs through a plain UNIQUE index, so no partial
-- index is needed for "unique only when present". SQLite can't relax a
-- NOT NULL constraint in place, hence a rebuild rather than a plain
-- ALTER TABLE ADD COLUMN.
--
-- Real gotcha hit here, worth the comment: consent.playerId REFERENCES
-- player_account(id) (added in 0036). SQLite's ALTER TABLE RENAME
-- automatically rewrites OTHER tables' FK clauses to keep following the
-- renamed table — so "RENAME player_account TO player_account_old"
-- silently repoints consent's FK at player_account_old, not at the newly
-- created player_account. Dropping player_account_old then still fails
-- (implicit-delete-on-DROP against a table consent's FK now points at).
-- Fix: consent.playerId is rebuilt here as a plain, non-FK column — a
-- soft reference only, same as this file's own comment already treats it
-- conceptually. This removes the whole class of future friction: any
-- later player_account rebuild (there will be more, this project changes
-- shape a lot) no longer needs to touch consent at all.
ALTER TABLE player_account RENAME TO player_account_old;

CREATE TABLE player_account (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT,
  salt          TEXT,
  google_sub    TEXT,
  app_id        TEXT NOT NULL,
  display_name  TEXT,
  created_at    TEXT NOT NULL,
  last_login_at TEXT,
  reset_token   TEXT,
  reset_expires INTEGER
);

INSERT INTO player_account
  (id,email,password_hash,salt,google_sub,app_id,display_name,created_at,last_login_at,reset_token,reset_expires)
  SELECT id,email,password_hash,salt,NULL,app_id,display_name,created_at,last_login_at,reset_token,reset_expires
  FROM player_account_old;

CREATE UNIQUE INDEX IF NOT EXISTS player_account_email_app ON player_account(app_id, email);
CREATE INDEX IF NOT EXISTS player_account_app ON player_account(app_id);
CREATE UNIQUE INDEX IF NOT EXISTS player_account_google_sub ON player_account(google_sub);

-- Rebuild consent so playerId is a plain column, not an FK — see comment
-- above. deviceId keeps its existing FK to device(id), unaffected (device
-- isn't being touched here).
CREATE TABLE consent_new (
  id            TEXT    PRIMARY KEY,
  deviceId      TEXT    REFERENCES device(id),
  playerId      TEXT,
  scope         TEXT    NOT NULL,
  granted       INTEGER NOT NULL,
  version       TEXT    NOT NULL DEFAULT '1',
  retentionDays INTEGER,
  grantedAt     TEXT    NOT NULL,
  revokedAt     TEXT
);

INSERT INTO consent_new (id,deviceId,playerId,scope,granted,version,retentionDays,grantedAt,revokedAt)
  SELECT id,deviceId,playerId,scope,granted,version,retentionDays,grantedAt,revokedAt FROM consent;

DROP TABLE consent;
ALTER TABLE consent_new RENAME TO consent;

CREATE INDEX IF NOT EXISTS idx_consent_device_scope ON consent(deviceId, scope, grantedAt DESC);
CREATE INDEX IF NOT EXISTS idx_consent_player_scope ON consent(playerId, scope, grantedAt DESC);

-- Now safe: nothing references player_account_old by FK anymore (consent
-- was just rebuilt without one).
DROP TABLE player_account_old;
