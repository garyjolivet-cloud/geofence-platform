-- Formalizes the multi-client sandbox: a real client entity backing the
-- existing orgId/org_id string columns on app, project, and user_account.
CREATE TABLE IF NOT EXISTS client (
  id         TEXT PRIMARY KEY,   -- same value already used as orgId, e.g. 'chase-life'
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO client (id, name, slug, created_at)
  VALUES ('chase-life', 'Chase Life', 'chase-life', datetime('now'));
