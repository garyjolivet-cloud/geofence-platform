CREATE TABLE IF NOT EXISTS user_account (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  salt          TEXT,
  org_id        TEXT,
  role          TEXT NOT NULL DEFAULT 'guide',
  name          TEXT,
  invite_token  TEXT,
  invite_expires INTEGER,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS user_account_email ON user_account(email);
CREATE INDEX IF NOT EXISTS user_account_org ON user_account(org_id);

CREATE TABLE IF NOT EXISTS user_session (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  ip          TEXT
);

CREATE INDEX IF NOT EXISTS user_session_token ON user_session(token_hash);
CREATE INDEX IF NOT EXISTS user_session_user  ON user_session(user_id);

ALTER TABLE project ADD COLUMN scheduled_date TEXT;
ALTER TABLE project ADD COLUMN guide_id TEXT;
ALTER TABLE project ADD COLUMN is_template INTEGER DEFAULT 0;
ALTER TABLE project ADD COLUMN tour_type TEXT;
ALTER TABLE project ADD COLUMN archived INTEGER DEFAULT 0;
