import { upsertComment } from "../github/gh.js";
import { COMMENT_MARKER, renderComment } from "../github/comment.js";
import { emitJob, updateJob } from "./queue.js";
import type { ReviewResult } from "../review/run.js";
import type { Runtime } from "../runtime.js";
import type { JobRow, PrRow } from "../store/types.js";

const publishing = new Set<number>();

/**
 * Posts a finished review as the PR comment, or edits the one this account already
 * has there. The only path that writes to GitHub, and it runs only on request.
 */
export async function publishJob(rt: Runtime, id: number): Promise<{ url: string } | { error: string }> {
  const job = rt.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as (JobRow & { result: string | null }) | null;
  if (job === null) return { error: "no such review" };
  if (job.status !== "done" || job.result === null) return { error: "only a finished review can be posted" };
  const account = rt.cfg.accounts.find((a) => a.name === job.account);
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
    const prRow = rt.db
      .query("SELECT * FROM prs WHERE account = ? AND repo = ? AND number = ?")
      .get(account.name, job.repo, job.number) as PrRow | null;
    const comment = await upsertComment(account.githubToken, job.repo, job.number, account.login, COMMENT_MARKER, body, prRow?.comment_id ?? null);
    rt.db.query("UPDATE prs SET comment_id = ? WHERE account = ? AND repo = ? AND number = ?").run(comment.id, account.name, job.repo, job.number);
    // One comment per PR: the reviews posted before this one no longer point at what it says.
    const superseded = rt.db
      .query("UPDATE jobs SET comment_url = NULL WHERE account = ? AND repo = ? AND number = ? AND id != ? AND comment_url IS NOT NULL RETURNING *")
      .all(account.name, job.repo, job.number, id) as (JobRow & { result?: string })[];
    for (const row of superseded) emitJob(rt, row);
    updateJob(rt, id, { comment_url: comment.url });
    rt.log("info", `posted to ${job.repo}#${job.number} → ${comment.url}`, ctx);
    return { url: comment.url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rt.log("error", `posting failed: ${message}`, ctx);
    return { error: message };
  } finally {
    publishing.delete(id);
  }
}
