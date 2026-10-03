-- Review profiles (mode + options), one row per model call, and which profile a review,
-- an account default or an auto-review target uses.

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE INDEX profiles_user ON profiles (user_id);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  chunk INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 1,
  model TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  error TEXT);
CREATE INDEX runs_job ON runs (job_id);

ALTER TABLE jobs ADD COLUMN profile_id TEXT;
ALTER TABLE jobs ADD COLUMN profile_name TEXT;
ALTER TABLE jobs ADD COLUMN profile_json TEXT;
ALTER TABLE jobs ADD COLUMN mode TEXT;
ALTER TABLE jobs ADD COLUMN chunks INTEGER;
ALTER TABLE accounts ADD COLUMN profile_id TEXT;
ALTER TABLE targets ADD COLUMN profile_id TEXT;
