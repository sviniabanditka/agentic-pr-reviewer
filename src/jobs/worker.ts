import { claudeSettingsFor, githubFor, recordLimits } from "../accounts/service.js";
import { GitHubError } from "../github/client.js";
import { parseDiffOutput } from "../github/parse_diff.js";
import { chunkDiff, renderAll, type ChunkedDiff } from "../review/chunk.js";
import { prepareDiff, type RawPatchFile } from "../review/diff.js";
import { resolveProfile, type ProfileOptions } from "../review/modes.js";
import { cacheKey } from "../review/cache_key.js";
import { Cancelled, isInconclusive, review, type ReviewResult } from "../review/run.js";
import { verifyFindings, type VerifiedFinding } from "../review/verify.js";
import { checkVerdict, findingMarker, isBlockingCandidate } from "../verdict/verdict.js";
import { getAccountAny, getCredentialAny, getItemAny, updateItem, type AccountRow, type ItemRow } from "../store/repos.js";
import { notify } from "../outputs/notify.js";
import { publishJob } from "./publish.js";
import { emitItem } from "../scheduler/targets.js";
import { updateJob } from "./queue.js";
import type { PrContext } from "../review/context.js";
import type { Runtime } from "../runtime.js";
import type { JobRow } from "../store/types.js";

export type Stage = "diff" | "review" | "confirm";

type Job = JobRow & {
  user_id: string | null;
  account_id: string | null;
  item_id: string | null;
  profile_json: string | null;
  kind: "full" | "incremental";
  base_job_id: number | null;
  auto_post: number;
};

const FULL = { maxTokens: Number.POSITIVE_INFINITY, softThreshold: 0, hardThreshold: 0 };

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

/** Runs the next queued job (highest priority, then oldest); false when the queue is empty. */
export async function runNext(rt: Runtime): Promise<boolean> {
  const job = rt.db.query("SELECT * FROM jobs WHERE status = 'queued' ORDER BY priority DESC, id LIMIT 1").get() as Job | null;
  if (job === null) return false;
  await runJob(rt, job);
  return true;
}

interface Source {
  files: RawPatchFile[];
  context: PrContext;
  intent?: string;
  headSha: string;
}

/** Where the diff comes from: a pull request, a compare range, or a pasted patch. */
async function loadSource(rt: Runtime, job: Job, item: ItemRow | null, account: AccountRow): Promise<Source> {
  if (item?.kind === "patch") {
    return {
      files: parseDiffOutput(item.patch_text ?? ""),
      context: { repo: item.repo, number: 0, title: item.title, headSha: "patch", baseSha: "patch", branch: "patch" },
      headSha: job.head_sha,
    };
  }
  const gh = githubFor(rt, account);
  if (item?.kind === "compare") {
    return {
      files: parseDiffOutput(await gh.compareDiff(item.repo, item.compare_base!, item.compare_head!)),
      context: { repo: item.repo, number: 0, title: item.title, headSha: item.compare_head!, baseSha: item.compare_base!, branch: item.compare_head! },
      headSha: item.compare_head!,
    };
  }
  const pr = await gh.pull(job.repo, job.number);
  if (job.item_id) updateItem(rt.db, job.item_id, { head_sha: pr.headSha, base_sha: pr.baseSha, state: pr.state });
  return {
    files: parseDiffOutput(await gh.pullDiff(job.repo, job.number)),
    context: { repo: job.repo, number: job.number, title: pr.title, headSha: pr.headSha, baseSha: pr.baseSha, branch: pr.headRef },
    ...(pr.body.trim() ? { intent: pr.body } : {}),
    headSha: pr.headSha,
  };
}

