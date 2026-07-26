-- Chatterbox Studio voice palette, moved server-side (was a local voices.json
-- file on one laptop, proxied through a Cloudflare Tunnel — see server.py's
-- removal of local ONNX cloning and chatterbox-local's retirement). Org-scoped
-- like the Library, since voices are meant to be reusable across every
-- project belonging to one company, not tied to a single workspace/project.
-- Every voice is Resemble-hosted — no local cloning is supported here at all.
CREATE TABLE IF NOT EXISTS chatterbox_voice (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL,
  name                TEXT NOT NULL,
  resemble_voice_uuid TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS chatterbox_voice_org_idx ON chatterbox_voice(org_id);
