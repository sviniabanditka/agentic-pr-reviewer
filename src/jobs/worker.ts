import { prDiff, viewPr } from "../github/gh.js";
import { parseDiffOutput } from "../github/parse_diff.js";
import { prepareDiff, renderDiffForPrompt } from "../review/diff.js";
import { cacheKey } from "../review/cache_key.js";
import { callClaude } from "../review/claude.js";
import { isInconclusive, review, type ReviewResult } from "../review/run.js";
import { isBlockingCandidate } from "../verdict/verdict.js";
import { claudeSettingsFor, type Account } from "../config.js";
import { recordClaudeLimits } from "../scheduler/poller.js";
import { updateJob } from "./queue.js";
import type { Runtime } from "../runtime.js";
import type { JobRow } from "../store/types.js";

export type Stage = "diff" | "review" | "confirm";

function setStage(rt: Runtime, jobId: number, stage: Stage | undefined): void {
  if (stage === undefined) rt.stages.delete(jobId);
  else rt.stages.set(jobId, stage);
  rt.bus.emit({ type: "stage", data: { jobId, stage: stage ?? null } });
}

// ponytail: one job at a time — the Claude subscription limit, not CPU, is the bottleneck.
export async function startWorker(rt: Runtime): Promise<never> {
  // A job left "running" was cut off by a restart; it was never published.
  rt.db.run("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'");

  for (;;) {
    const job = rt.db.query("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get() as JobRow | null;
    if (job === null) {
      await rt.waitForWork(60_000);
      continue;
    }
    const account = rt.cfg.accounts.find((a) => a.name === job.account);
    if (account === undefined) {
      updateJob(rt, job.id, { status: "error", error: "account no longer in config", finished_at: Date.now() });
      continue;
    }
    await runJob(rt, account, job);
  }
}

async function runJob(rt: Runtime, account: Account, job: JobRow): Promise<void> {
  const ctx = { account: account.name, jobId: job.id };
  const startedAt = Date.now();
  // Jobs queued before the model picker existed carry no model.
  const model = job.model ?? account.model;
  updateJob(rt, job.id, { status: "running", started_at: startedAt });
  rt.log("info", `reviewing ${job.repo}#${job.number} "${job.title}" with ${model}`, ctx);

  try {
    setStage(rt, job.id, "diff");
    const pr = await viewPr(account.githubToken, job.repo, job.number);
    if (pr.headRefOid !== job.head_sha) {
      rt.log("info", `new push since queued, reviewing @${pr.headRefOid.slice(0, 7)}`, ctx);
      updateJob(rt, job.id, { head_sha: pr.headRefOid });
    }

    const files = parseDiffOutput(await prDiff(account.githubToken, job.repo, job.number));
    if (files.length === 0) {
      updateJob(rt, job.id, { status: "skipped", error: "empty diff", finished_at: Date.now() });
      rt.log("info", "empty diff, skipped", ctx);
      return;
    }

    const diff = prepareDiff(files);
    const intent = pr.body.trim() !== "" ? pr.body : undefined;
    const key = cacheKey(renderDiffForPrompt(diff), model, intent);
    rt.log("info", `${files.length} file(s), ~${diff.tokenEstimate} tokens, ${diff.skippedFiles.length} skipped`, ctx);

    const hit = rt.db.query("SELECT result FROM cache WHERE key = ?").get(key) as { result: string } | null;
    let result: ReviewResult;
    if (hit !== null) {
      result = JSON.parse(hit.result) as ReviewResult;
      rt.log("info", "verdict from cache", ctx);
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
            const run = await callClaude(message, claudeSettingsFor(rt.cfg, account, model));
            if (run.limits !== undefined) recordClaudeLimits(rt, account.name, run.limits);
            return run;
          },
          log: (msg) => rt.log("info", msg, ctx),
          stage: (stage) => setStage(rt, job.id, stage),
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
      updateJob(rt, job.id, { ...stats, status: "error", error: `no verdict: ${result.errorMessage ?? result.outcome}`, finished_at: Date.now() });
      rt.log("error", `no verdict: ${result.errorMessage ?? result.outcome}`, ctx);
      return;
    }
    if (hit === null) {
      rt.db.query("INSERT OR REPLACE INTO cache (key, result, created_at) VALUES (?, ?, ?)").run(key, JSON.stringify(result), Date.now());
    }

    // Nothing goes to GitHub here: the review waits in the panel until someone posts it.
    updateJob(rt, job.id, { ...stats, status: "done", finished_at: Date.now() });
    rt.log("info", `done in ${((Date.now() - startedAt) / 1000).toFixed(0)}s: ${result.verdict.title}; post it from the panel`, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateJob(rt, job.id, { status: "error", error: message, finished_at: Date.now() });
    rt.log("error", message, ctx);
  } finally {
    setStage(rt, job.id, undefined);
  }
}