async function runJob(rt: Runtime, job: Job): Promise<void> {
  const ctx = { account: job.account, jobId: job.id, ...(job.user_id ? { userId: job.user_id } : {}) };
  const startedAt = Date.now();
  const controller = new AbortController();
  rt.running.set(job.id, controller);
  updateJob(rt, job.id, { status: "running", started_at: startedAt });
  const item = job.item_id ? getItemAny(rt.db, job.item_id) : null;

  try {
    const account = job.account_id ? getAccountAny(rt.db, job.account_id) : null;
    if (account === null) throw new Error("account no longer exists");
    const credential = account.credential_id ? getCredentialAny(rt.db, account.credential_id) : null;
    if (credential === null) throw new Error(`no Claude credential attached to @${account.login}`);
    const model = job.model ?? account.model ?? rt.models()[0]!;
    // Jobs from before profiles existed ran the triage mode with defaults.
    const snapshot = job.profile_json ? (JSON.parse(job.profile_json) as { mode: string; options: ProfileOptions }) : { mode: "diff-triage", options: {} };
    const profile = resolveProfile(snapshot.mode, snapshot.options);
    rt.log("info", `reviewing ${job.repo}${job.number ? `#${job.number}` : ""} "${job.title}": ${profile.mode.label} with ${model}${job.kind === "incremental" ? ", changes since the last review" : ""}`, ctx);

    setStage(rt, job, "diff");
    const source = await loadSource(rt, job, item, account);
    if (source.headSha !== job.head_sha && item?.kind !== "patch") {
      rt.log("info", `new push since queued, reviewing @${source.headSha.slice(0, 7)}`, ctx);
      updateJob(rt, job.id, { head_sha: source.headSha });
    }
    if (source.files.length === 0) {
      updateJob(rt, job.id, { status: "skipped", error: "empty diff", finished_at: Date.now() });
      rt.log("info", "empty diff, skipped", ctx);
      return;
    }

    // Incremental: review only what changed since the last review, then carry its findings over.
    let base: { id: number; sha: string; result: ReviewResult } | null = null;
    let reviewFiles = source.files;
    if (job.kind === "incremental" && job.base_job_id && item?.kind === "pr") {
      const prev = rt.db.query("SELECT id, head_sha, result FROM jobs WHERE id = ?").get(job.base_job_id) as { id: number; head_sha: string; result: string | null } | null;
      if (prev?.result && prev.head_sha !== source.headSha) {
        try {
          reviewFiles = parseDiffOutput(await githubFor(rt, account).compareDiff(job.repo, prev.head_sha, source.headSha));
          base = { id: prev.id, sha: prev.head_sha, result: JSON.parse(prev.result) as ReviewResult };
        } catch (error) {
          // A force-push can make the old head unreachable: fall back to a full review.
          if (!(error instanceof GitHubError) || error.status !== 404) throw error;
          rt.log("warn", `the last reviewed commit is gone (force-push?); reviewing the whole pull request`, ctx);
        }
      }
    }

    const diff: ChunkedDiff = chunkDiff(reviewFiles, { budgetTokens: profile.budgetTokens, maxChunks: profile.maxChunks });
    const key = cacheKey(renderAll(diff), model, source.intent, JSON.stringify(snapshot) + (base ? `|since:${base.sha}` : ""));
    rt.log("info", `${reviewFiles.length} file(s), ~${diff.tokenEstimate} tokens in ${diff.chunks.length} part(s), ${diff.skippedFiles.length} not reviewed`, ctx);
    updateJob(rt, job.id, { chunks: diff.chunks.length });

    const hit = rt.db.query("SELECT result FROM cache WHERE key = ?").get(key) as { result: string } | null;
    let result: ReviewResult;
    if (hit !== null) {
      result = JSON.parse(hit.result) as ReviewResult;
      rt.log("info", "verdict from cache", ctx);
    } else {
      const settings = { ...claudeSettingsFor(rt, credential, model), signal: controller.signal };
      result = await review(
        { diff, context: source.context, ...(source.intent ? { intent: source.intent } : {}), profile },
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
          signal: controller.signal,
        },
      );
      if (base && !isInconclusive(result.outcome)) result = carryOver(result, base, source.files);
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
    const notice = { title: job.title, repo: job.repo, number: job.number, verdict: result.verdict.title, url: job.url };

    // No verdict is not worth a comment in someone's PR: the panel shows the error and offers a retry.
    if (isInconclusive(result.outcome)) {
      updateJob(rt, job.id, { ...stats, status: "error", error: `no verdict: ${result.errorMessage ?? result.outcome}`, finished_at: Date.now() });
      rt.log("error", `no verdict: ${result.errorMessage ?? result.outcome}`, ctx);
      if (job.user_id) void notify(rt, job.user_id, { ...notice, event: "failed", verdict: result.errorMessage ?? result.outcome });
      return;
    }
    if (hit === null) rt.db.query("INSERT OR REPLACE INTO cache (key, result, created_at) VALUES (?, ?, ?)").run(key, JSON.stringify(result), Date.now());

    // Nothing goes to GitHub here unless the target opted into auto-post.
    updateJob(rt, job.id, { ...stats, status: "done", finished_at: Date.now() });
    rt.log("info", `done in ${((Date.now() - startedAt) / 1000).toFixed(0)}s: ${result.verdict.title}${job.auto_post ? "" : "; post it from the panel"}`, ctx);
    if (job.user_id) {
      void notify(rt, job.user_id, { ...notice, event: result.verdict.conclusion === "action_required" ? "blocking" : "done" });
      if (job.auto_post && item?.kind === "pr") await publishJob(rt, job.user_id, job.id, "pr-comment", true);
    }
  } catch (error) {
    if (error instanceof Cancelled || controller.signal.aborted) {
      updateJob(rt, job.id, { status: "skipped", error: "cancelled", finished_at: Date.now() });
      rt.log("info", "cancelled while running", ctx);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    updateJob(rt, job.id, { status: "error", error: message, finished_at: Date.now() });
    rt.log("error", message, ctx);
    if (job.user_id) void notify(rt, job.user_id, { event: "failed", title: job.title, repo: job.repo, number: job.number, verdict: message, url: job.url });
  } finally {
    rt.running.delete(job.id);
    setStage(rt, job, undefined);
    if (item) {
      const fresh = getItemAny(rt.db, item.id);
      if (fresh) emitItem(rt, fresh);
    }
  }
}

/**
 * Merges an incremental review with the review it builds on: earlier findings whose quoted
 * code is still in the pull request stay open, the rest are fixed; new findings are marked.
 */
export function carryOver(delta: ReviewResult, base: { id: number; sha: string; result: ReviewResult }, fullFiles: RawPatchFile[]): ReviewResult {
  const full = prepareDiff(fullFiles, FULL);
  const paths = new Set(full.files.map((f) => f.path));
  const fresh = new Set(delta.findings.map(findingMarker));
  const baseConfirmed = new Set(base.result.confirmedMarkers);
  const stillOpen: VerifiedFinding[] = [];
  const fixed: VerifiedFinding[] = [];
  for (const old of base.result.findings) {
    const marker = findingMarker(old);
    if (fresh.has(marker)) continue;
    const [again] = verifyFindings([old], full);
    const open = old.evidence_kind === "absent" ? paths.has(old.file) : again!.evidenceCheck === "matched";
    (open ? stillOpen : fixed).push({ ...old, state: "still_open" as const });
  }
  const findings = [...delta.findings.map((f) => ({ ...f, state: "new" as const })), ...stillOpen];
  const confirmedMarkers = [...new Set([...delta.confirmedMarkers, ...stillOpen.map(findingMarker).filter((m) => baseConfirmed.has(m))])];
  const outcome = findings.length > 0 ? "findings" : "no_findings";
  return {
    ...delta,
    outcome,
    findings,
    confirmedMarkers,
    verdict: checkVerdict(outcome, delta.confirmationOutcome, confirmedMarkers.length),
    incremental: { baseJobId: base.id, baseSha: base.sha, fixed: fixed.map(({ state: _s, ...f }) => f) },
  };
}
