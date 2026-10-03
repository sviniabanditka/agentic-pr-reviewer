import { githubFor, recordLimits, claudeSettingsFor } from "../accounts/service.js";
import { GitHubError, type GitHub, type PullDetails, type SearchHit } from "../github/client.js";
import { enqueueReview } from "../jobs/queue.js";
import {
  allCredentials,
  dueTargets,
  findItem,
  getAccountAny,
  getTargetAny,
  insertItem,
  itemsOfTarget,
  updateCredential,
  updateItem,
  updateTarget,
  type AccountRow,
  type ItemRow,
  type TargetFilters,
  type TargetParams,
  type TargetRow,
} from "../store/repos.js";
import type { Runtime } from "../runtime.js";

const TICK_MS = 5_000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
// ponytail: a haiku "ok" every 30 min per credential; drop the timer if even that shows in the quota.
const LIMITS_PROBE_MS = 30 * 60 * 1000;

type Role = "author" | "review_requested" | "watching";

/** What a target returns before details are fetched. */
interface Candidate {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  authorIsBot: boolean;
  updatedAt: string;
  draft: boolean;
  labels: string[];
  details?: PullDetails;
}

export function targetRole(target: Pick<TargetRow, "type" | "params_json">): Role {
  const params = JSON.parse(target.params_json) as TargetParams;
  if (params.role) return params.role;
  const q = params.query ?? "";
  if (/(user-)?review-requested:@me|team-review-requested:/.test(q)) return "review_requested";
  if (/author:@me/.test(q)) return "author";
  return "watching";
}

function combineRoles(roles: Role[]): string {
  const set = new Set(roles);
  if (set.has("author") && set.has("review_requested")) return "author+reviewer";
  if (set.has("author")) return "author";
  if (set.has("review_requested")) return "review_requested";
  return "watching";
}

export function passesFilters(c: Candidate, f: TargetFilters, role: Role): boolean {
  if (c.draft && !f.drafts) return false;
  if (c.authorIsBot && !f.bots) return false;
  const lower = (xs: string[] | undefined) => (xs ?? []).map((x) => x.toLowerCase());
  const labels = lower(c.labels);
  if (f.labelsInclude?.length && !lower(f.labelsInclude).some((l) => labels.includes(l))) return false;
  if (f.labelsExclude?.length && lower(f.labelsExclude).some((l) => labels.includes(l))) return false;
  const author = c.author.toLowerCase();
  if (f.authorsInclude?.length && !lower(f.authorsInclude).includes(author)) return false;
  if (f.authorsExclude?.length && lower(f.authorsExclude).includes(author)) return false;
  // A review request is an explicit invitation: the owner list never hides it.
  if (f.owners?.length && role !== "review_requested") {
    const owner = c.repo.split("/")[0]!.toLowerCase();
    if (!lower(f.owners).includes(owner)) return false;
  }
  if (f.maxChangedFiles && c.details && c.details.changedFiles > f.maxChangedFiles) return false;
  return true;
}

function fromSearch(h: SearchHit): Candidate {
  return { ...h };
}

function fromPull(p: PullDetails): Candidate {
  return { repo: p.repo, number: p.number, title: p.title, url: p.url, author: p.author, authorIsBot: p.authorIsBot, updatedAt: p.updatedAt, draft: p.draft, labels: p.labels, details: p };
}

async function discover(gh: GitHub, target: TargetRow): Promise<Candidate[]> {
  const params = JSON.parse(target.params_json) as TargetParams;
  if (target.type === "search") return (await gh.searchPrs(`is:open archived:false ${params.query ?? ""}`)).map(fromSearch);
  if (target.type === "repo") return (await gh.listOpenPulls(params.repo!)).map(fromPull);
  return [fromPull(await gh.pull(params.repo!, params.number!))];
}

