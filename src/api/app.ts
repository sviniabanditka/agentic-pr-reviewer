import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, normalize } from "node:path";
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
import { importV1 } from "../store/import_v1.js";
import { apiRoutes } from "./routes.js";
import type { Runtime } from "../runtime.js";
import type { LiveEvent } from "../events/bus.js";

type Env = { Variables: { user: PublicUser } };

// The built SPA (web/dist); everything that is not /api is served from it.
const DIST = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const PUBLIC_API = new Set(["/api/v1/auth/login", "/api/v1/setup"]);

function isSecure(c: Context): boolean {
  return c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
}

function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";
}

function spaFile(path: string): string | null {
  const file = normalize(join(DIST, path));
  if (!file.startsWith(DIST) || !existsSync(file) || file.endsWith("/")) return null;
  return file;
}

export function createApp(rt: Runtime, env: Record<string, string | undefined> = process.env): Hono<Env> {
  const app = new Hono<Env>();
  const limiter = new LoginLimiter();

  app.use(async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "same-origin");
    c.header("x-frame-options", "DENY");
    c.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

  app.get("/healthz", (c) => c.text("ok"));

  // ── auth (public) ───────────────────────────────────────────────
  app.get("/api/v1/setup", (c) => c.json({ needsSetup: countUsers(rt.db) === 0 }));
  app.post("/api/v1/setup", async (c) => {
    if (countUsers(rt.db) > 0) return c.json({ error: "already set up" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { login?: unknown; password?: unknown };
    if (typeof body.login !== "string" || typeof body.password !== "string") return c.json({ error: "expected {login, password}" }, 400);
    try {
      const user = await createUser(rt.db, body.login, body.password, "admin");
      startSession(c, user);
      rt.log("info", `admin ${user.login} created`, { userId: user.id });
      await importV1(rt, env);
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

  function startSession(c: Context, user: PublicUser): void {
    const token = createSession(rt.db, user.id, clientIp(c), c.req.header("user-agent") ?? null);
    setCookie(c, SESSION_COOKIE, token, { path: "/", httpOnly: true, secure: isSecure(c), sameSite: "Strict", maxAge: 30 * 24 * 60 * 60 });
  }

  // ── authenticated API ───────────────────────────────────────────
  app.use(
    "/api/*",
    createMiddleware<Env>(async (c, next) => {
      if (PUBLIC_API.has(new URL(c.req.url).pathname)) return next();
      const user = resolveSession(rt.db, getCookie(c, SESSION_COOKIE));
      if (user === null) return c.json({ error: "unauthorized" }, 401);
      c.set("user", user);
      return next();
    }),
  );

  app.post("/api/v1/auth/logout", (c) => {
    deleteSession(rt.db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
  app.get("/api/v1/auth/me", (c) => c.json({ user: c.var.user }));
  app.get("/api/v1/events", (c) => sse(rt, c.req.raw, c.var.user.id));
  app.route("/api/v1", apiRoutes(rt));
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // ── SPA ─────────────────────────────────────────────────────────
  app.get("*", (c) => {
    const path = new URL(c.req.url).pathname;
    const file = spaFile(path.slice(1));
    if (file) {
      const immutable = path.startsWith("/assets/") || path.startsWith("/fonts/");
      return new Response(Bun.file(file), { headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } });
    }
    const index = spaFile("index.html");
    if (index === null) return c.text("The web app is not built: run `bun run build:web`.", 503);
    return new Response(Bun.file(index), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  });

  return app;
}

function sse(rt: Runtime, req: Request, userId: string): Response {
  const encoder = new TextEncoder();
  let cleanup = (): void => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: LiveEvent): void => {
        if (event.userId !== undefined && event.userId !== userId) return;
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`));
      };
      const unsubscribe = rt.bus.subscribe(send);
      // Headers go out with the first chunk; `hello` lets the client notice a restart.
      controller.enqueue(encoder.encode(`event: hello\ndata: ${JSON.stringify({ startedAt: rt.startedAt })}\n\n`));
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
