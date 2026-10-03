import { claudeSettingsFor, githubFor, recordLimits } from "../accounts/service.js";
import { parseDiffOutput } from "../github/parse_diff.js";
import { chunkDiff, renderAll } from "../review/chunk.js";
import { resolveProfile, type ProfileOptions } from "../review/modes.js";
import { cacheKey } from "../review/cache_key.js";
import { isInconclusive, review, type ReviewResult } from "../review/run.js";
import { isBlockingCandidate } from "../verdict/verdict.js";
import { getAccountAny, getCredentialAny, getItemAny, updateItem } from "../store/repos.js";
import { updateJob } from "./queue.js";
import type { Runtime } from "../runtime.js";
import type { JobRow } from "../store/types.js";

export type Stage = "diff" | "review" | "confirm";

type Job = JobRow & { user_id: string | null; account_id: string | null; item_id: string | null; profile_json: string | null };

function setStage(rt: Runtime, job: Job, stage: Stage | undefined): void {
  if (stage === undefined) rt.stages.delete(job.id);
  else rt.stages.set(job.id, stage);
  rt.bus.emit({ type: "stage", data: { jobId: job.id, stage: stage ?? null }, ...(job.user_id ? { userId: job.user_id } : {}) });
}

// ponytail: one job at a time — the Claude subscription limit, not CPU, is the bottleneck.
export async function startWorker(rt: Runtime): Promise<never> {
  // A job left "running" was cut off by a restart; it was never published.
  rt.db.run("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'");
  for (;;) {
    if (!(await runNext(rt))) await rt.waitForWork(60_000);
  }
}

/** Runs the oldest queued job; false when the queue is empty. Exposed for tests. */
export async function runNext(rt: Runtime): Promise<boolean> {
  const job = rt.db.query("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get() as Job | null;
  if (job === null) return false;
  await runJob(rt, job);
  return true;
}

async function runJob(rt: Runtime, job: Job): Promise<void> {
  const ctx = { account: job.account, jobId: job.id, ...(job.user_id ? { userId: job.user_id } : {}) };
  const startedAt = Date.now();
  updateJob(rt, job.id, { status: "running", started_at: startedAt });

  try {
    const account = job.account_id ? getAccountAny(rt.db, job.account_id) : null;
    if (account === null) throw new Error("account no longer exists");
    const credential = account.credential_id ? getCredentialAny(rt.db, account.credential_id) : null;
    if (credential === null) throw new Error(`no Claude credential attached to @${account.login}`);
    const model = job.model ?? account.model ?? rt.models()[0]!;
    rt.log("info", `reviewing ${job.repo}#${job.number} "${job.title}" with ${model}`, ctx);

    setStage(rt, job, "diff");
    const gh = githubFor(rt, account);
    const pr = await gh.pull(job.repo, job.number);
    if (pr.headSha !== job.head_sha) {
      rt.log("info", `new push since queued, reviewing @${pr.headSha.slice(0, 7)}`, ctx);
      updateJob(rt, job.id, { head_sha: pr.headSha });
    }
    if (job.item_id) updateItem(rt.db, job.item_id, { head_sha: pr.headSha, base_sha: pr.baseSha, state: pr.state });

    const files = parseDiffOutput(await gh.pullDiff(job.repo, job.number));
    if (files.length === 0) {
      updateJob(rt, job.id, { status: "skipped", error: "empty diff", finished_at: Date.now() });
      rt.log("info", "empty diff, skipped", ctx);
      return;
    }

    // Jobs from before profiles existed ran the triage mode with defaults.
    const snapshot = job.profile_json ? (JSON.parse(job.profile_json) as { mode: string; options: ProfileOptions }) : { mode: "diff-triage", options: {} };
    const profile = resolveProfile(snapshot.mode, snapshot.options);
    const diff = chunkDiff(files, { budgetTokens: profile.budgetTokens, maxChunks: profile.maxChunks });
    const intent = pr.body.trim() !== "" ? pr.body : undefined;
    const key = cacheKey(renderAll(diff), model, intent, JSON.stringify(snapshot));
    rt.log("info", `${profile.mode.label}: ${files.length} file(s), ~${diff.tokenEstimate} tokens in ${diff.chunks.length} part(s), ${diff.skippedFiles.length} not reviewed`, ctx);
    updateJob(rt, job.id, { chunks: diff.chunks.length });

    const hit = rt.db.query("SELECT result FROM cache WHERE key = ?").get(key) as { result: string } | null;
    let result: ReviewResult;
    if (hit !== null) {
      result = JSON.parse(hit.result) as ReviewResult;
      rt.log("info", "verdict from cache", ctx);
    } else {
      const settings = claudeSettingsFor(rt, credential, model);
      result = await review(
        {
          diff,
          context: { repo: job.repo, number: job.number, title: pr.title, headSha: pr.headSha, baseSha: pr.baseSha, branch: pr.headRef },
          ...(intent !== undefined ? { intent } : {}),
          profile,
        },
        {
          call: async (req, meta) => {
            const started = Date.now();
            const run = await rt.deps.callClaude(req, settings);
            if (run.limits !== undefined) recordLimits(rt, credential, run.limits);
            rt.db.query(
              `INSERT INTO runs (job_id, purpose, chunk, chunks, model, started_at, finished_at, outcome, tokens_in, tokens_out, cost_usd, error)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(job.id, meta.purpose, meta.chunk, meta.chunks, model, started, Date.now(), run.outcome, run.usage?.input ?? null, run.usage?.output ?? null, run.costUsd ?? null, run.errorMessage ?? null);
            return run;
          },
          log: (msg) => rt.log("info", msg, ctx),
          stage: (stage) => setStage(rt, job, stage),
        },
      );
    }

    const stats = {
      outcome: result.outcome,
      conclusion: result.verdict.conclusion,
      verdict_title: result.verdict.title,
      findings: result.findings.length,
      blocking: result.findings.filter((f) => isBlockingCandidate(f, result.blocking)).length,
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
    setStage(rt, job, undefined);
    if (job.item_id) {
      const item = getItemAny(rt.db, job.item_id);
      if (item) rt.bus.emit({ type: "prs", data: { item }, userId: item.user_id });
    }
  }
}
