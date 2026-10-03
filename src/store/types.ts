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

export interface UserRow {
  id: string;
  login: string;
  password_hash: string;
  role: "admin" | "member";
  disabled: number;
  created_at: number;
}
