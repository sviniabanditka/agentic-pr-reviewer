import { githubFor } from "../accounts/service.js";
import { COMMENT_MARKER, renderComment } from "../github/comment.js";
import { findItem, getAccountAny, getItemAny, updateItem } from "../store/repos.js";
import { emitJob, updateJob } from "./queue.js";
import type { ReviewResult } from "../review/run.js";
import type { Runtime } from "../runtime.js";
import type { JobRow } from "../store/types.js";

const publishing = new Set<number>();

/**
 * Posts a finished review as the PR comment, or edits the one this account already
 * has there. The only path that writes to GitHub, and it runs only on request.
 */
export async function publishJob(rt: Runtime, userId: string, id: number): Promise<{ url: string } | { error: string }> {
  const job = rt.db.query("SELECT * FROM jobs WHERE id = ? AND user_id = ?").get(id, userId) as
    | (JobRow & { result: string | null; account_id: string | null; item_id: string | null })
    | null;
  if (job === null) return { error: "no such review" };
  if (job.status !== "done" || job.result === null) return { error: "only a finished review can be posted" };
  const account = job.account_id ? getAccountAny(rt.db, job.account_id) : null;
  if (account === null) return { error: "the account of this review was removed" };
  if (publishing.has(id)) return { error: "already posting this review" };

  publishing.add(id);
  const ctx = { account: account.label, jobId: id, userId };
  try {
    const result = JSON.parse(job.result) as ReviewResult;
    const body = renderComment(result, {
      repo: job.repo,
      headSha: job.head_sha,
      model: job.model ?? account.model ?? "claude",
      elapsedMs: (job.finished_at ?? 0) - (job.started_at ?? 0),
    });
    const item = job.item_id ? getItemAny(rt.db, job.item_id) : findItem(rt.db, account.id, job.repo, job.number);
    const comment = await githubFor(rt, account).upsertComment(job.repo, job.number, account.login, COMMENT_MARKER, body, item?.comment_id ?? null);
    if (item) updateItem(rt.db, item.id, { comment_id: comment.id });
    // One comment per PR: the reviews posted before this one no longer point at what it says.
    const superseded = rt.db
      .query("UPDATE jobs SET comment_url = NULL WHERE account_id = ? AND repo = ? AND number = ? AND id != ? AND comment_url IS NOT NULL RETURNING *")
      .all(account.id, job.repo, job.number, id) as (JobRow & { result?: string; user_id?: string })[];
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
