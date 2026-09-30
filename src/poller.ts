import type { Database } from "bun:sqlite";
import { rateLimit, searchPrs, viewPr, type RateWindow, type SearchHit } from "./github/gh.js";
import { probeLimits, type ClaudeLimits } from "./review/claude.js";
import { broadcast, log } from "./log.js";
import { claudeSettingsFor, type Account, type Config } from "./config.js";
import type { JobRow, PrRow } from "./db.js";

export interface AccountStatus {
  name: string;
  login: string;
  verifiedLogin?: string;
  claudeReady: boolean;
  /** Preselected in the panel's model picker. */
  model: string;
  lastPollAt?: number;
  lastPollMs?: number;
  lastError?: string;
  openPrs: number;
  /** Subscription windows from the last Claude run or probe. */
  claude?: ClaudeLimits;
  claudeError?: string;
  github?: { core: RateWindow; search: RateWindow };
}

/** An open PR the panel offers a review button for. */
export interface OpenPr {
  account: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  role: string;
  updatedAt: string;
  headSha: string;
}

export const accountStatus = new Map<string, AccountStatus>();
/** The latest poll's open PRs, per account: what the panel lists and what a review may be started for. */
export const openPrs = new Map<string, OpenPr[]>();

const QUALIFIER: Record<Account["triggers"][number], string> = {
  review_requested: "review-requested:@me",
  author: "author:@me",
};

export function initAccountStatus(cfg: Config): void {
  for (const account of cfg.accounts) {
    accountStatus.set(account.name, {
      name: account.name,
      login: account.login,
      claudeReady: account.claudeToken !== undefined,
      model: account.model,
      openPrs: 0,
    });
    if (account.claudeToken === undefined) {
      log("warn", `CLAUDE_TOKEN_${account.name.toUpperCase()} is not set, reviews for this account cannot run`, { account: account.name });
    }
  }
}

let pollNow: () => Promise<void> = async () => {};

/** Refreshes the PR lists outside the schedule, for the panel's refresh button. */
export function requestPoll(): Promise<void> {
  return pollNow();
}

export function startPoller(cfg: Config, db: Database): void {
  let running: Promise<void> | undefined;

  const tick = async (): Promise<void> => {
    for (const account of cfg.accounts) {
      const status = accountStatus.get(account.name)!;
      const startedAt = Date.now();
      try {
        const prs = await pollAccount(account, db);
        openPrs.set(account.name, prs);
        status.openPrs = prs.length;
        status.lastError = undefined;
        broadcast({ type: "prs", data: { account: account.name, prs } });
        status.github = await rateLimit(account.githubToken);
      } catch (error) {
        status.lastError = error instanceof Error ? error.message : String(error);
        log("error", `poll failed: ${status.lastError}`, { account: account.name });
      }
      status.lastPollAt = Date.now();
      status.lastPollMs = status.lastPollAt - startedAt;
      broadcast({ type: "status", data: status });
    }
  };

  // Overlapping polls would only burn search quota: a second request joins the running one.
  pollNow = () => {
    running ??= tick().finally(() => (running = undefined));
    return running;
  };

  const loop = async (): Promise<void> => {
    await pollNow();
    setTimeout(loop, cfg.pollIntervalSec * 1000);
  };
  void loop();

  // Reviews refresh the limits as a side effect; the probe covers idle accounts.
  const probeLoop = async (): Promise<void> => {
    await refreshClaudeLimits(cfg);
    setTimeout(probeLoop, LIMITS_PROBE_MS);
  };
  void probeLoop();
}

// ponytail: a haiku "ok" every 30 min per account; drop the timer if even that shows in the quota.
const LIMITS_PROBE_MS = 30 * 60 * 1000;

export function recordClaudeLimits(accountName: string, limits: ClaudeLimits): void {
  const status = accountStatus.get(accountName);
  if (status === undefined) return;
  status.claude = limits;
  status.claudeError = undefined;
  broadcast({ type: "status", data: status });
}

/** Asks Claude Code for the subscription windows of one account, or of all of them. */
export async function refreshClaudeLimits(cfg: Config, accountName?: string): Promise<void> {
  for (const account of cfg.accounts) {
    if (account.claudeToken === undefined || (accountName !== undefined && account.name !== accountName)) continue;
    const status = accountStatus.get(account.name)!;
    try {
      const limits = await probeLimits(claudeSettingsFor(cfg, account, "haiku"));
      if (limits !== undefined) recordClaudeLimits(account.name, limits);
    } catch (error) {
      status.claudeError = error instanceof Error ? error.message : String(error);
      log("warn", `limits check failed: ${status.claudeError}`, { account: account.name });
      broadcast({ type: "status", data: status });
    }
  }
}

