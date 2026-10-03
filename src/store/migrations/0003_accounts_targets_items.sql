-- Accounts, model credentials, review targets and discovered items move from config.json
-- and env into the database. Every owner-scoped row carries user_id.

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  secret_id TEXT NOT NULL,
  token_hint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  status_detail TEXT,
  limits_json TEXT,
  checked_at INTEGER,
  created_at INTEGER NOT NULL);
CREATE INDEX credentials_user ON credentials (user_id);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'github',
  login TEXT NOT NULL,
  label TEXT NOT NULL,
  token_secret_id TEXT NOT NULL,
  token_hint TEXT NOT NULL,
  scopes TEXT,
  credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  status_detail TEXT,
  checked_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, kind, login));

CREATE TABLE targets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('search', 'repo', 'pr')),
  params_json TEXT NOT NULL,
  filters_json TEXT NOT NULL DEFAULT '{}',
  automation TEXT NOT NULL DEFAULT 'manual' CHECK (automation IN ('manual', 'auto-review')),
  model TEXT,
  poll_sec INTEGER NOT NULL DEFAULT 60,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_polled_at INTEGER,
  last_error TEXT,
  next_poll_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE INDEX targets_due ON targets (enabled, next_poll_at);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'pr',
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  author TEXT NOT NULL,
  author_is_bot INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'watching',
  head_sha TEXT,
  base_sha TEXT,
  updated_at TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  draft INTEGER NOT NULL DEFAULT 0,
  labels_json TEXT NOT NULL DEFAULT '[]',
  additions INTEGER,
  deletions INTEGER,
  changed_files INTEGER,
  target_ids_json TEXT NOT NULL DEFAULT '[]',
  comment_id INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (account_id, repo, number));
CREATE INDEX items_user_state ON items (user_id, state);

ALTER TABLE jobs ADD COLUMN user_id TEXT;
ALTER TABLE jobs ADD COLUMN account_id TEXT;
ALTER TABLE jobs ADD COLUMN item_id TEXT;
CREATE INDEX jobs_item ON jobs (item_id, id);
CREATE INDEX jobs_user ON jobs (user_id, id);

ALTER TABLE events ADD COLUMN user_id TEXT;
