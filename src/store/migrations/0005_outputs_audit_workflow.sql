-- Outputs, audit, notification channels, dismissals; incremental reviews and priorities;
-- compare and patch items; the auto-post automation level.

CREATE TABLE outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  external_url TEXT,
  error TEXT,
  created_at INTEGER NOT NULL);
CREATE INDEX outputs_job ON outputs (job_id);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  account_id TEXT,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL);
CREATE INDEX audit_user ON audit (user_id, id);

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('webhook', 'slack', 'telegram')),
  label TEXT NOT NULL,
  secret_id TEXT NOT NULL,
  chat_id TEXT,
  events_json TEXT NOT NULL DEFAULT '["done","posted"]',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at INTEGER NOT NULL);

CREATE TABLE dismissals (
  item_id TEXT NOT NULL,
  marker TEXT NOT NULL,
  user_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, marker));

ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'full';
ALTER TABLE jobs ADD COLUMN base_job_id INTEGER;
ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN auto_post INTEGER NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS jobs_status;
CREATE INDEX jobs_queue ON jobs (status, priority DESC, id);

-- targets: allow 'auto-post'
CREATE TABLE targets_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('search', 'repo', 'pr')),
  params_json TEXT NOT NULL,
  filters_json TEXT NOT NULL DEFAULT '{}',
  automation TEXT NOT NULL DEFAULT 'manual' CHECK (automation IN ('manual', 'auto-review', 'auto-post')),
  model TEXT,
  poll_sec INTEGER NOT NULL DEFAULT 60,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_polled_at INTEGER,
  last_error TEXT,
  next_poll_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  profile_id TEXT);
INSERT INTO targets_new SELECT id, user_id, account_id, name, type, params_json, filters_json, automation, model, poll_sec, enabled,
  last_polled_at, last_error, next_poll_at, created_at, profile_id FROM targets;
DROP TABLE targets;
ALTER TABLE targets_new RENAME TO targets;
CREATE INDEX targets_due ON targets (enabled, next_poll_at);

-- items: compare ranges and pasted patches share the table with PRs
CREATE TABLE items_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'pr' CHECK (kind IN ('pr', 'compare', 'patch')),
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  ref_key TEXT NOT NULL DEFAULT '',
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
  compare_base TEXT,
  compare_head TEXT,
  patch_text TEXT,
  UNIQUE (account_id, kind, repo, number, ref_key));
INSERT INTO items_new (id, user_id, account_id, kind, repo, number, ref_key, title, url, author, author_is_bot, role, head_sha, base_sha,
  updated_at, state, draft, labels_json, additions, deletions, changed_files, target_ids_json, comment_id, first_seen_at, last_seen_at)
  SELECT id, user_id, account_id, kind, repo, number, '', title, url, author, author_is_bot, role, head_sha, base_sha,
  updated_at, state, draft, labels_json, additions, deletions, changed_files, target_ids_json, comment_id, first_seen_at, last_seen_at FROM items;
DROP TABLE items;
ALTER TABLE items_new RENAME TO items;
CREATE INDEX items_user_state ON items (user_id, state);