async function pollAccount(account: Account, db: Database): Promise<OpenPr[]> {
  const hits = new Map<string, { hit: SearchHit; role: string }>();
  for (const trigger of account.triggers) {
    for (const hit of await searchPrs(account.githubToken, QUALIFIER[trigger])) {
      if (!isInScope(account, hit, trigger)) continue;
      const key = `${hit.repo}#${hit.number}`;
      hits.set(key, { hit, role: hits.has(key) ? "author+reviewer" : trigger });
    }
  }

  const prs: OpenPr[] = [];
  for (const { hit, role } of hits.values()) {
    prs.push({
      account: account.name,
      repo: hit.repo,
      number: hit.number,
      title: hit.title,
      url: hit.url,
      author: hit.author,
      role,
      updatedAt: hit.updatedAt,
      headSha: await headSha(account, db, hit),
    });
  }
  return prs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// A review request is an explicit invitation, so it is listed wherever it comes from;
// `owners` keeps authored PRs in upstream projects out of the list.
function isInScope(account: Account, hit: SearchHit, trigger: Account["triggers"][number]): boolean {
  if (hit.authorIsBot) return false;
  if (trigger !== "author" || account.owners === undefined) return true;
  const owner = hit.repo.split("/")[0]?.toLowerCase();
  return account.owners.some((o) => o.toLowerCase() === owner);
}

/** The search hit carries no head sha; a PR is only re-read when it changed since the last poll. */
async function headSha(account: Account, db: Database, hit: SearchHit): Promise<string> {
  const pr = db
    .query("SELECT * FROM prs WHERE account = ? AND repo = ? AND number = ?")
    .get(account.name, hit.repo, hit.number) as PrRow | null;
  if (pr !== null && pr.updated_at === hit.updatedAt) return pr.head_sha;

  const details = await viewPr(account.githubToken, hit.repo, hit.number);
  db.query(
    `INSERT INTO prs (account, repo, number, updated_at, head_sha) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account, repo, number) DO UPDATE SET updated_at = excluded.updated_at, head_sha = excluded.head_sha`,
  ).run(account.name, hit.repo, hit.number, hit.updatedAt, details.headRefOid);
  return details.headRefOid;
}

/**
 * Queues a review the person asked for in the panel. Only PRs from the latest poll
 * qualify: the panel cannot be used to comment on an arbitrary repository.
 */
export function enqueueReview(
  cfg: Config,
  db: Database,
  accountName: string,
  repo: string,
  number: number,
  requestedModel?: string,
): { job: JobRow } | { error: string } {
  const account = cfg.accounts.find((a) => a.name === accountName);
  if (account === undefined) return { error: "unknown account" };
  if (account.claudeToken === undefined) return { error: "no Claude token for this account" };
  const model = requestedModel ?? account.model;
  if (!cfg.models.includes(model)) return { error: `model ${model} is not allowed` };

  const pr = openPrs.get(accountName)?.find((p) => p.repo === repo && p.number === number);
  if (pr === undefined) return { error: "PR is not in the open list; refresh and retry" };

  const active = db
    .query("SELECT id FROM jobs WHERE account = ? AND repo = ? AND number = ? AND status IN ('queued', 'running')")
    .get(accountName, repo, number);
  if (active !== null) return { error: "a review of this PR is already queued or running" };

  const job = db
    .query(
      `INSERT INTO jobs (account, repo, number, title, url, role, head_sha, model, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?) RETURNING *`,
    )
    .get(accountName, repo, number, pr.title, pr.url, pr.role, pr.headSha, model, Date.now()) as JobRow;
  log("info", `queued ${repo}#${number} @${pr.headSha.slice(0, 7)} with ${model} from the panel`, { account: accountName, jobId: job.id });
  broadcast({ type: "job", data: job });
  return { job };
}

/** Only a queued job can be cancelled; a running one has already spent its model run. */
export function cancelJob(db: Database, id: number): JobRow | null {
  const job = db
    .query("UPDATE jobs SET status = 'skipped', error = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued' RETURNING *")
    .get(Date.now(), id) as (JobRow & { result?: string }) | null;
  if (job === null) return null;
  const { result: _result, ...summary } = job;
  log("info", `cancelled ${job.repo}#${job.number}`, { account: job.account, jobId: id });
  broadcast({ type: "job", data: summary });
  return job;
}
