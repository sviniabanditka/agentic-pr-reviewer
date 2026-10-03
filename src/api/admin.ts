import { Hono } from "hono";
import { createInvite } from "../auth/auth.js";
import { audit } from "../audit.js";
import { deleteSecret } from "../store/secrets.js";
import type { PublicUser } from "../auth/auth.js";
import type { Runtime } from "../runtime.js";
import type { UserRow } from "../store/types.js";

type Env = { Variables: { user: PublicUser } };
const DAY_MS = 86400_000;

/**
 * Instance administration. An admin sees who uses the instance and how much (counts,
 * tokens, queue), never what: no repositories, titles, findings or tokens of others.
 */
export function adminRoutes(rt: Runtime): Hono<Env> {
  const admin = new Hono<Env>();
  // Admin actions need the panel: a leaked CLI token must not manage users.
  admin.use(async (c, next) => (c.var.user.role === "admin" && !c.req.header("authorization") ? next() : c.json({ error: "admin only, from the panel" }, 403)));

  admin.get("/users", (c) => {
    const now = Date.now();
    const users = rt.db
      .query(
        `SELECT u.id, u.login, u.role, u.disabled, u.created_at, u.totp_enabled,
           (SELECT MAX(last_seen_at) FROM sessions WHERE user_id = u.id) AS last_seen_at,
           (SELECT COUNT(*) FROM accounts WHERE user_id = u.id) AS accounts,
           (SELECT COUNT(*) FROM credentials WHERE user_id = u.id) AS credentials,
           (SELECT COUNT(*) FROM targets WHERE user_id = u.id AND enabled = 1) AS targets,
           (SELECT COUNT(*) FROM jobs WHERE user_id = u.id AND status IN ('queued', 'running')) AS active,
           (SELECT COUNT(*) FROM jobs WHERE user_id = u.id AND status = 'done' AND finished_at > ?) AS reviews_24h,
           (SELECT COUNT(*) FROM jobs WHERE user_id = u.id AND status = 'done' AND finished_at > ?) AS reviews_7d,
           (SELECT COUNT(*) FROM jobs WHERE user_id = u.id AND status = 'error' AND finished_at > ?) AS errors_7d,
           (SELECT COALESCE(SUM(tokens_in + tokens_out), 0) FROM jobs WHERE user_id = u.id AND finished_at > ?) AS tokens_7d,
           (SELECT COALESCE(SUM(finished_at - started_at), 0) FROM jobs WHERE user_id = u.id AND finished_at > ? AND started_at IS NOT NULL) AS busy_ms_7d
         FROM users u ORDER BY u.created_at`,
      )
      .all(now - DAY_MS, now - 7 * DAY_MS, now - 7 * DAY_MS, now - 7 * DAY_MS, now - 7 * DAY_MS);
    const queue = rt.db.query("SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running') GROUP BY status").all();
    return c.json({ users, queue });
  });

  admin.patch("/users/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { disabled?: unknown; role?: unknown; resetTotp?: unknown };
    const target = rt.db.query("SELECT * FROM users WHERE id = ?").get(c.req.param("id")) as UserRow | null;
    if (target === null) return c.json({ error: "not found" }, 404);
    if (target.id === c.var.user.id && (body.disabled === true || body.role === "member")) return c.json({ error: "you cannot disable or demote yourself" }, 400);
    if (body.role !== undefined && body.role !== "admin" && body.role !== "member") return c.json({ error: "role is admin or member" }, 400);
    if (typeof body.disabled === "boolean") {
      rt.db.query("UPDATE users SET disabled = ? WHERE id = ?").run(body.disabled ? 1 : 0, target.id);
      if (body.disabled) {
        rt.db.query("DELETE FROM sessions WHERE user_id = ?").run(target.id);
        // Their queued reviews would spend their subscription while they are locked out.
        rt.db.query("UPDATE jobs SET status = 'skipped', error = 'user disabled', finished_at = ? WHERE user_id = ? AND status = 'queued'").run(Date.now(), target.id);
        rt.db.query("UPDATE targets SET enabled = 0 WHERE user_id = ?").run(target.id);
      }
      audit(rt, c.var.user.id, body.disabled ? "user_disabled" : "user_enabled", target.login);
    }
    if (body.role === "admin" || body.role === "member") {
      rt.db.query("UPDATE users SET role = ? WHERE id = ?").run(body.role, target.id);
      audit(rt, c.var.user.id, "role_changed", target.login, { role: body.role });
    }
    if (body.resetTotp === true && target.totp_enabled) {
      rt.db.query("UPDATE users SET totp_enabled = 0, totp_secret_id = NULL WHERE id = ?").run(target.id);
      if (target.totp_secret_id) deleteSecret(rt.db, target.totp_secret_id);
      audit(rt, c.var.user.id, "totp_reset", target.login);
    }
    return c.json({ ok: true });
  });

  admin.get("/invites", (c) =>
    c.json({
      invites: rt.db
        .query(
          `SELECT i.id, i.role, i.note, i.created_at, i.expires_at, i.used_at, u.login AS used_by
           FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 100`,
        )
        .all(),
    }),
  );

  /** The link is shown once; only its hash is kept. */
  admin.post("/invites", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { role?: unknown; note?: unknown };
    const role = body.role === "admin" ? "admin" : "member";
    const note = typeof body.note === "string" ? body.note.slice(0, 120) : "";
    const invite = createInvite(rt.db, c.var.user.id, role, note);
    audit(rt, c.var.user.id, "user_invited", note || role, { role });
    const origin = new URL(c.req.url).origin.replace(/^http:/, c.req.header("x-forwarded-proto") === "https" ? "https:" : "http:");
    return c.json({ id: invite.id, url: `${origin}/invite/${invite.token}`, expiresAt: invite.expiresAt }, 201);
  });

  admin.delete("/invites/:id", (c) => {
    const r = rt.db.query("DELETE FROM invites WHERE id = ? AND used_at IS NULL").run(c.req.param("id"));
    return r.changes ? c.json({ ok: true }) : c.json({ error: "not found or already used" }, 404);
  });

  return admin;
}
