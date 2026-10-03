export interface User { id: string; login: string; role: "admin" | "member" }
export interface Window { utilization: number; resetsAt: number }
export interface Limits { fiveHour?: Window; sevenDay?: Window; status?: string; checkedAt: number }
export interface RateWindow { limit: number; remaining: number; reset: number }

export interface Account {
  id: string; login: string; label: string; kind: string; tokenHint: string; scopes: string | null;
  credentialId: string | null; model: string | null; profileId: string | null; status: string; statusDetail: string | null; checkedAt: number | null;
  github: { core?: RateWindow; search?: RateWindow } | null;
}
export interface Credential {
  id: string; provider: string; label: string; tokenHint: string; status: string; statusDetail: string | null;
  limits: Limits | null; checkedAt: number | null;
}
export interface TargetFilters {
  drafts?: boolean; bots?: boolean; labelsInclude?: string[]; labelsExclude?: string[];
  authorsInclude?: string[]; authorsExclude?: string[]; owners?: string[]; maxChangedFiles?: number;
}
export interface TargetParams { query?: string; repo?: string; number?: number; role?: "author" | "review_requested" | "watching" }
export interface Target {
  id: string; accountId: string; name: string; type: "search" | "repo" | "pr"; params: TargetParams; filters: TargetFilters;
  automation: "manual" | "auto-review"; model: string | null; profileId: string | null; pollSec: number; enabled: boolean;
  lastPolledAt: number | null; lastError: string | null; nextPollAt: number; openItems: number;
}
export interface Review {
  id: number; item_id: string | null; account_id: string | null; account: string; repo: string; number: number; title: string; url: string;
  role: string; head_sha: string; status: "queued" | "running" | "done" | "error" | "skipped"; created_at: number;
  started_at: number | null; finished_at: number | null; outcome: string | null; conclusion: string | null; verdict_title: string | null;
  findings: number | null; blocking: number | null; confirmed: number | null; runs: number | null; tokens_in: number | null;
  tokens_out: number | null; cost_usd: number | null; model: string | null; cached: number | null; comment_url: string | null; error: string | null;
  profile_id: string | null; profile_name: string | null; mode: string | null; chunks: number | null;
}
export interface Item {
  id: string; accountId: string; repo: string; number: number; title: string; url: string; author: string; authorIsBot: boolean;
  role: string; headSha: string | null; state: string; draft: boolean; labels: string[]; additions: number | null; deletions: number | null;
  changedFiles: number | null; updatedAt: string | null; targetIds: string[]; firstSeenAt: number; lastSeenAt: number; lastReview: Review | null;
}
export interface Finding {
  category: string; file: string; line_start: number; line_end: number; evidence: string; evidence_kind: string;
  claim: string; detail: string; evidenceCheck: "matched" | "not_found" | "skipped_absent";
}
export interface PrSummary { title: string; summary: string; changes: string[]; risks: string[]; testing: string[] }
export interface ReviewResult {
  outcome: string; verdict: { conclusion: string; title: string }; findings: Finding[]; confirmedMarkers: string[];
  skippedFiles: { path: string; reason: string }[]; usage: { runs: number; tokensIn: number; tokensOut: number; costUsd: number };
  mode?: string; blocking?: string[]; chunks?: number; summary?: PrSummary;
}
export interface Run {
  id: number; purpose: "review" | "confirm"; chunk: number; chunks: number; model: string; started_at: number; finished_at: number;
  outcome: string; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null; error: string | null;
}
export interface ProfileOptions {
  model?: string | null; confirmation?: "never" | "blocking"; categories?: string[]; blocking?: string[];
  budgetTokens?: number; maxChunks?: number; intent?: "pr-body" | "none"; instructions?: string;
  customCategories?: { id: string; description: string }[];
}
export interface Profile {
  id: string; name: string; mode: string; options: ProfileOptions; version: number; isDefault: boolean; updatedAt: number;
  resolved: { categories: string[]; blocking: string[]; confirmation: string; budgetTokens: number; maxChunks: number };
}
export interface Mode { id: string; label: string; description: string; output: "findings" | "summary"; categories: string[]; blocking: string[]; confirmation: string }
export interface ModelInfo { id: string; label: string; context: number }
export interface LogEvent { id: number; ts: number; level: "info" | "warn" | "error"; account: string | null; job_id: number | null; msg: string }
export interface Totals { reviews: number; runs: number; tokens_in: number; tokens_out: number; cost_usd: number }
export type Stage = "diff" | "review" | "confirm";
