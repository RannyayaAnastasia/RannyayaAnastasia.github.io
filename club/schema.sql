CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (provider, subject)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_attempts (
  state TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS workouts (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  PRIMARY KEY (member_id, day)
);

CREATE TABLE IF NOT EXISTS recommendations (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('books', 'music')),
  title TEXT NOT NULL,
  creator TEXT NOT NULL,
  note TEXT NOT NULL,
  link TEXT NOT NULL,
  reaction TEXT NOT NULL DEFAULT '' CHECK (reaction IN ('', 'later', 'done')),
  reply TEXT NOT NULL DEFAULT '',
  created BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS recommendations_feed ON recommendations (kind, created DESC, id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires);
CREATE INDEX IF NOT EXISTS oauth_expiry ON oauth_attempts (expires);
