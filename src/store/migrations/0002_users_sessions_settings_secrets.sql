CREATE TABLE users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL);

-- id is the sha256 of the cookie value: a leaked database does not yield live sessions.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT, user_agent TEXT);
CREATE INDEX sessions_user ON sessions (user_id);

-- user_id '' holds instance-wide settings.
CREATE TABLE settings (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key));

-- AES-256-GCM blobs; aad binds a ciphertext to what it is for, so rows cannot be swapped.
CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  aad TEXT NOT NULL,
  created_at INTEGER NOT NULL);
