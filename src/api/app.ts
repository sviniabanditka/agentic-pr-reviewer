import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import {
  countUsers,
  createSession,
  createUser,
  deleteSession,
  LoginLimiter,
  resolveSession,
  SESSION_COOKIE,
  verifyLogin,
  type PublicUser,
} from "../auth/auth.js";
import { cancelJob, enqueueReview } from "../jobs/queue.js";
import { publishJob } from "../jobs/publish.js";
import { refreshClaudeLimits } from "../scheduler/poller.js";
import type { Runtime } from "../runtime.js";
import type { LiveEvent } from "../events/bus.js";
import type { EventRow, JobRow } from "../store/types.js";

type Env = { Variables: { user: PublicUser } };

const WEB = new URL("../web/", import.meta.url);
const page = (name: string) => Bun.file(new URL(name, WEB));
const JOB_COLUMNS =
  "id, account, repo, number, title, url, role, head_sha, status, created_at, started_at, finished_at, outcome, conclusion, verdict_title, findings, blocking, confirmed, runs, tokens_in, tokens_out, cost_usd, model, cached, comment_url, error";

const PUBLIC_PATHS = new Set(["/healthz", "/login", "/setup", "/api/v1/auth/login", "/api/v1/setup"]);

function isSecure(c: Context): boolean {
  return c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
}

function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";
}

function html(c: Context, name: string): Response {
  return c.body(page(name).stream(), 200, { "content-type": "text/html; charset=utf-8" });
}

