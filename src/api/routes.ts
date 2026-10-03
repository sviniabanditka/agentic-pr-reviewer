import { Hono, type Context } from "hono";
import { Type, type TSchema, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  addAccount,
  addCredential,
  checkAccount,
  checkCredential,
  InputError,
  PROVIDERS,
  publicAccount,
  publicCredential,
  replaceAccountToken,
} from "../accounts/service.js";
import { githubFor } from "../accounts/service.js";
import { parsePrRef } from "../github/client.js";
import { parseDiffOutput } from "../github/parse_diff.js";
import { chunkDiff, renderChunk } from "../review/chunk.js";
import { buildUserMessage } from "../review/prompt.js";
import { CATEGORY_TEXT, MODES, resolveProfile, systemPrompt, type ProfileOptions } from "../review/modes.js";
import { ensureProfiles, resolveRow } from "../review/profiles.js";
import { MODEL_CATALOG } from "../providers/index.js";
import { cancelJob, enqueueReview } from "../jobs/queue.js";
import { publishJob } from "../jobs/publish.js";
import { startDeviceLogin, pollDeviceLogin } from "../accounts/device.js";
import { audit } from "../audit.js";
import { renderMarkdown } from "../github/comment.js";
import { addChannel, listChannels, notify, NOTIFY_EVENTS, publicChannel, type NotifyEvent } from "../outputs/notify.js";
import { applyDismissals, dismissedMarkers } from "../review/dismissals.js";
import { findingMarker } from "../verdict/verdict.js";
import { DEFAULT_RETENTION_DAYS } from "../store/db.js";
import type { ReviewResult } from "../review/run.js";
import { emitItem, pollTarget, previewTarget } from "../scheduler/targets.js";
import { deleteSecret } from "../store/secrets.js";
import {
  deleteAccount,
  deleteCredential,
  deleteProfile,
  getProfile,
  insertProfile,
  setDefaultProfile,
  updateProfile,
  type ProfileRow,
  deleteTarget,
  findItem,
  getAccount,
  getCredential,
  getItem,
  getSetting,
  getTarget,
  insertItem,
  insertTarget,
  listAccounts,
  listCredentials,
  listItems,
  listTargets,
  setSetting,
  updateAccount,
  updateCredential,
  updateItem,
  updateTarget,
  type ItemRow,
  type TargetRow,
} from "../store/repos.js";
import type { PublicUser } from "../auth/auth.js";
import type { Runtime } from "../runtime.js";
import type { EventRow, JobRow } from "../store/types.js";

type Env = { Variables: { user: PublicUser } };

const JOB_COLUMNS =
  "id, item_id, account_id, account, repo, number, title, url, role, head_sha, status, created_at, started_at, finished_at, outcome, conclusion, verdict_title, findings, blocking, confirmed, runs, tokens_in, tokens_out, cost_usd, model, cached, comment_url, error, profile_id, profile_name, mode, chunks, kind, base_job_id, priority, auto_post";

const ProfileOptionsSchema = Type.Object({
  model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  confirmation: Type.Optional(Type.Union([Type.Literal("never"), Type.Literal("blocking")])),
  categories: Type.Optional(Type.Array(Type.String())),
  blocking: Type.Optional(Type.Array(Type.String())),
  budgetTokens: Type.Optional(Type.Number({ minimum: 4000, maximum: 150000 })),
  maxChunks: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
  intent: Type.Optional(Type.Union([Type.Literal("pr-body"), Type.Literal("none")])),
  instructions: Type.Optional(Type.String({ maxLength: 8000 })),
  customCategories: Type.Optional(Type.Array(Type.Object({ id: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9-]{1,30}$" }), description: Type.String({ minLength: 3, maxLength: 1000 }) }), { maxItems: 20 })),
});

function profileView(p: ProfileRow) {
  const options = JSON.parse(p.options_json) as ProfileOptions;
  const resolved = resolveProfile(p.mode, options);
  return {
    id: p.id, name: p.name, mode: p.mode, options, version: p.version, isDefault: p.is_default === 1, updatedAt: p.updated_at,
    resolved: { categories: resolved.categories.map((c) => c.id), blocking: resolved.blocking, confirmation: resolved.confirmation, budgetTokens: resolved.budgetTokens, maxChunks: resolved.maxChunks },
  };
}

async function body<S extends TSchema>(c: Context, schema: S): Promise<Static<S> | Response> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  if (!Value.Check(schema, raw)) {
    const first = [...Value.Errors(schema, raw)][0];
    return c.json({ error: `invalid body${first ? ` at ${first.instancePath || "/"}: ${first.message}` : ""}` }, 400);
  }
  return raw;
}

function fail(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ error: message }, error instanceof InputError ? 400 : 500);
}

const FiltersSchema = Type.Object({
  drafts: Type.Optional(Type.Boolean()),
  bots: Type.Optional(Type.Boolean()),
  labelsInclude: Type.Optional(Type.Array(Type.String())),
  labelsExclude: Type.Optional(Type.Array(Type.String())),
  authorsInclude: Type.Optional(Type.Array(Type.String())),
  authorsExclude: Type.Optional(Type.Array(Type.String())),
  owners: Type.Optional(Type.Array(Type.String())),
  maxChangedFiles: Type.Optional(Type.Number({ minimum: 1 })),
});
const ParamsSchema = Type.Object({
  query: Type.Optional(Type.String({ maxLength: 500 })),
  repo: Type.Optional(Type.String({ pattern: "^[\\w.-]+/[\\w.-]+$" })),
  number: Type.Optional(Type.Number({ minimum: 1 })),
  role: Type.Optional(Type.Union([Type.Literal("author"), Type.Literal("review_requested"), Type.Literal("watching")])),
});
const TargetSchema = Type.Object({
  accountId: Type.String(),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  type: Type.Union([Type.Literal("search"), Type.Literal("repo"), Type.Literal("pr")]),
  params: ParamsSchema,
  filters: Type.Optional(FiltersSchema),
  automation: Type.Optional(Type.Union([Type.Literal("manual"), Type.Literal("auto-review"), Type.Literal("auto-post")])),
  /** Turning auto-post on: the account's login, typed by the person, so it is never a misclick. */
  confirmLogin: Type.Optional(Type.String()),
  model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  profileId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  pollSec: Type.Optional(Type.Number({ minimum: 30, maximum: 86400 })),
  enabled: Type.Optional(Type.Boolean()),
});

