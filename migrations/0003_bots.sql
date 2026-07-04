-- Bot library: org-scoped reusable bots, persistent across projects
CREATE TABLE IF NOT EXISTS bot (
  id          TEXT PRIMARY KEY,
  app_id      TEXT REFERENCES app(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'region',  -- 'region' | 'visitor'
  avatar      TEXT DEFAULT '🤖',
  persona     TEXT,
  knowledge   TEXT,
  greeting    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bot_app_idx ON bot(app_id);
