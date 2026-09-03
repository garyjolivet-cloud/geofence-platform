-- Ridge Quest: "track my friends" — a persistent per-resort friends list
-- plus an opt-in, auto-expiring daily live-location share.
--
-- Built on patterns already in this repo: player_friend/player_presence are
-- the anonymous `presence` table (migrations/0005_presence.sql) moved behind
-- playerAuth() and scoped to accepted friendships; the 60s cron prune in
-- cleanupLiveZones() is extended to cover player_presence too.
--
-- player_account references are DELIBERATELY plain columns, not FKs — same
-- choice 0039 made for consent.playerId (see feedback-d1-fk-rebuild-gotcha):
-- player_account changes shape often, and an FK here would force every future
-- rebuild to also touch these tables.

-- share_until: epoch ms. While > now, this player's location may be stored
-- (POST /api/presence) and shown to friends (GET /api/presence/friends). Set
-- to the next Golden-day midnight by POST /api/share {on:true}; cleared to
-- NULL by {on:false}. Never auto-extended — the player re-opts-in each day.
ALTER TABLE player_account ADD COLUMN share_until INTEGER;

-- invite_token: stable per-player random hex, generated lazily the first time
-- the player opens GET /api/friends/invite. The invite link carries
-- "<playerId>.<invite_token>"; regenerating the token (future feature)
-- revokes every previously shared link.
ALTER TABLE player_account ADD COLUMN invite_token TEXT;

-- One row per friendship (or pending request). The pair is stored sorted
-- (player_lo = min(a,b) by string, player_hi = max) so the UNIQUE index
-- collapses a request and its reverse into the same row, and "my friends"
-- is a single (player_lo=? OR player_hi=?) scan.
CREATE TABLE IF NOT EXISTS player_friend (
  id           TEXT    PRIMARY KEY,
  app_id       TEXT    NOT NULL,   -- player_account is per-resort; friendships are too
  player_lo    TEXT    NOT NULL,   -- min(playerA, playerB) lexicographically
  player_hi    TEXT    NOT NULL,   -- max(playerA, playerB)
  status       TEXT    NOT NULL,   -- 'pending' | 'accepted'
  requested_by TEXT    NOT NULL,   -- which of the two players sent the request
  created_at   INTEGER NOT NULL,
  accepted_at  INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS player_friend_pair ON player_friend(player_lo, player_hi);
CREATE INDEX IF NOT EXISTS player_friend_lo ON player_friend(player_lo, status);
CREATE INDEX IF NOT EXISTS player_friend_hi ON player_friend(player_hi, status);

-- One upserted row per player — the anonymous `presence` table's shape, keyed
-- on the authenticated player instead of a device id. Pruned to a 60s window
-- by cleanupLiveZones() on the */5 cron, same as `presence`.
CREATE TABLE IF NOT EXISTS player_presence (
  player_id  TEXT    PRIMARY KEY,
  app_id     TEXT    NOT NULL,
  lat        REAL    NOT NULL,
  lon        REAL    NOT NULL,
  heading    REAL,
  accuracy   REAL,
  updated_at INTEGER NOT NULL
);