function validTargetParams(type: string, params: Static<typeof ParamsSchema>): string | null {
  if (type === "search" && !params.query?.trim()) return "a search target needs a query";
  if (type === "repo" && !params.repo) return "a repo target needs owner/name";
  if (type === "pr" && (!params.repo || !params.number)) return "a pull request target needs repo and number";
  return null;
}

export function targetView(rt: Runtime, t: TargetRow) {
  const count = rt.db.query("SELECT COUNT(*) AS n FROM items, json_each(items.target_ids_json) x WHERE x.value = ? AND items.state = 'open'").get(t.id) as { n: number };
  return {
    id: t.id,
    accountId: t.account_id,
    name: t.name,
    type: t.type,
    params: JSON.parse(t.params_json),
    filters: JSON.parse(t.filters_json),
    automation: t.automation,
    model: t.model,
    pollSec: t.poll_sec,
    enabled: t.enabled === 1,
    profileId: t.profile_id,
    lastPolledAt: t.last_polled_at,
    lastError: t.last_error,
    nextPollAt: t.next_poll_at,
    openItems: count.n,
  };
}

export function itemView(i: ItemRow, lastReview: JobRow | null = null) {
  return {
    id: i.id,
    accountId: i.account_id,
    kind: i.kind,
    compareBase: i.compare_base,
    compareHead: i.compare_head,
    repo: i.repo,
    number: i.number,
    title: i.title,
    url: i.url,
    author: i.author,
    authorIsBot: i.author_is_bot === 1,
    role: i.role,
    headSha: i.head_sha,
    state: i.state,
    draft: i.draft === 1,
    labels: JSON.parse(i.labels_json) as string[],
    additions: i.additions,
    deletions: i.deletions,
    changedFiles: i.changed_files,
    updatedAt: i.updated_at,
    targetIds: JSON.parse(i.target_ids_json) as string[],
    firstSeenAt: i.first_seen_at,
    lastSeenAt: i.last_seen_at,
    lastReview,
  };
}

