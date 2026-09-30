import type { Database } from "bun:sqlite";
import { prDiff, upsertComment, viewPr } from "./github/gh.js";
import { parseDiffOutput } from "./github/parse_diff.js";
import { COMMENT_MARKER, renderComment } from "./github/comment.js";
import { prepareDiff, renderDiffForPrompt } from "./review/diff.js";
import { cacheKey } from "./review/cache_key.js";
import { callClaude } from "./review/claude.js";
import { isInconclusive, review, type ReviewResult } from "./review/run.js";
import { isBlockingCandidate } from "./verdict/verdict.js";
import { broadcast, log } from "./log.js";
import { claudeSettingsFor, type Account, type Config } from "./config.js";
import { recordClaudeLimits } from "./poller.js";
import type { JobRow, PrRow } from "./db.js";

let wake: (() => void) | undefined;

export type Stage = "diff" | "review" | "confirm";
/** Stage of each running job, for the panel's pipeline strip. */
export const stages = new Map<number, Stage>();

function setStage(jobId: number, stage: Stage | undefined): void {
  if (stage === undefined) stages.delete(jobId);
  else stages.set(jobId, stage);
  broadcast({ type: "stage", data: { jobId, stage: stage ?? null } });
}

/** Called after the panel queued a review, so the worker doesn't wait out its idle sleep. */
export function kickWorker(): void {
  wake?.();
}

// ponytail: one job at a time — the Claude subscription limit, not CPU, is the bottleneck.
export async function startWorker(cfg: Config, db: Database): Promise<never> {
  // A job left "running" was cut off by a restart; it was never published.
  db.run("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'");

  for (;;) {
    const job = db.query("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get() as JobRow | null;
    if (job === null) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 60_000);
      });
      continue;
    }
    const account = cfg.accounts.find((a) => a.name === job.account);
    if (account === undefined) {
      update(db, job.id, { status: "error", error: "account no longer in config", finished_at: Date.now() });
      continue;
    }
    await runJob(cfg, db, account, job);
  }
}