export function createApp(rt: Runtime): Hono<Env> {
  const app = new Hono<Env>();
  const limiter = new LoginLimiter();

  app.use(async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "same-origin");
    c.header("x-frame-options", "DENY");
    c.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
  });

  // The browser attaches cookies to cross-site requests too. Mutations must come from this
  // origin and carry a header a plain form cannot set.
  app.use(async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
      if ((origin && new URL(origin).host !== host) || c.req.header("x-requested-with") !== "fetch") {
        return c.json({ error: "forbidden" }, 403);
      }
    }
    await next();
  });

  app.use(
    createMiddleware<Env>(async (c, next) => {
      const path = new URL(c.req.url).pathname;
      if (PUBLIC_PATHS.has(path)) return next();
      const user = resolveSession(rt.db, getCookie(c, SESSION_COOKIE));
      if (user === null) {
        if (path.startsWith("/api/")) return c.json({ error: "unauthorized" }, 401);
        return c.redirect(countUsers(rt.db) === 0 ? "/setup" : `/login?next=${encodeURIComponent(path)}`);
      }
      c.set("user", user);
      return next();
    }),
  );

  app.get("/healthz", (c) => c.text("ok"));

  // ── auth ────────────────────────────────────────────────────────
  app.get("/login", (c) => html(c, "login.html"));
  app.get("/setup", (c) => (countUsers(rt.db) === 0 ? html(c, "setup.html") : c.redirect("/login")));

  app.get("/api/v1/setup", (c) => c.json({ needsSetup: countUsers(rt.db) === 0 }));
  app.post("/api/v1/setup", async (c) => {
    if (countUsers(rt.db) > 0) return c.json({ error: "already set up" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { login?: unknown; password?: unknown };
    if (typeof body.login !== "string" || typeof body.password !== "string") return c.json({ error: "expected {login, password}" }, 400);
    try {
      const user = await createUser(rt.db, body.login, body.password, "admin");
      startSession(c, user);
      rt.log("info", `admin ${user.login} created`);
      return c.json({ user });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/v1/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { login?: unknown; password?: unknown };
    if (typeof body.login !== "string" || typeof body.password !== "string") return c.json({ error: "expected {login, password}" }, 400);
    const keys = [`ip:${clientIp(c)}`, `login:${body.login.toLowerCase()}`];
    if (keys.some((k) => limiter.blocked(k))) return c.json({ error: "too many attempts, try again in 15 minutes" }, 429);
    const user = await verifyLogin(rt.db, body.login, body.password);
    if (user === null) {
      keys.forEach((k) => limiter.fail(k));
      return c.json({ error: "wrong login or password" }, 401);
    }
    keys.forEach((k) => limiter.reset(k));
    startSession(c, user);
    return c.json({ user });
  });

  app.post("/api/v1/auth/logout", (c) => {
    deleteSession(rt.db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/v1/auth/me", (c) => c.json({ user: c.var.user }));

  function startSession(c: Context, user: PublicUser): void {
    const token = createSession(rt.db, user.id, clientIp(c), c.req.header("user-agent") ?? null);
    setCookie(c, SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      secure: isSecure(c),
      sameSite: "Strict",
      maxAge: 30 * 24 * 60 * 60,
    });
  }

  // ── panel (v1 endpoints, replaced by /api/v1 with the SPA) ─────
  app.get("/", (c) => html(c, "panel.html"));

  app.get("/api/state", (c) =>
    c.json({
      startedAt: rt.startedAt,
      models: rt.cfg.models,
      user: c.var.user,
      accounts: [...rt.accountStatus.values()],
      prs: [...rt.openPrs.values()].flat(),
      stages: Object.fromEntries(rt.stages),
      jobs: rt.db.query(`SELECT ${JOB_COLUMNS} FROM jobs ORDER BY id DESC LIMIT 200`).all() as JobRow[],
      events: (rt.db.query("SELECT * FROM events ORDER BY id DESC LIMIT 300").all() as EventRow[]).reverse(),
      totals: rt.db
        .query(
          `SELECT COUNT(*) AS reviews, COALESCE(SUM(runs), 0) AS runs, COALESCE(SUM(tokens_in), 0) AS tokens_in,
                  COALESCE(SUM(tokens_out), 0) AS tokens_out, COALESCE(SUM(cost_usd), 0) AS cost_usd
           FROM jobs WHERE status = 'done' AND finished_at > ?`,
        )
        .get(Date.now() - 24 * 60 * 60 * 1000),
    }),
  );

  app.get("/api/jobs/:id{[0-9]+}", (c) => {
    const id = Number(c.req.param("id"));
    const job = rt.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as (JobRow & { result: string | null }) | null;
    if (job === null) return c.json({ error: "not found" }, 404);
    const events = rt.db.query("SELECT * FROM events WHERE job_id = ? ORDER BY id").all(id) as EventRow[];
    return c.json({ ...job, result: job.result !== null ? JSON.parse(job.result) : null, events });
  });

  app.get("/api/stream", (c) => sse(rt, c.req.raw));

  app.post("/api/review", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { account?: unknown; repo?: unknown; number?: unknown; model?: unknown } | null;
    if (
      typeof body?.account !== "string" ||
      typeof body.repo !== "string" ||
      typeof body.number !== "number" ||
      (body.model !== undefined && typeof body.model !== "string")
    ) {
      return c.json({ error: "expected {account, repo, number, model?}" }, 400);
    }
    const queued = enqueueReview(rt, body.account, body.repo, body.number, body.model);
    return "error" in queued ? c.json(queued, 409) : c.json({ jobId: queued.job.id }, 202);
  });

  app.post("/api/poll", async (c) => {
    await rt.requestPoll();
    return c.json({ ok: true });
  });

  app.post("/api/limits", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { account?: unknown };
    await refreshClaudeLimits(rt, typeof body.account === "string" ? body.account : undefined);
    return c.json({ ok: true });
  });

  app.post("/api/jobs/:id{[0-9]+}/publish", async (c) => {
    const posted = await publishJob(rt, Number(c.req.param("id")));
    return "error" in posted ? c.json(posted, 409) : c.json(posted);
  });

  app.post("/api/jobs/:id{[0-9]+}/cancel", (c) =>
    cancelJob(rt, Number(c.req.param("id"))) !== null ? c.json({ ok: true }) : c.json({ error: "only a queued review can be cancelled" }, 409),
  );

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}

function sse(rt: Runtime, req: Request): Response {
  const encoder = new TextEncoder();
  let cleanup = (): void => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: LiveEvent): void => {
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`));
      };
      const unsubscribe = rt.bus.subscribe(send);
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
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
}
