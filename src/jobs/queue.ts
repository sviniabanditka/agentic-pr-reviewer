import { getAccountAny, getItem } from "../store/repos.js";
import type { Runtime } from "../runtime.js";
import type { JobRow } from "../store/types.js";

export type Queued = { job: JobRow } | { error: string };

/**
 * Queues a review of one of the user's items. The item must already exist (found by a
 * target or added by URL), so a review can never be started for an arbitrary repository.
 */
export function enqueueReview(rt: Runtime, userId: string, itemId: string, requestedModel?: string, source = "panel"): Queued {
  const item = getItem(rt.db, userId, itemId);
  if (item === null) return { error: "no such pull request" };
  if (item.head_sha === null) return { error: "the pull request has not been fetched yet; refresh and retry" };
  const account = getAccountAny(rt.db, item.account_id);
  if (account === null) return { error: "the account of this pull request was removed" };
  if (account.credential_id === null) return { error: `no Claude credential attached to @${account.login}` };
  const model = requestedModel ?? account.model ?? rt.models()[0]!;
  if (!rt.models().includes(model)) return { error: `model ${model} is not allowed` };

  const active = rt.db.query("SELECT id FROM jobs WHERE item_id = ? AND status IN ('queued', 'running')").get(item.id);
  if (active !== null) return { error: "a review of this pull request is already queued or running" };

  const job = rt.db
    .query(
      `INSERT INTO jobs (user_id, account_id, item_id, account, repo, number, title, url, role, head_sha, model, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?) RETURNING *`,
    )
    .get(userId, account.id, item.id, account.label, item.repo, item.number, item.title, item.url, item.role, item.head_sha, model, Date.now()) as JobRow;
  rt.log("info", `queued ${item.repo}#${item.number} @${item.head_sha.slice(0, 7)} with ${model} (${source})`, { account: account.label, jobId: job.id, userId });
  emitJob(rt, job);
  rt.kickWorker();
  return { job };
}

/** Only a queued job can be cancelled; a running one has already spent its model run. */
export function cancelJob(rt: Runtime, userId: string, id: number): JobRow | null {
  const job = rt.db
    .query("UPDATE jobs SET status = 'skipped', error = 'cancelled', finished_at = ? WHERE id = ? AND user_id = ? AND status = 'queued' RETURNING *")
    .get(Date.now(), id, userId) as (JobRow & { result?: string; user_id: string }) | null;
  if (job === null) return null;
  rt.log("info", `cancelled ${job.repo}#${job.number}`, { account: job.account, jobId: id, userId });
  emitJob(rt, job);
  return job;
}

type JobUpdate = Partial<Omit<JobRow, "id">> & { result?: string };

/** Updates a job and tells the owner's open panels; the stored result never goes over the wire. */
export function updateJob(rt: Runtime, id: number, fields: JobUpdate): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const values = Object.values(fields) as (string | number | null)[];
  const row = rt.db
    .query(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ? RETURNING *`)
    .get(...values, id) as (JobRow & { result?: string }) | null;
  if (row !== null) emitJob(rt, row);
}

export function emitJob(rt: Runtime, row: JobRow & { result?: string | null; user_id?: string | null }): void {
  const { result: _result, ...summary } = row;
  rt.bus.emit({ type: "job", data: summary, ...(row.user_id ? { userId: row.user_id } : {}) });
}
