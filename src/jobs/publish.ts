import { githubFor } from "../accounts/service.js";
import { COMMENT_MARKER, renderComment, renderInline } from "../github/comment.js";
import { parseDiffOutput } from "../github/parse_diff.js";
import { prepareDiff } from "../review/diff.js";
import { applyDismissals, dismissedMarkers } from "../review/dismissals.js";
import { findItem, getAccountAny, getItemAny, updateItem } from "../store/repos.js";
import { audit } from "../audit.js";
import { notify } from "../outputs/notify.js";
import { emitJob, updateJob } from "./queue.js";
import type { ReviewResult } from "../review/run.js";
import type { Runtime } from "../runtime.js";
import type { JobRow } from "../store/types.js";

export type Output = "pr-comment" | "pr-review";
const publishing = new Set<number>();

/**
 * Puts a finished review on its pull request: the marked comment (created or edited), or a
 * GitHub review with inline comments. The only path that writes to GitHub; it runs on a
 * person's request, or for a target the person set to auto-post.
 */
export async function publishJob(rt: Runtime, userId: string, id: number, output: Output = "pr-comment", auto = false): Promise<{ url: string } | { error: string }> {
  const job = rt.db.query("SELECT * FROM jobs WHERE id = ? AND user_id = ?").get(id, userId) as
    | (JobRow & { result: string | null; account_id: string | null; item_id: string | null })
    | null;
  if (job === null) return { error: "no such review" };
  if (job.status !== "done" || job.result === null) return { error: "only a finished review can be posted" };
  const item = job.item_id ? getItemAny(rt.db, job.item_id) : null;
  if (item && item.kind !== "pr") return { error: "only pull request reviews can be posted to GitHub; export this one instead" };
  const account = job.account_id ? getAccountAny(rt.db, job.account_id) : null;
  if (account === null) return { error: "the account of this review was removed" };
  if (publishing.has(id)) return { error: "already posting this review" };

  publishing.add(id);
  const ctx = { account: account.label, jobId: id, userId };
  try {
    const result = applyDismissals(JSON.parse(job.result) as ReviewResult, dismissedMarkers(rt.db, job.item_id));
    const meta = { repo: job.repo, headSha: job.head_sha, model: job.model ?? account.model ?? "claude", elapsedMs: (job.finished_at ?? 0) - (job.started_at ?? 0) };
    const gh = githubFor(rt, account);
    let url: string;
    if (output === "pr-review") {
      // Inline comments only where GitHub will accept them: a new-side line inside the diff.
      const diff = prepareDiff(parseDiffOutput(await gh.pullDiff(job.repo, job.number)), { maxTokens: Number.POSITIVE_INFINITY, softThreshold: 0, hardThreshold: 0 });
      const lines = new Map(diff.files.map((f) => [f.path, new Set(f.newLines.map((l) => l.line))]));
      const posted = await gh.createReview(job.repo, job.number, job.head_sha, renderComment(result, meta), renderInline(result, (path, line) => lines.get(path)?.has(line) ?? false));
      url = posted.url;
      audit(rt, userId, auto ? "auto_post" : "post_review", `${job.repo}#${job.number}`, { review: id, url }, account.id);
    } else {
      const known = item ?? findItem(rt.db, account.id, job.repo, job.number);
      const comment = await gh.upsertComment(job.repo, job.number, account.login, COMMENT_MARKER, renderComment(result, meta), known?.comment_id ?? null);
      if (known) updateItem(rt.db, known.id, { comment_id: comment.id });
      // One comment per PR: the reviews posted before this one no longer point at what it says.
      const superseded = rt.db
        .query("UPDATE jobs SET comment_url = NULL WHERE account_id = ? AND repo = ? AND number = ? AND id != ? AND comment_url IS NOT NULL RETURNING *")
        .all(account.id, job.repo, job.number, id) as (JobRow & { result?: string; user_id?: string })[];
      for (const row of superseded) emitJob(rt, row);
      url = comment.url;
      audit(rt, userId, auto ? "auto_post" : "post_comment", `${job.repo}#${job.number}`, { review: id, url }, account.id);
    }
    updateJob(rt, id, { comment_url: url });
    rt.db.query("INSERT INTO outputs (job_id, user_id, type, status, external_url, created_at) VALUES (?, ?, ?, 'sent', ?, ?)").run(id, userId, output, url, Date.now());
    rt.log("info", `${auto ? "auto-" : ""}posted ${output === "pr-review" ? "a review" : "the comment"} to ${job.repo}#${job.number} → ${url}`, ctx);
    void notify(rt, userId, { event: "posted", title: job.title, repo: job.repo, number: job.number, verdict: result.verdict.title, url: job.url, commentUrl: url });
    return { url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rt.db.query("INSERT INTO outputs (job_id, user_id, type, status, error, created_at) VALUES (?, ?, ?, 'failed', ?, ?)").run(id, userId, output, message.slice(0, 500), Date.now());
    rt.log("error", `posting failed: ${message}`, ctx);
    return { error: message };
  } finally {
    publishing.delete(id);
  }
}
