import { getAccountAny, getItem, getProfile } from "../store/repos.js";
import { defaultProfile, resolveRow } from "../review/profiles.js";
import type { Runtime } from "../runtime.js";
import type { JobRow } from "../store/types.js";

export type Queued = { job: JobRow } | { error: string };

/**
 * Queues a review of one of the user's items. The item must already exist (found by a
 * target or added by URL), so a review can never be started for an arbitrary repository.
 */
export interface EnqueueOptions {
  model?: string;
  profileId?: string;
  /** Review only what changed since the last finished review of the item. */
  incremental?: boolean;
  /** Post the comment as soon as the review is done (targets with auto-post only). */
  autoPost?: boolean;
}

/** Manual reviews jump ahead of what targets queued on their own. */
const PRIORITY = { manual: 10, auto: 0 };

export function enqueueReview(rt: Runtime, userId: string, itemId: string, opts: EnqueueOptions = {}, source = "panel"): Queued {
  const item = getItem(rt.db, userId, itemId);
  if (item === null) return { error: "no such pull request" };
  if (item.head_sha === null) return { error: "the pull request has not been fetched yet; refresh and retry" };
  const account = getAccountAny(rt.db, item.account_id);
  if (account === null) return { error: "the account of this pull request was removed" };
  if (account.credential_id === null) return { error: `no Claude credential attached to @${account.login}` };
  const profileId = opts.profileId ?? account.profile_id ?? null;
  const profile = profileId ? getProfile(rt.db, userId, profileId) : defaultProfile(rt.db, userId);
  if (profile === null) return { error: "no such profile" };
  const resolved = resolveRow(profile);
  const model = opts.model ?? resolved.model ?? account.model ?? rt.models()[0]!;
  if (!rt.models().includes(model)) return { error: `model ${model} is not allowed` };

  const active = rt.db.query("SELECT id FROM jobs WHERE item_id = ? AND status IN ('queued', 'running')").get(item.id);
  if (active !== null) return { error: "a review of this pull request is already queued or running" };

  let baseJobId: number | null = null;
  if (opts.incremental) {
    if (item.kind !== "pr") return { error: "only a pull request can be reviewed incrementally" };
    const base = rt.db
      .query("SELECT id, head_sha FROM jobs WHERE item_id = ? AND status = 'done' AND result IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(item.id) as { id: number; head_sha: string } | null;
    if (base === null) return { error: "nothing to compare with: no finished review of this pull request yet" };
    if (base.head_sha === item.head_sha) return { error: "no new commits since the last review" };
    baseJobId = base.id;
  }
  const auto = source !== "panel";

  const job = rt.db
    .query(
      `INSERT INTO jobs (user_id, account_id, item_id, account, repo, number, title, url, role, head_sha, model, status, created_at,
         profile_id, profile_name, profile_json, mode, kind, base_job_id, priority, auto_post)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(userId, account.id, item.id, account.label, item.repo, item.number, item.title, item.url, item.role, item.head_sha, model, Date.now(),
      profile.id, profile.name, JSON.stringify({ mode: profile.mode, options: JSON.parse(profile.options_json), version: profile.version }), profile.mode,
      baseJobId ? "incremental" : "full", baseJobId, auto ? PRIORITY.auto : PRIORITY.manual, opts.autoPost && item.kind === "pr" ? 1 : 0) as JobRow;
  const ref = item.kind === "pr" ? `${item.repo}#${item.number}` : `${item.repo} ${item.title}`;
  rt.log("info", `queued ${ref} @${item.head_sha.slice(0, 7)}: ${profile.name} with ${model}${baseJobId ? ", incremental" : ""} (${source})`, { account: account.label, jobId: job.id, userId });
  emitJob(rt, job);
  rt.kickWorker();
  return { job };
}

/** A queued job is dropped; a running one has its model process killed by the worker. */
export function cancelJob(rt: Runtime, userId: string, id: number): JobRow | null {
  const running = rt.db.query("SELECT * FROM jobs WHERE id = ? AND user_id = ? AND status = 'running'").get(id, userId) as JobRow | null;
  if (running !== null) {
    rt.running.get(id)?.abort();
    return running;
  }
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
