import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type JobStatus = "queued" | "running" | "done" | "error" | "skipped";

export interface JobRow {
  id: number;
  account: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  role: string;
  head_sha: string;
  status: JobStatus;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  outcome: string | null;
  conclusion: string | null;
  verdict_title: string | null;
  findings: number | null;
  blocking: number | null;
  confirmed: number | null;
  runs: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  model: string | null;
  cached: number | null;
  comment_url: string | null;
  error: string | null;
}

export interface PrRow {
  account: string;
  repo: string;
  number: number;
  updated_at: string;
  head_sha: string;
  comment_id: number | null;
}

export interface EventRow {
  id: number;
  ts: number;
  level: string;
  account: string | null;
  job_id: number | null;
  msg: string;
}

export function openDb(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "reviewer.sqlite"), { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS prs (
    account TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
    updated_at TEXT NOT NULL, head_sha TEXT NOT NULL, comment_id INTEGER,
    PRIMARY KEY (account, repo, number))`);
  db.run(`CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
    title TEXT NOT NULL, url TEXT NOT NULL, role TEXT NOT NULL, head_sha TEXT NOT NULL,
    status TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
    outcome TEXT, conclusion TEXT, verdict_title TEXT,
    findings INTEGER, blocking INTEGER, confirmed INTEGER,
    runs INTEGER, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
    model TEXT, cached INTEGER, comment_url TEXT, error TEXT, result TEXT)`);
  db.run("CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, id)");
  db.run("CREATE INDEX IF NOT EXISTS jobs_pr ON jobs (account, repo, number, head_sha)");
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL,
    account TEXT, job_id INTEGER, msg TEXT NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS events_job ON events (job_id)");
  db.run("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, result TEXT NOT NULL, created_at INTEGER NOT NULL)");
  return db;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Events and the verdict cache are working data, not history worth keeping forever. */
export function prune(db: Database): void {
  db.query("DELETE FROM events WHERE ts < ?").run(Date.now() - 14 * DAY_MS);
  db.query("DELETE FROM cache WHERE created_at < ?").run(Date.now() - DAY_MS);
}
