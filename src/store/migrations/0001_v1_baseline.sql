-- The tables v1 created with CREATE TABLE IF NOT EXISTS; repeated here so an existing
-- volume is adopted unchanged and a fresh one gets the same starting point.
CREATE TABLE IF NOT EXISTS prs (
  account TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
  updated_at TEXT NOT NULL, head_sha TEXT NOT NULL, comment_id INTEGER,
  PRIMARY KEY (account, repo, number));
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
  title TEXT NOT NULL, url TEXT NOT NULL, role TEXT NOT NULL, head_sha TEXT NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  outcome TEXT, conclusion TEXT, verdict_title TEXT,
  findings INTEGER, blocking INTEGER, confirmed INTEGER,
  runs INTEGER, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
  model TEXT, cached INTEGER, comment_url TEXT, error TEXT, result TEXT);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, id);
CREATE INDEX IF NOT EXISTS jobs_pr ON jobs (account, repo, number, head_sha);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL,
  account TEXT, job_id INTEGER, msg TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_job ON events (job_id);
CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, result TEXT NOT NULL, created_at INTEGER NOT NULL);
