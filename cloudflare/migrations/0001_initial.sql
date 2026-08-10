PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS maps (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  author_id TEXT NOT NULL,
  owner_hash TEXT NOT NULL,
  map_hash TEXT NOT NULL,
  map_json TEXT NOT NULL,
  search_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  plays INTEGER NOT NULL DEFAULT 0 CHECK (plays >= 0),
  clears INTEGER NOT NULL DEFAULT 0 CHECK (clears >= 0),
  ticket_id TEXT NOT NULL UNIQUE,
  terms_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden')),
  moderated_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS maps_status_created_idx
  ON maps (status, created_at DESC);
CREATE INDEX IF NOT EXISTS maps_status_plays_idx
  ON maps (status, plays DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS maps_status_clears_idx
  ON maps (status, clears DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS maps_author_status_idx
  ON maps (author_id, status);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  map_hash TEXT NOT NULL,
  map_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  publish_ticket TEXT,
  ticket_expires_at INTEGER,
  clear_proof_json TEXT
);

CREATE INDEX IF NOT EXISTS attempts_expires_idx
  ON attempts (expires_at);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('map', 'author')),
  reason TEXT NOT NULL CHECK (
    reason IN ('abuse', 'hate', 'sexual', 'violence', 'personal_info', 'spam', 'illegal', 'copyright', 'other')
  ),
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT '',
  resolution TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS reports_one_open_per_reporter_idx
  ON reports (map_id, reporter_id, scope) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS reports_status_created_idx
  ON reports (status, created_at DESC);

CREATE TABLE IF NOT EXISTS blocked_authors (
  author_id TEXT PRIMARY KEY,
  blocked_at TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_limits_expires_idx
  ON rate_limits (expires_at);
