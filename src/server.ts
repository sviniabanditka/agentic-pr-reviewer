import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { accountStatus, cancelJob, enqueueReview, openPrs, refreshClaudeLimits, requestPoll } from "./poller.js";
import { publishJob, stages } from "./worker.js";
import { subscribe, type LiveEvent } from "./log.js";
import type { Config } from "./config.js";
import type { EventRow, JobRow } from "./db.js";

const PANEL = Bun.file(new URL("./panel.html", import.meta.url));
const JOB_COLUMNS =
  "id, account, repo, number, title, url, role, head_sha, status, created_at, started_at, finished_at, outcome, conclusion, verdict_title, findings, blocking, confirmed, runs, tokens_in, tokens_out, cost_usd, model, cached, comment_url, error";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// The panel shows private PR titles and code excerpts: it is never served without a password
// outside local development.
function authorized(req: Request, cfg: Config): boolean {
  if (cfg.panelPassword === undefined) return true;
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  return safeEqual(decoded, `${cfg.panelUser}:${cfg.panelPassword}`);
}

// The browser attaches Basic credentials to cross-site requests too. A JSON body forces
// a CORS preflight that this server never answers, and a foreign Origin is refused outright.
function isSameOriginJson(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin !== null && new URL(origin).host !== host) return false;
  return req.headers.get("content-type")?.startsWith("application/json") === true;
}

export function startServer(cfg: Config, db: Database, startedAt: number, onQueued: () => void): void {
  Bun.serve({
    port: cfg.port,
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") return new Response("ok");
      if (!authorized(req, cfg)) {
        return new Response("unauthorized", { status: 401, headers: { "www-authenticate": 'Basic realm="pr-reviewer"' } });
      }

      if (req.method === "POST") {
        if (!isSameOriginJson(req)) return json({ error: "forbidden" }, 403);
        if (url.pathname === "/api/review") {
          const body = (await req.json().catch(() => null)) as
            | { account?: unknown; repo?: unknown; number?: unknown; model?: unknown }
            | null;
          if (
            typeof body?.account !== "string" ||
            typeof body.repo !== "string" ||
            typeof body.number !== "number" ||
            (body.model !== undefined && typeof body.model !== "string")
          ) {
            return json({ error: "expected {account, repo, number, model?}" }, 400);
          }
          const queued = enqueueReview(cfg, db, body.account, body.repo, body.number, body.model);
          if ("error" in queued) return json(queued, 409);
          onQueued();
          return json({ jobId: queued.job.id }, 202);
        }
        if (url.pathname === "/api/poll") {
          await requestPoll();
          return json({ ok: true });
        }
        if (url.pathname === "/api/limits") {
          const body = (await req.json().catch(() => ({}))) as { account?: unknown };
          await refreshClaudeLimits(cfg, typeof body.account === "string" ? body.account : undefined);
          return json({ ok: true });
        }
        const publish = /^\/api\/jobs\/(\d+)\/publish$/.exec(url.pathname);
        if (publish?.[1] !== undefined) {
          const posted = await publishJob(cfg, db, Number(publish[1]));
          return "error" in posted ? json(posted, 409) : json(posted);
        }
        const cancel = /^\/api\/jobs\/(\d+)\/cancel$/.exec(url.pathname);
        if (cancel?.[1] !== undefined) {
          return cancelJob(db, Number(cancel[1])) !== null ? json({ ok: true }) : json({ error: "only a queued review can be cancelled" }, 409);
        }
        return json({ error: "not found" }, 404);
      }

      if (url.pathname === "/") return new Response(PANEL, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/api/state") return json(state(db, startedAt, cfg.models));
      if (url.pathname === "/api/stream") return stream(req);

      const job = /^\/api\/jobs\/(\d+)$/.exec(url.pathname);
      if (job?.[1] !== undefined) return jobDetails(db, Number(job[1]));

      return json({ error: "not found" }, 404);
    },
  });
}

function state(db: Database, startedAt: number, models: string[]): unknown {
  return {
    startedAt,
    models,
    accounts: [...accountStatus.values()],
    prs: [...openPrs.values()].flat(),
    stages: Object.fromEntries(stages),
    jobs: db.query(`SELECT ${JOB_COLUMNS} FROM jobs ORDER BY id DESC LIMIT 200`).all() as JobRow[],
    events: (db.query("SELECT * FROM events ORDER BY id DESC LIMIT 300").all() as EventRow[]).reverse(),
    totals: db
      .query(
        `SELECT COUNT(*) AS reviews, COALESCE(SUM(runs), 0) AS runs, COALESCE(SUM(tokens_in), 0) AS tokens_in,
                COALESCE(SUM(tokens_out), 0) AS tokens_out, COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM jobs WHERE status = 'done' AND finished_at > ?`,
      )
      .get(Date.now() - 24 * 60 * 60 * 1000),
  };
}

function jobDetails(db: Database, id: number): Response {
  const job = db.query("SELECT * FROM jobs WHERE id = ?").get(id) as (JobRow & { result: string | null }) | null;
  if (job === null) return json({ error: "not found" }, 404);
  const events = db.query("SELECT * FROM events WHERE job_id = ? ORDER BY id").all(id) as EventRow[];
  return json({ ...job, result: job.result !== null ? JSON.parse(job.result) : null, events });
}

function stream(req: Request): Response {
  const encoder = new TextEncoder();
  let cleanup = (): void => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: LiveEvent): void => {
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`));
      };
      const unsubscribe = subscribe(send);
      // Headers go out with the first chunk: without one the panel would show "offline" until the first event.
      controller.enqueue(encoder.encode(": connected\n\n"));
      // Keeps the connection under Bun's idle timeout and proxies' read timeouts.
      const heartbeat = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 20_000);
      cleanup = () => {
        unsubscribe();
        clearInterval(heartbeat);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        controller.close();
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" },
  });
}
