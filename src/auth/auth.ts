import type { Database } from "bun:sqlite";
import { newId } from "../store/db.js";
import type { UserRow } from "../store/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 30 * DAY_MS;
const SESSION_IDLE_MS = 7 * DAY_MS;
const TOUCH_EVERY_MS = 5 * 60 * 1000;
export const SESSION_COOKIE = "apr_session";

export type PublicUser = Pick<UserRow, "id" | "login" | "role">;

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function countUsers(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export async function createUser(db: Database, login: string, password: string, role: UserRow["role"]): Promise<PublicUser> {
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(login)) throw new Error("login: 2–40 letters, digits, dot, dash or underscore");
  if (password.length < 10) throw new Error("password: at least 10 characters");
  const id = newId();
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  db.query("INSERT INTO users (id, login, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)").run(id, login, hash, role, Date.now());
  return { id, login, role };
}

// Verifying against a fixed hash when the login is unknown keeps response times from
// telling which logins exist.
let dummyHash: Promise<string> | undefined;

export async function verifyLogin(db: Database, login: string, password: string): Promise<PublicUser | null> {
  const user = db.query("SELECT * FROM users WHERE login = ?").get(login) as UserRow | null;
  dummyHash ??= Bun.password.hash("not-a-real-password", { algorithm: "argon2id" });
  const ok = await Bun.password.verify(password, user?.password_hash ?? (await dummyHash));
  if (user === null || !ok || user.disabled) return null;
  return { id: user.id, login: user.login, role: user.role };
}

export function createSession(db: Database, userId: string, ip: string | null, userAgent: string | null): string {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const now = Date.now();
  db.query("INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    sha256(token), userId, now, now, now + SESSION_ABSOLUTE_MS, ip, userAgent?.slice(0, 200) ?? null,
  );
  return token;
}

export function resolveSession(db: Database, token: string | undefined): PublicUser | null {
  if (!token) return null;
  const id = sha256(token);
  const row = db
    .query(
      `SELECT s.id, s.last_seen_at, s.expires_at, u.id AS user_id, u.login, u.role, u.disabled
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(id) as { last_seen_at: number; expires_at: number; user_id: string; login: string; role: UserRow["role"]; disabled: number } | null;
  const now = Date.now();
  if (row === null || row.disabled || row.expires_at < now || row.last_seen_at + SESSION_IDLE_MS < now) {
    if (row !== null) db.query("DELETE FROM sessions WHERE id = ?").run(id);
    return null;
  }
  if (now - row.last_seen_at > TOUCH_EVERY_MS) db.query("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now, id);
  return { id: row.user_id, login: row.login, role: row.role };
}

export function deleteSession(db: Database, token: string | undefined): void {
  if (token) db.query("DELETE FROM sessions WHERE id = ?").run(sha256(token));
}

/** v1 deployments had one Basic-auth password; it becomes the first admin's password. */
export async function bootstrapAdmin(db: Database, env: Record<string, string | undefined>): Promise<PublicUser | null> {
  if (countUsers(db) > 0 || !env.PANEL_PASSWORD) return null;
  return createUser(db, env.PANEL_USER || "admin", env.PANEL_PASSWORD, "admin");
}

/** Failed logins per key (ip, login) in a sliding window. */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  constructor(private readonly max = 10, private readonly windowMs = 15 * 60 * 1000) {}

  blocked(key: string): boolean {
    const now = Date.now();
    const recent = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.failures.set(key, recent);
    return recent.length >= this.max;
  }

  fail(key: string): void {
    this.failures.set(key, [...(this.failures.get(key) ?? []), Date.now()]);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}

const INVITE_TTL_MS = 7 * DAY_MS;

/** A one-time link; only its hash is stored. */
export function createInvite(db: Database, createdBy: string, role: UserRow["role"], note = ""): { id: string; token: string; expiresAt: number } {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  const id = sha256(token);
  const expiresAt = Date.now() + INVITE_TTL_MS;
  db.query("INSERT INTO invites (id, created_by, role, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, createdBy, role, note, Date.now(), expiresAt);
  return { id, token, expiresAt };
}

export function findInvite(db: Database, token: string): { id: string; role: UserRow["role"] } | null {
  const row = db.query("SELECT id, role FROM invites WHERE id = ? AND used_at IS NULL AND expires_at > ?").get(sha256(token), Date.now()) as
    | { id: string; role: UserRow["role"] }
    | null;
  return row;
}

/** Spends the invite and creates the user in one transaction, so a link works once. */
export async function acceptInvite(db: Database, token: string, login: string, password: string): Promise<PublicUser> {
  const invite = findInvite(db, token);
  if (invite === null) throw new Error("this invite link is used, expired or revoked");
  if (db.query("SELECT 1 FROM users WHERE login = ?").get(login)) throw new Error("that login is taken");
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(login)) throw new Error("login: 2–40 letters, digits, dot, dash or underscore");
  if (password.length < 10) throw new Error("password: at least 10 characters");
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  const id = newId();
  db.transaction(() => {
    const spent = db.query("UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL").run(Date.now(), id, invite.id);
    if (spent.changes !== 1) throw new Error("this invite link is used, expired or revoked");
    db.query("INSERT INTO users (id, login, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)").run(id, login, hash, invite.role, Date.now());
  })();
  return { id, login, role: invite.role };
}

export async function changePassword(db: Database, userId: string, current: string, next: string): Promise<void> {
  const user = db.query("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | null;
  if (user === null || !(await Bun.password.verify(current, user.password_hash))) throw new Error("the current password is wrong");
  if (next.length < 10) throw new Error("password: at least 10 characters");
  db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(await Bun.password.hash(next, { algorithm: "argon2id" }), userId);
}

const API_TOKEN_PREFIX = "apr_";

/** A personal token for the CLI; shown once, stored as a hash. */
export function createApiToken(db: Database, userId: string, label: string): { id: string; token: string } {
  const token = API_TOKEN_PREFIX + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const id = sha256(token);
  db.query("INSERT INTO api_tokens (id, user_id, label, hint, created_at) VALUES (?, ?, ?, ?, ?)").run(id, userId, label, `…${token.slice(-4)}`, Date.now());
  return { id, token };
}

export function resolveApiToken(db: Database, header: string | undefined): PublicUser | null {
  const token = /^Bearer (apr_[\w-]+)$/.exec(header ?? "")?.[1];
  if (!token) return null;
  const id = sha256(token);
  const row = db
    .query("SELECT t.last_used_at, u.id, u.login, u.role, u.disabled FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ?")
    .get(id) as { last_used_at: number | null; id: string; login: string; role: UserRow["role"]; disabled: number } | null;
  if (row === null || row.disabled) return null;
  if (!row.last_used_at || Date.now() - row.last_used_at > TOUCH_EVERY_MS) db.query("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
  return { id: row.id, login: row.login, role: row.role };
}