function lastReviews(rt: Runtime, userId: string): Map<string, JobRow> {
  const rows = rt.db
    .query(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id IN (SELECT MAX(id) FROM jobs WHERE user_id = ? AND item_id IS NOT NULL GROUP BY item_id)`)
    .all(userId) as (JobRow & { item_id: string })[];
  return new Map(rows.map((r) => [r.item_id, r]));
}

export function apiRoutes(rt: Runtime): Hono<Env> {
  const api = new Hono<Env>();

  // ── overview ─────────────────────────────────────────────────────
  api.get("/state", (c) => {
    const user = c.var.user;
    return c.json({
      user,
      startedAt: rt.startedAt,
      models: rt.models(),
      providers: PROVIDERS,
      accounts: listAccounts(rt.db, user.id).map((a) => publicAccount(rt, a)),
      credentials: listCredentials(rt.db, user.id).map(publicCredential),
      targets: listTargets(rt.db, user.id).map((t) => targetView(rt, t)),
      profiles: ensureProfiles(rt.db, user.id).map(profileView),
      modes: Object.values(MODES).map((m) => ({ id: m.id, label: m.label, description: m.description, output: m.output, categories: m.categories, blocking: m.blocking, confirmation: m.confirmation })),
      categoryText: CATEGORY_TEXT,
      catalog: MODEL_CATALOG,
      stages: Object.fromEntries([...rt.stages].filter(([id]) => (rt.db.query("SELECT 1 FROM jobs WHERE id = ? AND user_id = ?").get(id, user.id) !== null))),
      totals: rt.db
        .query(
          `SELECT COUNT(*) AS reviews, COALESCE(SUM(runs), 0) AS runs, COALESCE(SUM(tokens_in), 0) AS tokens_in,
                  COALESCE(SUM(tokens_out), 0) AS tokens_out, COALESCE(SUM(cost_usd), 0) AS cost_usd
           FROM jobs WHERE user_id = ? AND status = 'done' AND finished_at > ?`,
        )
        .get(user.id, Date.now() - 24 * 60 * 60 * 1000),
    });
  });

  // ── items ────────────────────────────────────────────────────────
  api.get("/items", (c) => {
    const state = c.req.query("state");
    const rows = listItems(rt.db, c.var.user.id, {
      ...(state !== "all" ? { state: state ?? "open" } : {}),
      ...(c.req.query("accountId") ? { accountId: c.req.query("accountId")! } : {}),
      ...(c.req.query("targetId") ? { targetId: c.req.query("targetId")! } : {}),
    });
    const last = lastReviews(rt, c.var.user.id);
    return c.json({ items: rows.map((i) => itemView(i, last.get(i.id) ?? null)) });
  });

  api.get("/items/:id", (c) => {
    const item = getItem(rt.db, c.var.user.id, c.req.param("id"));
    if (item === null) return c.json({ error: "not found" }, 404);
    const reviews = rt.db.query(`SELECT ${JOB_COLUMNS} FROM jobs WHERE item_id = ? ORDER BY id DESC LIMIT 50`).all(item.id) as JobRow[];
    return c.json({ item: itemView(item, reviews[0] ?? null), reviews });
  });

  api.post("/items", async (c) => {
    const b = await body(c, Type.Union([
      Type.Object({ accountId: Type.String(), url: Type.String() }),
      Type.Object({ accountId: Type.String(), kind: Type.Literal("compare"), repo: Type.String({ pattern: "^[\\w.-]+/[\\w.-]+$" }), base: Type.String({ minLength: 1, maxLength: 200 }), head: Type.String({ minLength: 1, maxLength: 200 }) }),
      Type.Object({ accountId: Type.String(), kind: Type.Literal("patch"), title: Type.String({ minLength: 1, maxLength: 200 }), patch: Type.String({ minLength: 1, maxLength: 2_000_000 }), repo: Type.Optional(Type.String({ maxLength: 200 })) }),
    ]));
    if (b instanceof Response) return b;
    const account = getAccount(rt.db, c.var.user.id, b.accountId);
    if (account === null) return c.json({ error: "no such account" }, 404);
    if ("kind" in b) return addOtherItem(c, account, b);
    const ref = parsePrRef(b.url);
    if (ref === null) return c.json({ error: "expected a pull request URL or owner/repo#number" }, 400);
    const existing = findItem(rt.db, account.id, ref.repo, ref.number);
    if (existing && existing.state !== "archived") return c.json({ item: itemView(existing) });
    const target = insertTarget(rt.db, {
      user_id: c.var.user.id, account_id: account.id, name: `${ref.repo}#${ref.number}`, type: "pr",
      params: { repo: ref.repo, number: ref.number, role: "watching" }, filters: { drafts: true, bots: true }, poll_sec: 300,
    });
    try {
      await pollTarget(rt, target);
    } catch (error) {
      deleteTarget(rt.db, c.var.user.id, target.id);
      return fail(c, new InputError(`could not read ${ref.repo}#${ref.number}: ${error instanceof Error ? error.message : error}`));
    }
    const item = findItem(rt.db, account.id, ref.repo, ref.number);
    return item ? c.json({ item: itemView(item) }, 201) : c.json({ error: "not found" }, 404);
  });

  /** A compare range or a pasted patch: reviewed and exported like a PR, never posted. */
  async function addOtherItem(
    c: Context<Env>,
    account: { id: string },
    b: { kind: "compare"; repo: string; base: string; head: string } | { kind: "patch"; title: string; patch: string; repo?: string },
  ): Promise<Response> {
    const common = {
      user_id: c.var.user.id, account_id: account.id, number: 0, author: c.var.user.login, author_is_bot: 0, role: "watching", base_sha: null,
      updated_at: new Date().toISOString(), state: "open", draft: 0, labels_json: "[]", additions: null, deletions: null, changed_files: null, target_ids_json: "[]",
    };
    if (b.kind === "patch") {
      const files = parseDiffOutput(b.patch);
      if (files.length === 0) return c.json({ error: "that is not a unified diff (expected `diff --git` headers)" }, 400);
      const hash = new Bun.CryptoHasher("sha256").update(b.patch).digest("hex");
      const existing = rt.db.query("SELECT * FROM items WHERE account_id = ? AND kind = 'patch' AND ref_key = ?").get(account.id, hash) as ItemRow | null;
      if (existing) return c.json({ item: itemView(existing) });
      const item = insertItem(rt.db, { ...common, kind: "patch", repo: b.repo?.trim() || "patch", title: b.title, url: "", head_sha: hash.slice(0, 40), ref_key: hash, patch_text: b.patch, changed_files: files.length });
      emitItem(rt, item);
      return c.json({ item: itemView(item) }, 201);
    }
    const ref = `${b.base}...${b.head}`;
    const existing = rt.db.query("SELECT * FROM items WHERE account_id = ? AND kind = 'compare' AND repo = ? AND ref_key = ?").get(account.id, b.repo, ref) as ItemRow | null;
    if (existing && existing.state !== "archived") return c.json({ item: itemView(existing) });
    try {
      const files = parseDiffOutput(await githubFor(rt, getAccount(rt.db, c.var.user.id, account.id)!).compareDiff(b.repo, b.base, b.head));
      if (existing) {
        updateItem(rt.db, existing.id, { state: "open", changed_files: files.length });
        return c.json({ item: itemView(getItem(rt.db, c.var.user.id, existing.id)!) });
      }
      const item = insertItem(rt.db, {
        ...common, kind: "compare", repo: b.repo, title: ref, url: `https://github.com/${b.repo}/compare/${ref}`, head_sha: b.head,
        ref_key: ref, compare_base: b.base, compare_head: b.head, changed_files: files.length,
      });
      emitItem(rt, item);
      return c.json({ item: itemView(item) }, 201);
    } catch (error) {
      return fail(c, new InputError(`could not compare ${b.repo} ${ref}: ${error instanceof Error ? error.message : error}`));
    }
  }

  api.post("/items/:id/archive", (c) => setItemState(c, "archived"));
  api.post("/items/:id/unarchive", (c) => setItemState(c, "open"));
  function setItemState(c: Context<Env>, state: string): Response {
    const item = getItem(rt.db, c.var.user.id, c.req.param("id")!);
    if (item === null) return c.json({ error: "not found" }, 404);
    updateItem(rt.db, item.id, { state });
    const fresh = getItem(rt.db, c.var.user.id, item.id)!;
    emitItem(rt, fresh);
    return c.json({ item: itemView(fresh) });
  }

  // ── reviews ──────────────────────────────────────────────────────
  api.get("/reviews", (c) => {
    const where = ["user_id = ?"];
    const args: (string | number)[] = [c.var.user.id];
    if (c.req.query("status")) {
      where.push("status = ?");
      args.push(c.req.query("status")!);
    }
    if (c.req.query("itemId")) {
      where.push("item_id = ?");
      args.push(c.req.query("itemId")!);
    }
    const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 500);
    return c.json({ reviews: rt.db.query(`SELECT ${JOB_COLUMNS} FROM jobs WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...args, limit) });
  });

  api.get("/reviews/:id{[0-9]+}", (c) => {
    const id = Number(c.req.param("id"));
    const job = rt.db.query("SELECT * FROM jobs WHERE id = ? AND user_id = ?").get(id, c.var.user.id) as (JobRow & { result: string | null }) | null;
    if (job === null) return c.json({ error: "not found" }, 404);
    const events = rt.db.query("SELECT * FROM events WHERE job_id = ? ORDER BY id").all(id) as EventRow[];
    const { result, ...rest } = job;
    const runs = rt.db.query("SELECT * FROM runs WHERE job_id = ? ORDER BY id").all(id);
    const outputs = rt.db.query("SELECT type, status, external_url, error, created_at FROM outputs WHERE job_id = ? ORDER BY id").all(id);
    return c.json({ review: rest, result: storedResult(job), events, runs, outputs, stage: rt.stages.get(id) ?? null, purged: result === null && job.status === "done" });
  });

  type StoredJob = JobRow & { result: string | null; item_id?: string | null };
  /** The stored result with the item's dismissals applied; null once retention removed it. */
  function storedResult(job: StoredJob): ReviewResult | null {
    if (job.result === null) return null;
    const r = applyDismissals(JSON.parse(job.result) as ReviewResult, dismissedMarkers(rt.db, job.item_id ?? null));
    // The panel dismisses by marker; it cannot compute the hash itself.
    const marked = <T extends ReviewResult["findings"][number]>(f: T) => ({ ...f, marker: findingMarker(f) });
    return { ...r, findings: r.findings.map(marked), ...(r.incremental ? { incremental: { ...r.incremental, fixed: r.incremental.fixed.map(marked) } } : {}) };
  }
  function ownJob(c: Context<Env>, id = Number(c.req.param("id"))): StoredJob | null {
    return rt.db.query("SELECT * FROM jobs WHERE id = ? AND user_id = ?").get(id, c.var.user.id) as StoredJob | null;
  }

  api.get("/reviews/:id{[0-9]+}/export.md", (c) => exportReview(c, "md"));
  api.get("/reviews/:id{[0-9]+}/export.json", (c) => exportReview(c, "json"));
  function exportReview(c: Context<Env>, format: "md" | "json"): Response {
    const job = ownJob(c);
    const result = job ? storedResult(job) : null;
    if (job === null || result === null) return c.json({ error: job ? "the findings of this review were removed by retention" : "not found" }, 404);
    const name = `review-${job.repo.replace("/", "-")}-${job.number || job.id}`;
    if (format === "json") {
      const { result: _r, ...review } = job;
      return c.body(JSON.stringify({ review, result }, null, 2), 200, { "content-type": "application/json", "content-disposition": `attachment; filename="${name}.json"` });
    }
    const md = renderMarkdown(result, {
      repo: job.repo, headSha: job.head_sha, model: job.model ?? "claude", elapsedMs: (job.finished_at ?? 0) - (job.started_at ?? 0), title: job.title, number: job.number,
    });
    return c.body(md, 200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${name}.md"` });
  }

  /** Finding-level diff of two reviews: what only the first found, what only the second, what both. */
  api.get("/reviews/:id{[0-9]+}/compare/:other{[0-9]+}", (c) => {
    const a = ownJob(c);
    const b = ownJob(c, Number(c.req.param("other")));
    const ra = a ? storedResult(a) : null;
    const rb = b ? storedResult(b) : null;
    if (a === null || b === null || ra === null || rb === null) return c.json({ error: "not found, or its findings were removed by retention" }, 404);
    const markersB = new Set(rb.findings.map(findingMarker));
    const markersA = new Set(ra.findings.map(findingMarker));
    const strip = ({ review: _r, result: _s, ...j }: StoredJob & { review?: unknown }) => j;
    return c.json({
      a: { review: strip(a), verdict: ra.verdict },
      b: { review: strip(b), verdict: rb.verdict },
      onlyA: ra.findings.filter((f) => !markersB.has(findingMarker(f))),
      onlyB: rb.findings.filter((f) => !markersA.has(findingMarker(f))),
      both: ra.findings.filter((f) => markersB.has(findingMarker(f))),
    });
  });

  /** A dismissed finding stays in the review but no longer blocks or shows in the comment. */
  api.post("/reviews/:id{[0-9]+}/dismissals", async (c) => {
    const b = await body(c, Type.Object({ marker: Type.String({ minLength: 10, maxLength: 300 }), note: Type.Optional(Type.String({ maxLength: 500 })) }));
    if (b instanceof Response) return b;
    const job = ownJob(c);
    if (job === null || !job.item_id) return c.json({ error: "not found" }, 404);
    rt.db.query("INSERT OR REPLACE INTO dismissals (item_id, marker, user_id, note, created_at) VALUES (?, ?, ?, ?, ?)").run(job.item_id, b.marker, c.var.user.id, b.note ?? "", Date.now());
    return c.json({ result: storedResult(job) });
  });
  api.delete("/reviews/:id{[0-9]+}/dismissals", async (c) => {
    const b = await body(c, Type.Object({ marker: Type.String() }));
    if (b instanceof Response) return b;
    const job = ownJob(c);
    if (job === null || !job.item_id) return c.json({ error: "not found" }, 404);
    rt.db.query("DELETE FROM dismissals WHERE item_id = ? AND marker = ?").run(job.item_id, b.marker);
    return c.json({ result: storedResult(job) });
  });

  api.post("/reviews", async (c) => {
    const b = await body(c, Type.Object({ itemId: Type.String(), model: Type.Optional(Type.String()), profileId: Type.Optional(Type.String()), incremental: Type.Optional(Type.Boolean()) }));
    if (b instanceof Response) return b;
    const queued = enqueueReview(rt, c.var.user.id, b.itemId, { ...(b.model ? { model: b.model } : {}), ...(b.profileId ? { profileId: b.profileId } : {}), incremental: b.incremental === true });
    return "error" in queued ? c.json(queued, 409) : c.json({ id: queued.job.id }, 202);
  });

  api.post("/reviews/:id{[0-9]+}/cancel", (c) =>
    cancelJob(rt, c.var.user.id, Number(c.req.param("id"))) !== null ? c.json({ ok: true }) : c.json({ error: "only a queued or running review can be cancelled" }, 409),
  );

  api.post("/reviews/:id{[0-9]+}/publish", async (c) => {
    const raw: unknown = await c.req.json().catch(() => ({}));
    const output = (raw as { output?: string } | null)?.output ?? "pr-comment";
    if (output !== "pr-comment" && output !== "pr-review") return c.json({ error: "output is pr-comment or pr-review" }, 400);
    const posted = await publishJob(rt, c.var.user.id, Number(c.req.param("id")), output);
    return "error" in posted ? c.json(posted, 409) : c.json(posted);
  });

  // ── accounts ─────────────────────────────────────────────────────
  api.get("/accounts", (c) => c.json({ accounts: listAccounts(rt.db, c.var.user.id).map((a) => publicAccount(rt, a)) }));

  api.post("/accounts", async (c) => {
    const b = await body(c, Type.Object({ token: Type.String(), label: Type.Optional(Type.String({ maxLength: 60 })) }));
    if (b instanceof Response) return b;
    try {
      const account = await addAccount(rt, c.var.user.id, b);
      audit(rt, c.var.user.id, "account_added", `@${account.login}`, { via: "token" }, account.id);
      return c.json({ account: publicAccount(rt, account) }, 201);
    } catch (error) {
      return fail(c, error);
    }
  });

  api.post("/accounts/device", async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as { label?: unknown };
    try {
      return c.json(await startDeviceLogin(rt, c.var.user.id, typeof raw.label === "string" ? raw.label.slice(0, 60) : undefined));
    } catch (error) {
      return fail(c, error);
    }
  });
  api.post("/accounts/device/:id", async (c) => {
    try {
      const r = await pollDeviceLogin(rt, c.var.user.id, c.req.param("id"));
      if (r.status === "pending") return c.json(r, 202);
      audit(rt, c.var.user.id, "account_added", `@${r.account.login}`, { via: "device" }, r.account.id);
      return c.json({ status: "done", account: publicAccount(rt, r.account) }, 201);
    } catch (error) {
      return fail(c, error);
    }
  });

  api.patch("/accounts/:id", async (c) => {
    const b = await body(c, Type.Object({
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
      credentialId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      profileId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }));
    if (b instanceof Response) return b;
    const account = getAccount(rt.db, c.var.user.id, c.req.param("id"));
    if (b.profileId && getProfile(rt.db, c.var.user.id, b.profileId) === null) return c.json({ error: "no such profile" }, 400);
    if (account === null) return c.json({ error: "not found" }, 404);
    if (b.credentialId && getCredential(rt.db, c.var.user.id, b.credentialId) === null) return c.json({ error: "no such credential" }, 400);
    if (b.model && !rt.models().includes(b.model)) return c.json({ error: `model ${b.model} is not allowed` }, 400);
    updateAccount(rt.db, c.var.user.id, account.id, {
      ...(b.label !== undefined ? { label: b.label } : {}),
      ...(b.credentialId !== undefined ? { credential_id: b.credentialId } : {}),
      ...(b.model !== undefined ? { model: b.model } : {}),
      ...(b.profileId !== undefined ? { profile_id: b.profileId } : {}),
    });
    return c.json({ account: publicAccount(rt, getAccount(rt.db, c.var.user.id, account.id)!) });
  });

  api.put("/accounts/:id/token", async (c) => {
    const b = await body(c, Type.Object({ token: Type.String({ minLength: 20 }) }));
    if (b instanceof Response) return b;
    const account = getAccount(rt.db, c.var.user.id, c.req.param("id"));
    if (account === null) return c.json({ error: "not found" }, 404);
    replaceAccountToken(rt, account, b.token);
    audit(rt, c.var.user.id, "token_replaced", `@${account.login}`, {}, account.id);
    const checked = await checkAccount(rt, getAccount(rt.db, c.var.user.id, account.id)!);
    return c.json({ account: publicAccount(rt, checked) });
  });

  api.post("/accounts/:id/check", async (c) => {
    const account = getAccount(rt.db, c.var.user.id, c.req.param("id"));
    if (account === null) return c.json({ error: "not found" }, 404);
    return c.json({ account: publicAccount(rt, await checkAccount(rt, account)) });
  });

  api.delete("/accounts/:id", (c) => {
    const removed = deleteAccount(rt.db, c.var.user.id, c.req.param("id"));
    if (removed === null) return c.json({ error: "not found" }, 404);
    deleteSecret(rt.db, removed.token_secret_id);
    rt.githubRate.delete(removed.id);
    rt.log("info", `account @${removed.login} removed`, { userId: c.var.user.id });
    audit(rt, c.var.user.id, "account_removed", `@${removed.login}`, {}, removed.id);
    return c.json({ ok: true });
  });

  // ── credentials ──────────────────────────────────────────────────
  api.get("/credentials", (c) => c.json({ credentials: listCredentials(rt.db, c.var.user.id).map(publicCredential) }));

  api.post("/credentials", async (c) => {
    const b = await body(c, Type.Object({ provider: Type.String(), label: Type.Optional(Type.String({ maxLength: 60 })), token: Type.String() }));
    if (b instanceof Response) return b;
    try {
      const credential = await addCredential(rt, c.var.user.id, b);
      audit(rt, c.var.user.id, "credential_added", credential.label, { provider: credential.provider });
      return c.json({ credential: publicCredential(credential) }, 201);
    } catch (error) {
      return fail(c, error);
    }
  });

  api.patch("/credentials/:id", async (c) => {
    const b = await body(c, Type.Object({ label: Type.String({ minLength: 1, maxLength: 60 }) }));
    if (b instanceof Response) return b;
    const credential = getCredential(rt.db, c.var.user.id, c.req.param("id"));
    if (credential === null) return c.json({ error: "not found" }, 404);
    updateCredential(rt.db, c.var.user.id, credential.id, { label: b.label });
    return c.json({ credential: publicCredential(getCredential(rt.db, c.var.user.id, credential.id)!) });
  });

  api.post("/credentials/:id/check", async (c) => {
    const credential = getCredential(rt.db, c.var.user.id, c.req.param("id"));
    if (credential === null) return c.json({ error: "not found" }, 404);
    return c.json({ credential: publicCredential(await checkCredential(rt, credential)) });
  });

  api.delete("/credentials/:id", (c) => {
    const removed = deleteCredential(rt.db, c.var.user.id, c.req.param("id"));
    if (removed === null) return c.json({ error: "not found" }, 404);
    deleteSecret(rt.db, removed.secret_id);
    audit(rt, c.var.user.id, "credential_removed", removed.label, { provider: removed.provider });
    return c.json({ ok: true });
  });

  // ── targets ──────────────────────────────────────────────────────
  api.get("/targets", (c) => c.json({ targets: listTargets(rt.db, c.var.user.id).map((t) => targetView(rt, t)) }));

  api.post("/targets/preview", async (c) => {
    const b = await body(c, TargetSchema);
    if (b instanceof Response) return b;
    const account = getAccount(rt.db, c.var.user.id, b.accountId);
    if (account === null) return c.json({ error: "no such account" }, 400);
    const invalid = validTargetParams(b.type, b.params);
    if (invalid) return c.json({ error: invalid }, 400);
    try {
      const items = await previewTarget(rt, account, { type: b.type, params_json: JSON.stringify(b.params), filters_json: JSON.stringify(b.filters ?? {}) });
      return c.json({ items });
    } catch (error) {
      return fail(c, new InputError(error instanceof Error ? error.message : String(error)));
    }
  });

  /** Auto-post writes to other people's PRs unattended: the person types the account login to turn it on. */
  function autoPostRefused(c: Context<Env>, accountId: string, b: { automation?: string; confirmLogin?: string }, was?: string): string | null {
    if (b.automation !== "auto-post" || was === "auto-post") return null;
    const account = getAccount(rt.db, c.var.user.id, accountId);
    if (!account || b.confirmLogin?.trim().toLowerCase() !== account.login.toLowerCase()) return `type the account login (${account?.login ?? "?"}) to confirm auto-post`;
    return null;
  }

  api.post("/targets", async (c) => {
    const b = await body(c, TargetSchema);
    if (b instanceof Response) return b;
    if (getAccount(rt.db, c.var.user.id, b.accountId) === null) return c.json({ error: "no such account" }, 400);
    const refused = autoPostRefused(c, b.accountId, b);
    if (refused) return c.json({ error: refused }, 400);
    const invalid = validTargetParams(b.type, b.params);
    if (invalid) return c.json({ error: invalid }, 400);
    if (b.model && !rt.models().includes(b.model)) return c.json({ error: `model ${b.model} is not allowed` }, 400);
    if (b.profileId && getProfile(rt.db, c.var.user.id, b.profileId) === null) return c.json({ error: "no such profile" }, 400);
    const target = insertTarget(rt.db, {
      user_id: c.var.user.id, account_id: b.accountId, name: b.name, type: b.type, params: b.params,
      ...(b.filters ? { filters: b.filters } : {}),
      ...(b.automation ? { automation: b.automation } : {}),
      model: b.model ?? null,
      ...(b.pollSec ? { poll_sec: b.pollSec } : {}),
      enabled: b.enabled === false ? 0 : 1,
    });
    if (b.profileId) updateTarget(rt.db, c.var.user.id, target.id, { profile_id: b.profileId });
    if (b.automation === "auto-post") audit(rt, c.var.user.id, "target_auto_post_enabled", target.name, { target: target.id }, b.accountId);
    void rt.requestPoll(target.id);
    return c.json({ target: targetView(rt, target) }, 201);
  });

  api.patch("/targets/:id", async (c) => {
    const b = await body(c, Type.Partial(TargetSchema));
    if (b instanceof Response) return b;
    const target = getTarget(rt.db, c.var.user.id, c.req.param("id"));
    if (target === null) return c.json({ error: "not found" }, 404);
    if (b.accountId && getAccount(rt.db, c.var.user.id, b.accountId) === null) return c.json({ error: "no such account" }, 400);
    const type = b.type ?? target.type;
    const params = b.params ?? JSON.parse(target.params_json);
    const invalid = validTargetParams(type, params);
    if (invalid) return c.json({ error: invalid }, 400);
    if (b.model && !rt.models().includes(b.model)) return c.json({ error: `model ${b.model} is not allowed` }, 400);
    if (b.profileId && getProfile(rt.db, c.var.user.id, b.profileId) === null) return c.json({ error: "no such profile" }, 400);
    // Moving an auto-post target to another account needs the new login confirmed too.
    const movedAccount = b.accountId && b.accountId !== target.account_id;
    const refused = autoPostRefused(c, b.accountId ?? target.account_id, { ...b, automation: b.automation ?? target.automation }, movedAccount ? undefined : target.automation);
    if (refused) return c.json({ error: refused }, 400);
    if ((b.automation ?? target.automation) === "auto-post" && (target.automation !== "auto-post" || movedAccount)) {
      audit(rt, c.var.user.id, "target_auto_post_enabled", b.name ?? target.name, { target: target.id }, b.accountId ?? target.account_id);
    }
    updateTarget(rt.db, c.var.user.id, target.id, {
      ...(b.accountId ? { account_id: b.accountId } : {}),
      ...(b.name ? { name: b.name } : {}),
      type,
      params_json: JSON.stringify(params),
      ...(b.filters ? { filters_json: JSON.stringify(b.filters) } : {}),
      ...(b.automation ? { automation: b.automation } : {}),
      ...(b.model !== undefined ? { model: b.model } : {}),
      ...(b.profileId !== undefined ? { profile_id: b.profileId } : {}),
      ...(b.pollSec ? { poll_sec: b.pollSec } : {}),
      ...(b.enabled !== undefined ? { enabled: b.enabled ? 1 : 0 } : {}),
      next_poll_at: 0,
    });
    return c.json({ target: targetView(rt, getTarget(rt.db, c.var.user.id, target.id)!) });
  });

  api.post("/targets/:id/poll", async (c) => {
    const target = getTarget(rt.db, c.var.user.id, c.req.param("id"));
    if (target === null) return c.json({ error: "not found" }, 404);
    await rt.requestPoll(target.id);
    return c.json({ target: targetView(rt, getTarget(rt.db, c.var.user.id, target.id)!) });
  });

  api.delete("/targets/:id", (c) => {
    const removed = deleteTarget(rt.db, c.var.user.id, c.req.param("id"));
    if (removed === null) return c.json({ error: "not found" }, 404);
    // Items only this target found are no longer tracked by anything.
    rt.db.query(
      `UPDATE items SET target_ids_json = (SELECT COALESCE(json_group_array(value), '[]') FROM json_each(items.target_ids_json) WHERE value != ?)
       WHERE user_id = ? AND EXISTS (SELECT 1 FROM json_each(items.target_ids_json) WHERE value = ?)`,
    ).run(removed.id, c.var.user.id, removed.id);
    rt.db.query("UPDATE items SET state = 'unmatched' WHERE user_id = ? AND state = 'open' AND target_ids_json = '[]'").run(c.var.user.id);
    return c.json({ ok: true });
  });

  api.post("/poll", async (c) => {
    for (const t of listTargets(rt.db, c.var.user.id).filter((t) => t.enabled)) await rt.requestPoll(t.id);
    return c.json({ ok: true });
  });

  // ── profiles ─────────────────────────────────────────────────────
  api.get("/profiles", (c) => c.json({ profiles: ensureProfiles(rt.db, c.var.user.id).map(profileView) }));

  const ProfileBody = Type.Object({ name: Type.String({ minLength: 1, maxLength: 60 }), mode: Type.String(), options: ProfileOptionsSchema });
  function checkProfile(b: { mode: string; options: ProfileOptions }): string | null {
    if (!MODES[b.mode]) return `unknown mode ${b.mode}`;
    if (b.options.model && !rt.models().includes(b.options.model)) return `model ${b.options.model} is not allowed`;
    if (b.mode === "custom" && !b.options.customCategories?.length) return "a custom profile needs at least one category";
    return null;
  }

  api.post("/profiles", async (c) => {
    const b = await body(c, ProfileBody);
    if (b instanceof Response) return b;
    const invalid = checkProfile(b);
    if (invalid) return c.json({ error: invalid }, 400);
    ensureProfiles(rt.db, c.var.user.id);
    return c.json({ profile: profileView(insertProfile(rt.db, { user_id: c.var.user.id, name: b.name, mode: b.mode, options: b.options })) }, 201);
  });

  api.patch("/profiles/:id", async (c) => {
    const b = await body(c, Type.Partial(ProfileBody));
    if (b instanceof Response) return b;
    const p = getProfile(rt.db, c.var.user.id, c.req.param("id"));
    if (p === null) return c.json({ error: "not found" }, 404);
    const merged = { mode: b.mode ?? p.mode, options: b.options ?? (JSON.parse(p.options_json) as ProfileOptions) };
    const invalid = checkProfile(merged);
    if (invalid) return c.json({ error: invalid }, 400);
    updateProfile(rt.db, c.var.user.id, p.id, { ...(b.name ? { name: b.name } : {}), mode: merged.mode, options: merged.options });
    return c.json({ profile: profileView(getProfile(rt.db, c.var.user.id, p.id)!) });
  });

  api.post("/profiles/:id/default", (c) => {
    const p = getProfile(rt.db, c.var.user.id, c.req.param("id"));
    if (p === null) return c.json({ error: "not found" }, 404);
    setDefaultProfile(rt.db, c.var.user.id, p.id);
    return c.json({ profiles: ensureProfiles(rt.db, c.var.user.id).map(profileView) });
  });

  api.delete("/profiles/:id", (c) => {
    const p = getProfile(rt.db, c.var.user.id, c.req.param("id"));
    if (p === null) return c.json({ error: "not found" }, 404);
    if (p.is_default) return c.json({ error: "make another profile the default first" }, 409);
    deleteProfile(rt.db, c.var.user.id, p.id);
    rt.db.query("UPDATE accounts SET profile_id = NULL WHERE profile_id = ? AND user_id = ?").run(p.id, c.var.user.id);
    rt.db.query("UPDATE targets SET profile_id = NULL WHERE profile_id = ? AND user_id = ?").run(p.id, c.var.user.id);
    return c.json({ ok: true });
  });

  /** The exact prompt the profile would send for an item: system prompt plus the first part. */
  api.post("/profiles/:id/preview", async (c) => {
    const b = await body(c, Type.Object({ itemId: Type.String() }));
    if (b instanceof Response) return b;
    const p = getProfile(rt.db, c.var.user.id, c.req.param("id"));
    const item = getItem(rt.db, c.var.user.id, b.itemId);
    if (p === null || item === null) return c.json({ error: "not found" }, 404);
    const account = getAccount(rt.db, c.var.user.id, item.account_id);
    if (account === null) return c.json({ error: "not found" }, 404);
    try {
      const gh = githubFor(rt, account);
      const [pr, raw] = await Promise.all([gh.pull(item.repo, item.number), gh.pullDiff(item.repo, item.number)]);
      const resolved = resolveRow(p);
      const diff = chunkDiff(parseDiffOutput(raw), { budgetTokens: resolved.budgetTokens, maxChunks: resolved.maxChunks });
      const context = { repo: item.repo, number: item.number, title: pr.title, headSha: pr.headSha, baseSha: pr.baseSha, branch: pr.headRef };
      const user = diff.chunks[0] ? buildUserMessage(context, renderChunk(diff, diff.chunks[0]), resolved.intent === "pr-body" && pr.body.trim() ? pr.body : undefined) : "(empty diff)";
      return c.json({ system: systemPrompt(resolved), user, chunks: diff.chunks.length, tokens: diff.tokenEstimate, skipped: diff.skippedFiles });
    } catch (error) {
      return fail(c, new InputError(error instanceof Error ? error.message : String(error)));
    }
  });

  // ── insights ─────────────────────────────────────────────────────
  api.get("/insights", (c) => {
    const days = Math.min(Number(c.req.query("days") ?? 7) || 7, 90);
    const since = Date.now() - days * 86400_000;
    const uid = c.var.user.id;
    const byModel = rt.db.query(
      `SELECT model, COUNT(*) AS reviews, COALESCE(SUM(runs), 0) AS runs, AVG(finished_at - started_at) AS avg_ms,
              COALESCE(SUM(tokens_in), 0) AS tokens_in, COALESCE(SUM(tokens_out), 0) AS tokens_out, COALESCE(SUM(cost_usd), 0) AS cost_usd,
              SUM(conclusion = 'action_required') AS blocking_reviews
       FROM jobs WHERE user_id = ? AND status = 'done' AND finished_at > ? GROUP BY model ORDER BY reviews DESC`,
    ).all(uid, since);
    const byProfile = rt.db.query(
      `SELECT COALESCE(profile_name, 'Triage (v1)') AS profile, COUNT(*) AS reviews, AVG(finished_at - started_at) AS avg_ms, COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM jobs WHERE user_id = ? AND status = 'done' AND finished_at > ? GROUP BY 1 ORDER BY reviews DESC`,
    ).all(uid, since);
    const byDay = rt.db.query(
      `SELECT date(finished_at / 1000, 'unixepoch') AS day, COUNT(*) AS reviews, SUM(status = 'error') AS failed, COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM jobs WHERE user_id = ? AND finished_at > ? GROUP BY 1 ORDER BY 1`,
    ).all(uid, since);
    const categories: Record<string, number> = {};
    const posted = rt.db.query("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND comment_url IS NOT NULL AND finished_at > ?").get(uid, since) as { n: number };
    for (const row of rt.db.query("SELECT result FROM jobs WHERE user_id = ? AND status = 'done' AND finished_at > ? AND result IS NOT NULL").all(uid, since) as { result: string }[]) {
      for (const f of (JSON.parse(row.result) as { findings?: { category: string }[] }).findings ?? []) categories[f.category] = (categories[f.category] ?? 0) + 1;
    }
    const confirmRuns = rt.db.query(
      `SELECT COUNT(*) AS confirmations, SUM(confirmed > 0) AS agreed FROM jobs WHERE user_id = ? AND status = 'done' AND finished_at > ? AND blocking > 0`,
    ).get(uid, since);
    return c.json({ days, byModel, byProfile, byDay, categories, posted: posted.n, confirmation: confirmRuns });
  });

  // ── logs & settings ──────────────────────────────────────────────
  api.get("/logs", (c) => {
    const levels = c.req.query("level") === "error" ? ["error"] : c.req.query("level") === "warn" ? ["warn", "error"] : ["info", "warn", "error"];
    const limit = Math.min(Number(c.req.query("limit") ?? 300) || 300, 1000);
    const rows = rt.db
      .query(`SELECT * FROM events WHERE (user_id = ? OR user_id IS NULL) AND level IN (${levels.map(() => "?").join(",")}) ORDER BY id DESC LIMIT ?`)
      .all(c.var.user.id, ...levels, limit) as EventRow[];
    return c.json({ events: rows.reverse() });
  });

  api.get("/audit", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 300) || 300, 1000);
    const rows = rt.db.query("SELECT id, account_id, action, subject, details_json, created_at FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(c.var.user.id, limit) as
      { id: number; account_id: string | null; action: string; subject: string; details_json: string; created_at: number }[];
    return c.json({ audit: rows.map(({ details_json, ...r }) => ({ ...r, details: JSON.parse(details_json) })) });
  });

  // ── notification channels ────────────────────────────────────────
  api.get("/channels", (c) => c.json({ channels: listChannels(rt, c.var.user.id).map(publicChannel), events: NOTIFY_EVENTS }));
  const EventsSchema = Type.Array(Type.Union(NOTIFY_EVENTS.map((e) => Type.Literal(e))), { minItems: 1 });
  api.post("/channels", async (c) => {
    const b = await body(c, Type.Object({
      type: Type.Union([Type.Literal("webhook"), Type.Literal("slack"), Type.Literal("telegram")]),
      label: Type.String({ minLength: 1, maxLength: 60 }),
      secret: Type.String({ minLength: 8, maxLength: 1000 }),
      chatId: Type.Optional(Type.String({ maxLength: 60 })),
      events: EventsSchema,
    }));
    if (b instanceof Response) return b;
    try {
      const channel = addChannel(rt, c.var.user.id, { ...b, events: b.events as NotifyEvent[] });
      audit(rt, c.var.user.id, "channel_added", channel.label, { type: channel.type });
      return c.json({ channel: publicChannel(channel) }, 201);
    } catch (error) {
      return fail(c, new InputError(error instanceof Error ? error.message : String(error)));
    }
  });
  api.patch("/channels/:id", async (c) => {
    const b = await body(c, Type.Object({ label: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })), events: Type.Optional(EventsSchema), enabled: Type.Optional(Type.Boolean()) }));
    if (b instanceof Response) return b;
    const ch = listChannels(rt, c.var.user.id).find((x) => x.id === c.req.param("id"));
    if (!ch) return c.json({ error: "not found" }, 404);
    rt.db.query("UPDATE channels SET label = ?, events_json = ?, enabled = ? WHERE id = ?")
      .run(b.label ?? ch.label, b.events ? JSON.stringify(b.events) : ch.events_json, b.enabled === undefined ? ch.enabled : b.enabled ? 1 : 0, ch.id);
    return c.json({ channel: publicChannel(listChannels(rt, c.var.user.id).find((x) => x.id === ch.id)!) });
  });
  api.post("/channels/:id/test", async (c) => {
    const ch = listChannels(rt, c.var.user.id).find((x) => x.id === c.req.param("id"));
    if (!ch) return c.json({ error: "not found" }, 404);
    try {
      await notify(rt, c.var.user.id, { event: "done", title: "test notification", repo: "agentic-pr-reviewer", number: 0, verdict: "the channel works", url: "" }, ch.id);
      return c.json({ ok: true });
    } catch (error) {
      return fail(c, new InputError(error instanceof Error ? error.message : String(error)));
    }
  });
  api.delete("/channels/:id", (c) => {
    const ch = listChannels(rt, c.var.user.id).find((x) => x.id === c.req.param("id"));
    if (!ch) return c.json({ error: "not found" }, 404);
    rt.db.query("DELETE FROM channels WHERE id = ?").run(ch.id);
    deleteSecret(rt.db, ch.secret_id);
    audit(rt, c.var.user.id, "channel_removed", ch.label, { type: ch.type });
    return c.json({ ok: true });
  });

  // ── settings ─────────────────────────────────────────────────────
  const settingsView = (userId: string) => ({
    models: rt.models(),
    retentionDays: getSetting(rt.db, userId, "retention_days", DEFAULT_RETENTION_DAYS),
    githubOauthClientId: getSetting(rt.db, "", "github_oauth_client_id", ""),
  });
  api.get("/settings", (c) => c.json(settingsView(c.var.user.id)));
  api.patch("/settings", async (c) => {
    const b = await body(c, Type.Object({
      models: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 30 })),
      retentionDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
      githubOauthClientId: Type.Optional(Type.String({ maxLength: 100, pattern: "^[\\w.-]*$" })),
    }));
    if (b instanceof Response) return b;
    const admin = c.var.user.role === "admin";
    if ((b.models || b.githubOauthClientId !== undefined) && !admin) return c.json({ error: "admin only" }, 403);
    if (b.models) setSetting(rt.db, "", "models", b.models);
    if (b.githubOauthClientId !== undefined) setSetting(rt.db, "", "github_oauth_client_id", b.githubOauthClientId.trim());
    if (b.retentionDays) setSetting(rt.db, c.var.user.id, "retention_days", b.retentionDays);
    return c.json(settingsView(c.var.user.id));
  });

  return api;
}