async function runJob(cfg: Config, db: Database, account: Account, job: JobRow): Promise<void> {
  const ctx = { account: account.name, jobId: job.id };
  const startedAt = Date.now();
  // Jobs queued before the model picker existed carry no model.
  const model = job.model ?? account.model;
  update(db, job.id, { status: "running", started_at: startedAt });
  log("info", `reviewing ${job.repo}#${job.number} "${job.title}" with ${model}`, ctx);

  try {
    setStage(job.id, "diff");
    const pr = await viewPr(account.githubToken, job.repo, job.number);
    if (pr.headRefOid !== job.head_sha) {
      log("info", `new push since queued, reviewing @${pr.headRefOid.slice(0, 7)}`, ctx);
      update(db, job.id, { head_sha: pr.headRefOid });
    }

    const files = parseDiffOutput(await prDiff(account.githubToken, job.repo, job.number));
    if (files.length === 0) {
      update(db, job.id, { status: "skipped", error: "empty diff", finished_at: Date.now() });
      log("info", "empty diff, skipped", ctx);
      return;
    }

    const diff = prepareDiff(files);
    const intent = pr.body.trim() !== "" ? pr.body : undefined;
    const key = cacheKey(renderDiffForPrompt(diff), model, intent);
    log("info", `${files.length} file(s), ~${diff.tokenEstimate} tokens, ${diff.skippedFiles.length} skipped`, ctx);

    const hit = db.query("SELECT result FROM cache WHERE key = ?").get(key) as { result: string } | null;
    let result: ReviewResult;
    if (hit !== null) {
      result = JSON.parse(hit.result) as ReviewResult;
      log("info", "verdict from cache", ctx);
    } else {
      result = await review(
        {
          diff,
          context: {
            repo: job.repo,
            number: job.number,
            title: pr.title,
            headSha: pr.headRefOid,
            baseSha: pr.baseRefOid,
            branch: pr.headRefName,
          },
          ...(intent !== undefined ? { intent } : {}),
        },
        {
          call: async (message) => {
            const run = await callClaude(message, claudeSettingsFor(cfg, account, model));
            if (run.limits !== undefined) recordClaudeLimits(account.name, run.limits);
            return run;
          },
          log: (msg) => log("info", msg, ctx),
          stage: (stage) => setStage(job.id, stage),
        },
      );
    }

    const stats = {
      outcome: result.outcome,
      conclusion: result.verdict.conclusion,
      verdict_title: result.verdict.title,
      findings: result.findings.length,
      blocking: result.findings.filter(isBlockingCandidate).length,
      confirmed: result.confirmedMarkers.length,
      runs: hit !== null ? 0 : result.usage.runs,
      tokens_in: hit !== null ? 0 : result.usage.tokensIn,
      tokens_out: hit !== null ? 0 : result.usage.tokensOut,
      cost_usd: hit !== null ? 0 : result.usage.costUsd,
      model,
      cached: hit !== null ? 1 : 0,
      result: JSON.stringify(result),
    };

    // No verdict is not worth a comment in someone's PR: the panel shows the error and offers a retry.
    if (isInconclusive(result.outcome)) {
      update(db, job.id, { ...stats, status: "error", error: `no verdict: ${result.errorMessage ?? result.outcome}`, finished_at: Date.now() });
      log("error", `no verdict: ${result.errorMessage ?? result.outcome}`, ctx);
      return;
    }
    if (hit === null) {
      db.query("INSERT OR REPLACE INTO cache (key, result, created_at) VALUES (?, ?, ?)").run(key, JSON.stringify(result), Date.now());
    }

    // Nothing goes to GitHub here: the review waits in the panel until someone posts it.
    update(db, job.id, { ...stats, status: "done", finished_at: Date.now() });
    log("info", `done in ${((Date.now() - startedAt) / 1000).toFixed(0)}s: ${result.verdict.title}; post it from the panel`, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    update(db, job.id, { status: "error", error: message, finished_at: Date.now() });
    log("error", message, ctx);
  } finally {
    setStage(job.id, undefined);
  }
}

type JobUpdate = Partial<Omit<JobRow, "id">> & { result?: string };

function update(db: Database, id: number, fields: JobUpdate): void {
  const keys = Object.keys(fields);
  const values = Object.values(fields) as (string | number | null)[];
  const row = db
    .query(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ? RETURNING *`)
    .get(...values, id) as (JobRow & { result?: string }) | null;
  if (row !== null) {
    const { result: _result, ...summary } = row;
    broadcast({ type: "job", data: summary });
  }
}

const publishing = new Set<number>();

/**
 * Posts a finished review as the PR comment, or edits the one this account already
 * has there. The only path that writes to GitHub, and it runs only on request.
 */
export async function publishJob(cfg: Config, db: Database, id: number): Promise<{ url: string } | { error: string }> {
  const job = db.query("SELECT * FROM jobs WHERE id = ?").get(id) as (JobRow & { result: string | null }) | null;
  if (job === null) return { error: "no such review" };
  if (job.status !== "done" || job.result === null) return { error: "only a finished review can be posted" };
  const account = cfg.accounts.find((a) => a.name === job.account);
  if (account === undefined) return { error: "account no longer in config" };
  if (publishing.has(id)) return { error: "already posting this review" };

  publishing.add(id);
  const ctx = { account: account.name, jobId: id };
  try {
    const result = JSON.parse(job.result) as ReviewResult;
    const body = renderComment(result, {
      repo: job.repo,
      headSha: job.head_sha,
      model: job.model ?? account.model,
      elapsedMs: (job.finished_at ?? 0) - (job.started_at ?? 0),
    });
    const prRow = db
      .query("SELECT * FROM prs WHERE account = ? AND repo = ? AND number = ?")
      .get(account.name, job.repo, job.number) as PrRow | null;
    const comment = await upsertComment(account.githubToken, job.repo, job.number, account.login, COMMENT_MARKER, body, prRow?.comment_id ?? null);
    db.query("UPDATE prs SET comment_id = ? WHERE account = ? AND repo = ? AND number = ?").run(comment.id, account.name, job.repo, job.number);
    // One comment per PR: the reviews posted before this one no longer point at what it says.
    const superseded = db
      .query("UPDATE jobs SET comment_url = NULL WHERE account = ? AND repo = ? AND number = ? AND id != ? AND comment_url IS NOT NULL RETURNING *")
      .all(account.name, job.repo, job.number, id) as (JobRow & { result?: string })[];
    for (const { result: _result, ...summary } of superseded) broadcast({ type: "job", data: summary });
    update(db, id, { comment_url: comment.url });
    log("info", `posted to ${job.repo}#${job.number} → ${comment.url}`, ctx);
    return { url: comment.url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("error", `posting failed: ${message}`, ctx);
    return { error: message };
  } finally {
    publishing.delete(id);
  }
}