/** Runs one target: discover, filter, upsert items, release items it no longer matches. */
export async function pollTarget(rt: Runtime, target: TargetRow): Promise<{ found: number; queued: number }> {
  const account = getAccountAny(rt.db, target.account_id);
  if (account === null) throw new Error("account removed");
  const gh = githubFor(rt, account);
  const role = targetRole(target);
  const filters = JSON.parse(target.filters_json) as TargetFilters;
  let queued = 0;
  const seen = new Set<string>();

  try {
    for (const candidate of await discover(gh, target)) {
      if (!passesFilters(candidate, filters, role)) continue;
      const { item, newRevision } = await upsertItem(rt, gh, account, target, role, candidate);
      if (item === null) continue;
      // Search hits carry no size; it is known only once details were fetched.
      if (filters.maxChangedFiles && (item.changed_files ?? 0) > filters.maxChangedFiles) continue;
      seen.add(item.id);
      if (target.automation !== "manual" && newRevision && item.state === "open") {
        const reviewed = rt.db.query("SELECT 1 FROM jobs WHERE item_id = ? AND head_sha = ? AND status != 'error'").get(item.id, item.head_sha);
        if (reviewed === null) {
          const opts = {
            ...(target.model ? { model: target.model } : {}),
            ...(target.profile_id ? { profileId: target.profile_id } : {}),
            autoPost: target.automation === "auto-post",
          };
          // A new push on a reviewed PR costs only the delta; the first review is full.
          let result = enqueueReview(rt, target.user_id, item.id, { ...opts, incremental: true }, `${target.automation}: ${target.name}`);
          if ("error" in result) result = enqueueReview(rt, target.user_id, item.id, opts, `${target.automation}: ${target.name}`);
          if ("job" in result) queued++;
        }
      }
    }
    await releaseUnmatched(rt, gh, target, seen);
    rt.githubRate.set(account.id, { ...rt.githubRate.get(account.id), core: gh.rate.get("core") ?? rt.githubRate.get(account.id)?.core, search: gh.rate.get("search") ?? rt.githubRate.get(account.id)?.search });
    updateTarget(rt.db, null, target.id, { last_polled_at: Date.now(), last_error: null, next_poll_at: Date.now() + target.poll_sec * 1000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failures = target.last_error ? 2 : 1;
    const wait = error instanceof GitHubError && (error.status === 403 || error.status === 429) && error.resetAt
      ? Math.max(error.resetAt - Date.now(), 60_000)
      : Math.min(target.poll_sec * 1000 * 2 ** failures, MAX_BACKOFF_MS);
    updateTarget(rt.db, null, target.id, { last_polled_at: Date.now(), last_error: message.slice(0, 300), next_poll_at: Date.now() + wait });
    rt.log("error", `target "${target.name}": ${message}`, { account: account.label, userId: target.user_id });
    throw error;
  } finally {
    const fresh = getTargetAny(rt.db, target.id);
    if (fresh) rt.bus.emit({ type: "status", data: { target: fresh, items: seen.size }, userId: target.user_id });
  }
  return { found: seen.size, queued };
}

async function upsertItem(rt: Runtime, gh: GitHub, account: AccountRow, target: TargetRow, role: Role, c: Candidate): Promise<{ item: ItemRow | null; newRevision: boolean }> {
  const existing = findItem(rt.db, account.id, c.repo, c.number);
  // The search hit has no head sha: details are only fetched when the PR changed.
  const needDetails = c.details === undefined && (existing === null || existing.updated_at !== c.updatedAt || existing.head_sha === null);
  const details = c.details ?? (needDetails ? await gh.pull(c.repo, c.number) : undefined);

  const targetIds = new Set<string>(existing ? (JSON.parse(existing.target_ids_json) as string[]) : []);
  targetIds.add(target.id);
  const roles = [...targetIds].map((id) => (id === target.id ? role : rolesOf(rt, id))).filter((r): r is Role => r !== null);
  const fields = {
    title: c.title,
    url: c.url,
    author: c.author,
    author_is_bot: c.authorIsBot ? 1 : 0,
    role: combineRoles(roles),
    updated_at: c.updatedAt,
    draft: c.draft ? 1 : 0,
    labels_json: JSON.stringify(c.labels),
    target_ids_json: JSON.stringify([...targetIds]),
    ...(details
      ? {
          head_sha: details.headSha,
          base_sha: details.baseSha,
          state: details.state,
          additions: details.additions,
          deletions: details.deletions,
          changed_files: details.changedFiles,
        }
      : {}),
  };

  if (existing === null) {
    const item = insertItem(rt.db, {
      user_id: account.user_id,
      account_id: account.id,
      kind: "pr",
      repo: c.repo,
      number: c.number,
      head_sha: null,
      base_sha: null,
      state: "open",
      additions: null,
      deletions: null,
      changed_files: null,
      ...fields,
    } as Parameters<typeof insertItem>[1]);
    // Reviews from before items existed (v1) join their PR.
    rt.db.query("UPDATE jobs SET item_id = ? WHERE item_id IS NULL AND account_id = ? AND repo = ? AND number = ?").run(item.id, account.id, c.repo, c.number);
    emitItem(rt, item);
    return { item, newRevision: item.head_sha !== null };
  }
  updateItem(rt.db, existing.id, { ...fields, last_seen_at: Date.now() });
  const item = rt.db.query("SELECT * FROM items WHERE id = ?").get(existing.id) as ItemRow;
  const newRevision = item.head_sha !== null && item.head_sha !== existing.head_sha;
  if (newRevision || existing.updated_at !== item.updated_at || existing.target_ids_json !== item.target_ids_json || existing.state !== item.state) emitItem(rt, item);
  return { item, newRevision };
}

function rolesOf(rt: Runtime, targetId: string): Role | null {
  const t = getTargetAny(rt.db, targetId);
  return t ? targetRole(t) : null;
}

/** Items this target found before but not now: closed, merged, or simply out of its scope. */
async function releaseUnmatched(rt: Runtime, gh: GitHub, target: TargetRow, seen: Set<string>): Promise<void> {
  for (const item of itemsOfTarget(rt.db, target.id)) {
    if (seen.has(item.id)) continue;
    const rest = (JSON.parse(item.target_ids_json) as string[]).filter((id) => id !== target.id);
    const fields: Parameters<typeof updateItem>[2] = {
      target_ids_json: JSON.stringify(rest),
      role: combineRoles(rest.map((id) => rolesOf(rt, id)).filter((r): r is Role => r !== null)),
    };
    if (rest.length === 0) {
      try {
        const details = await gh.pull(item.repo, item.number);
        fields.state = details.state === "open" ? "unmatched" : details.state;
        fields.head_sha = details.headSha;
      } catch {
        fields.state = "unmatched";
      }
    }
    updateItem(rt.db, item.id, fields);
    emitItem(rt, rt.db.query("SELECT * FROM items WHERE id = ?").get(item.id) as ItemRow);
  }
}

export function emitItem(rt: Runtime, item: ItemRow): void {
  // A pasted patch can be megabytes; the panel never needs it.
  const { patch_text: _p, ...row } = item;
  rt.bus.emit({ type: "prs", data: { item: row }, userId: item.user_id });
}

/** Polls due targets; also answers "poll now" for one target or all of a user's. */
export function startScheduler(rt: Runtime): void {
  let running: Promise<void> | undefined;

  const tick = async (force?: string): Promise<void> => {
    const targets = force === undefined
      ? dueTargets(rt.db)
      : force === "*"
        ? (rt.db.query("SELECT * FROM targets WHERE enabled = 1").all() as TargetRow[])
        : [getTargetAny(rt.db, force)].filter((t): t is TargetRow => t !== null);
    for (const target of targets) {
      await pollTarget(rt, target).catch(() => {});
    }
  };

  rt.setPollHandler(async (targetId) => {
    if (running) await running;
    running = tick(targetId ?? "*").finally(() => (running = undefined));
    return running;
  });

  const loop = async (): Promise<void> => {
    if (!running) {
      running = tick().finally(() => (running = undefined));
      await running;
    }
    setTimeout(loop, TICK_MS);
  };
  void loop();

  // Reviews refresh the limits as a side effect; the probe covers idle credentials.
  const probeLoop = async (): Promise<void> => {
    for (const credential of allCredentials(rt.db)) {
      if (credential.checked_at !== null && Date.now() - credential.checked_at < LIMITS_PROBE_MS - TICK_MS) continue;
      try {
        recordLimits(rt, credential, await rt.deps.probeLimits(claudeSettingsFor(rt, credential, "haiku")));
      } catch (error) {
        updateCredential(rt.db, null, credential.id, { status: "error", status_detail: String(error instanceof Error ? error.message : error).slice(0, 300), checked_at: Date.now() });
      }
    }
    setTimeout(probeLoop, LIMITS_PROBE_MS);
  };
  void probeLoop();
}

/** What a target would list right now, without storing anything: the editor's live preview. */
export async function previewTarget(
  rt: Runtime,
  account: AccountRow,
  draft: Pick<TargetRow, "type" | "params_json" | "filters_json">,
): Promise<{ repo: string; number: number; title: string; author: string; draft: boolean; labels: string[]; url: string }[]> {
  const gh = githubFor(rt, account);
  const role = targetRole(draft);
  const filters = JSON.parse(draft.filters_json) as TargetFilters;
  const found = await discover(gh, draft as TargetRow);
  return found
    .filter((c) => passesFilters(c, filters, role))
    .slice(0, 20)
    .map((c) => ({ repo: c.repo, number: c.number, title: c.title, author: c.author, draft: c.draft, labels: c.labels, url: c.url }));
}
