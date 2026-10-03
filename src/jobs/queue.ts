import type { Runtime } from "../runtime.js";
import type { JobRow } from "../store/types.js";

/**
 * Queues a review the person asked for in the panel. Only PRs from the latest poll
 * qualify: the panel cannot be used to comment on an arbitrary repository.
 */
export function enqueueReview(
  rt: Runtime,
  accountName: string,
  repo: string,
  number: number,
  requestedModel?: string,
): { job: JobRow } | { error: string } {
  const account = rt.cfg.accounts.find((a) => a.name === accountName);
  if (account === undefined) return { error: "unknown account" };
  if (account.claudeToken === undefined) return { error: "no Claude token for this account" };
  const model = requestedModel ?? account.model;
  if (!rt.cfg.models.includes(model)) return { error: `model ${model} is not allowed` };

  const pr = rt.openPrs.get(accountName)?.find((p) => p.repo === repo && p.number === number);
  if (pr === undefined) return { error: "PR is not in the open list; refresh and retry" };

  const active = rt.db
    .query("SELECT id FROM jobs WHERE account = ? AND repo = ? AND number = ? AND status IN ('queued', 'running')")
    .get(accountName, repo, number);
  if (active !== null) return { error: "a review of this PR is already queued or running" };

  const job = rt.db
    .query(
      `INSERT INTO jobs (account, repo, number, title, url, role, head_sha, model, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?) RETURNING *`,
    )
    .get(accountName, repo, number, pr.title, pr.url, pr.role, pr.headSha, model, Date.now()) as JobRow;
  rt.log("info", `queued ${repo}#${number} @${pr.headSha.slice(0, 7)} with ${model} from the panel`, { account: accountName, jobId: job.id });
  rt.bus.emit({ type: "job", data: job });
  rt.kickWorker();
  return { job };
}

/** Only a queued job can be cancelled; a running one has already spent its model run. */
export function cancelJob(rt: Runtime, id: number): JobRow | null {
  const job = rt.db
    .query("UPDATE jobs SET status = 'skipped', error = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued' RETURNING *")
    .get(Date.now(), id) as (JobRow & { result?: string }) | null;
  if (job === null) return null;
  rt.log("info", `cancelled ${job.repo}#${job.number}`, { account: job.account, jobId: id });
  emitJob(rt, job);
  return job;
}

type JobUpdate = Partial<Omit<JobRow, "id">> & { result?: string };

/** Updates a job and tells every open panel; the stored result JSON never goes over the wire. */
export function updateJob(rt: Runtime, id: number, fields: JobUpdate): void {
  const keys = Object.keys(fields);
  const values = Object.values(fields) as (string | number | null)[];
  const row = rt.db
    .query(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ? RETURNING *`)
    .get(...values, id) as (JobRow & { result?: string }) | null;
  if (row !== null) emitJob(rt, row);
}

export function emitJob(rt: Runtime, row: JobRow & { result?: string | null }): void {
  const { result: _result, ...summary } = row;
  rt.bus.emit({ type: "job", data: summary });
}
