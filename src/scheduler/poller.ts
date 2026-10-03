import { rateLimit, searchPrs, viewPr, type RateWindow, type SearchHit } from "../github/gh.js";
import { probeLimits, type ClaudeLimits } from "../review/claude.js";
import { claudeSettingsFor, type Account } from "../config.js";
import type { Runtime } from "../runtime.js";
import type { PrRow } from "../store/types.js";

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

const QUALIFIER: Record<Account["triggers"][number], string> = {
  review_requested: "review-requested:@me",
  author: "author:@me",
};

export function initAccountStatus(rt: Runtime): void {
  for (const account of rt.cfg.accounts) {
    rt.accountStatus.set(account.name, {
      name: account.name,
      login: account.login,
      claudeReady: account.claudeToken !== undefined,
      model: account.model,
      openPrs: 0,
    });
    if (account.claudeToken === undefined) {
      rt.log("warn", `CLAUDE_TOKEN_${account.name.toUpperCase()} is not set, reviews for this account cannot run`, { account: account.name });
    }
  }
}

export function startPoller(rt: Runtime): void {
  let running: Promise<void> | undefined;

  const tick = async (): Promise<void> => {
    for (const account of rt.cfg.accounts) {
      const status = rt.accountStatus.get(account.name)!;
      const startedAt = Date.now();
      try {
        const prs = await pollAccount(rt, account);
        rt.openPrs.set(account.name, prs);
        status.openPrs = prs.length;
        status.lastError = undefined;
        rt.bus.emit({ type: "prs", data: { account: account.name, prs } });
        status.github = await rateLimit(account.githubToken);
      } catch (error) {
        status.lastError = error instanceof Error ? error.message : String(error);
        rt.log("error", `poll failed: ${status.lastError}`, { account: account.name });
      }
      status.lastPollAt = Date.now();
      status.lastPollMs = status.lastPollAt - startedAt;
      rt.bus.emit({ type: "status", data: status });
    }
  };

  // Overlapping polls would only burn search quota: a second request joins the running one.
  const pollNow = (): Promise<void> => {
    running ??= tick().finally(() => (running = undefined));
    return running;
  };
  rt.setPollHandler(pollNow);

  const loop = async (): Promise<void> => {
    await pollNow();
    setTimeout(loop, rt.cfg.pollIntervalSec * 1000);
  };
  void loop();

  // Reviews refresh the limits as a side effect; the probe covers idle accounts.
  const probeLoop = async (): Promise<void> => {
    await refreshClaudeLimits(rt);
    setTimeout(probeLoop, LIMITS_PROBE_MS);
  };
  void probeLoop();
}

// ponytail: a haiku "ok" every 30 min per account; drop the timer if even that shows in the quota.
const LIMITS_PROBE_MS = 30 * 60 * 1000;

export function recordClaudeLimits(rt: Runtime, accountName: string, limits: ClaudeLimits): void {
  const status = rt.accountStatus.get(accountName);
  if (status === undefined) return;
  status.claude = limits;
  status.claudeError = undefined;
  rt.bus.emit({ type: "status", data: status });
}

/** Asks Claude Code for the subscription windows of one account, or of all of them. */
export async function refreshClaudeLimits(rt: Runtime, accountName?: string): Promise<void> {
  for (const account of rt.cfg.accounts) {
    if (account.claudeToken === undefined || (accountName !== undefined && account.name !== accountName)) continue;
    const status = rt.accountStatus.get(account.name)!;
    try {
      const limits = await probeLimits(claudeSettingsFor(rt.cfg, account, "haiku"));
      if (limits !== undefined) recordClaudeLimits(rt, account.name, limits);
    } catch (error) {
      status.claudeError = error instanceof Error ? error.message : String(error);
      rt.log("warn", `limits check failed: ${status.claudeError}`, { account: account.name });
      rt.bus.emit({ type: "status", data: status });
    }
  }
}

async function pollAccount(rt: Runtime, account: Account): Promise<OpenPr[]> {
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
      headSha: await headSha(rt, account, hit),
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
async function headSha(rt: Runtime, account: Account, hit: SearchHit): Promise<string> {
  const pr = rt.db
    .query("SELECT * FROM prs WHERE account = ? AND repo = ? AND number = ?")
    .get(account.name, hit.repo, hit.number) as PrRow | null;
  if (pr !== null && pr.updated_at === hit.updatedAt) return pr.head_sha;

  const details = await viewPr(account.githubToken, hit.repo, hit.number);
  rt.db.query(
    `INSERT INTO prs (account, repo, number, updated_at, head_sha) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account, repo, number) DO UPDATE SET updated_at = excluded.updated_at, head_sha = excluded.head_sha`,
  ).run(account.name, hit.repo, hit.number, hit.updatedAt, details.headRefOid);
  return details.headRefOid;
}
