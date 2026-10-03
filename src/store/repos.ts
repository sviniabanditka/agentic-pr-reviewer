import type { Database } from "bun:sqlite";
import { newId } from "./db.js";

// Every function that reads owner-scoped rows takes a userId. The `*Any` variants exist
// for background work (scheduler, worker) that acts on behalf of whoever owns the row.

export interface CredentialRow {
  id: string;
  user_id: string;
  provider: string;
  label: string;
  secret_id: string;
  token_hint: string;
  status: string;
  status_detail: string | null;
  limits_json: string | null;
  checked_at: number | null;
  created_at: number;
}

export interface AccountRow {
  id: string;
  user_id: string;
  kind: string;
  login: string;
  label: string;
  token_secret_id: string;
  token_hint: string;
  scopes: string | null;
  credential_id: string | null;
  model: string | null;
  profile_id: string | null;
  status: string;
  status_detail: string | null;
  checked_at: number | null;
  created_at: number;
}

export type TargetType = "search" | "repo" | "pr";
export type Automation = "manual" | "auto-review" | "auto-post";

export interface TargetFilters {
  /** Include draft PRs. Default false. */
  drafts?: boolean;
  /** Include PRs opened by bots. Default false. */
  bots?: boolean;
  labelsInclude?: string[];
  labelsExclude?: string[];
  authorsInclude?: string[];
  authorsExclude?: string[];
  /** Repository owners allowed; empty = any. */
  owners?: string[];
  maxChangedFiles?: number;
}

export interface TargetParams {
  /** search: qualifiers after `is:pr is:open` */
  query?: string;
  /** repo and pr */
  repo?: string;
  /** pr */
  number?: number;
  /** How items found by this target relate to the account. */
  role?: "author" | "review_requested" | "watching";
}

export interface TargetRow {
  id: string;
  user_id: string;
  account_id: string;
  name: string;
  type: TargetType;
  params_json: string;
  filters_json: string;
  automation: Automation;
  model: string | null;
  profile_id: string | null;
  poll_sec: number;
  enabled: number;
  last_polled_at: number | null;
  last_error: string | null;
  next_poll_at: number;
  created_at: number;
}

export interface ItemRow {
  id: string;
  user_id: string;
  account_id: string;
  kind: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  author_is_bot: number;
  role: string;
  head_sha: string | null;
  base_sha: string | null;
  updated_at: string | null;
  state: string;
  draft: number;
  labels_json: string;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  target_ids_json: string;
  comment_id: number | null;
  first_seen_at: number;
  last_seen_at: number;
  ref_key: string;
  compare_base: string | null;
  compare_head: string | null;
  patch_text: string | null;
}

type Value = string | number | null;

function updateRow(db: Database, table: string, id: string, userId: string | null, fields: Record<string, Value | undefined>): void {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined) as [string, Value][];
  if (entries.length === 0) return;
  const where = userId === null ? "id = ?" : "id = ? AND user_id = ?";
  db.query(`UPDATE ${table} SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE ${where}`).run(
    ...entries.map(([, v]) => v),
    id,
    ...(userId === null ? [] : [userId]),
  );
}

// ── credentials ───────────────────────────────────────────────────
export function listCredentials(db: Database, userId: string): CredentialRow[] {
  return db.query("SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at").all(userId) as CredentialRow[];
}
export function getCredential(db: Database, userId: string, id: string): CredentialRow | null {
  return db.query("SELECT * FROM credentials WHERE id = ? AND user_id = ?").get(id, userId) as CredentialRow | null;
}
export function getCredentialAny(db: Database, id: string): CredentialRow | null {
  return db.query("SELECT * FROM credentials WHERE id = ?").get(id) as CredentialRow | null;
}
export function allCredentials(db: Database): CredentialRow[] {
  return db.query("SELECT * FROM credentials ORDER BY created_at").all() as CredentialRow[];
}
export function insertCredential(db: Database, row: Omit<CredentialRow, "id" | "created_at" | "status" | "status_detail" | "limits_json" | "checked_at"> & Partial<CredentialRow>): CredentialRow {
  const id = newId();
  db.query(
    `INSERT INTO credentials (id, user_id, provider, label, secret_id, token_hint, status, status_detail, limits_json, checked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, row.user_id, row.provider, row.label, row.secret_id, row.token_hint, row.status ?? "unknown", row.status_detail ?? null, row.limits_json ?? null, row.checked_at ?? null, Date.now());
  return getCredentialAny(db, id)!;
}
export function updateCredential(db: Database, userId: string | null, id: string, fields: Partial<Omit<CredentialRow, "id" | "user_id">>): void {
  updateRow(db, "credentials", id, userId, fields);
}
export function deleteCredential(db: Database, userId: string, id: string): CredentialRow | null {
  return db.query("DELETE FROM credentials WHERE id = ? AND user_id = ? RETURNING *").get(id, userId) as CredentialRow | null;
}

// ── accounts ──────────────────────────────────────────────────────
export function listAccounts(db: Database, userId: string): AccountRow[] {
  return db.query("SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at").all(userId) as AccountRow[];
}
export function getAccount(db: Database, userId: string, id: string): AccountRow | null {
  return db.query("SELECT * FROM accounts WHERE id = ? AND user_id = ?").get(id, userId) as AccountRow | null;
}
export function getAccountAny(db: Database, id: string): AccountRow | null {
  return db.query("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | null;
}
export function allAccounts(db: Database): AccountRow[] {
  return db.query("SELECT * FROM accounts ORDER BY created_at").all() as AccountRow[];
}
export function insertAccount(db: Database, row: Pick<AccountRow, "user_id" | "login" | "label" | "token_secret_id" | "token_hint"> & Partial<AccountRow>): AccountRow {
  const id = newId();
  db.query(
    `INSERT INTO accounts (id, user_id, kind, login, label, token_secret_id, token_hint, scopes, credential_id, model, status, checked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, row.user_id, row.kind ?? "github", row.login, row.label, row.token_secret_id, row.token_hint, row.scopes ?? null, row.credential_id ?? null, row.model ?? null, row.status ?? "ok", row.checked_at ?? Date.now(), Date.now());
  return getAccountAny(db, id)!;
}
export function updateAccount(db: Database, userId: string | null, id: string, fields: Partial<Omit<AccountRow, "id" | "user_id">>): void {
  updateRow(db, "accounts", id, userId, fields);
}
export function deleteAccount(db: Database, userId: string, id: string): AccountRow | null {
  return db.query("DELETE FROM accounts WHERE id = ? AND user_id = ? RETURNING *").get(id, userId) as AccountRow | null;
}

// ── targets ───────────────────────────────────────────────────────
export function listTargets(db: Database, userId: string): TargetRow[] {
  return db.query("SELECT * FROM targets WHERE user_id = ? ORDER BY created_at").all(userId) as TargetRow[];
}
export function getTarget(db: Database, userId: string, id: string): TargetRow | null {
  return db.query("SELECT * FROM targets WHERE id = ? AND user_id = ?").get(id, userId) as TargetRow | null;
}
export function getTargetAny(db: Database, id: string): TargetRow | null {
  return db.query("SELECT * FROM targets WHERE id = ?").get(id) as TargetRow | null;
}
export function dueTargets(db: Database, now = Date.now()): TargetRow[] {
  return db.query("SELECT * FROM targets WHERE enabled = 1 AND next_poll_at <= ? ORDER BY next_poll_at LIMIT 20").all(now) as TargetRow[];
}
export function insertTarget(
  db: Database,
  row: Pick<TargetRow, "user_id" | "account_id" | "name" | "type"> & { params: TargetParams; filters?: TargetFilters } & Partial<Pick<TargetRow, "automation" | "model" | "poll_sec" | "enabled">>,
): TargetRow {
  const id = newId();
  db.query(
    `INSERT INTO targets (id, user_id, account_id, name, type, params_json, filters_json, automation, model, poll_sec, enabled, next_poll_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(id, row.user_id, row.account_id, row.name, row.type, JSON.stringify(row.params), JSON.stringify(row.filters ?? {}), row.automation ?? "manual", row.model ?? null, row.poll_sec ?? 60, row.enabled ?? 1, Date.now());
  return getTargetAny(db, id)!;
}
export function updateTarget(db: Database, userId: string | null, id: string, fields: Partial<Omit<TargetRow, "id" | "user_id">>): void {
  updateRow(db, "targets", id, userId, fields);
}
export function deleteTarget(db: Database, userId: string, id: string): TargetRow | null {
  return db.query("DELETE FROM targets WHERE id = ? AND user_id = ? RETURNING *").get(id, userId) as TargetRow | null;
}

// ── items ─────────────────────────────────────────────────────────
export function getItem(db: Database, userId: string, id: string): ItemRow | null {
  return db.query("SELECT * FROM items WHERE id = ? AND user_id = ?").get(id, userId) as ItemRow | null;
}
export function getItemAny(db: Database, id: string): ItemRow | null {
  return db.query("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | null;
}
export function findItem(db: Database, accountId: string, repo: string, number: number): ItemRow | null {
  return db.query("SELECT * FROM items WHERE account_id = ? AND kind = 'pr' AND repo = ? AND number = ?").get(accountId, repo, number) as ItemRow | null;
}
export function itemsOfTarget(db: Database, targetId: string): ItemRow[] {
  return db.query("SELECT items.* FROM items, json_each(items.target_ids_json) t WHERE t.value = ?").all(targetId) as ItemRow[];
}
export function listItems(db: Database, userId: string, opts: { state?: string; accountId?: string; targetId?: string; limit?: number } = {}): ItemRow[] {
  const where = ["items.user_id = ?"];
  const args: Value[] = [userId];
  if (opts.state) {
    where.push("items.state = ?");
    args.push(opts.state);
  }
  if (opts.accountId) {
    where.push("items.account_id = ?");
    args.push(opts.accountId);
  }
  if (opts.targetId) {
    where.push("EXISTS (SELECT 1 FROM json_each(items.target_ids_json) t WHERE t.value = ?)");
    args.push(opts.targetId);
  }
  return db
    .query(`SELECT * FROM items WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`)
    .all(...args, opts.limit ?? 500) as ItemRow[];
}
export function insertItem(
  db: Database,
  row: Omit<ItemRow, "id" | "first_seen_at" | "last_seen_at" | "comment_id" | "ref_key" | "compare_base" | "compare_head" | "patch_text"> &
    Partial<Pick<ItemRow, "comment_id" | "ref_key" | "compare_base" | "compare_head" | "patch_text">>,
): ItemRow {
  const id = newId();
  const now = Date.now();
  db.query(
    `INSERT INTO items (id, user_id, account_id, kind, repo, number, title, url, author, author_is_bot, role, head_sha, base_sha, updated_at, state,
       draft, labels_json, additions, deletions, changed_files, target_ids_json, comment_id, first_seen_at, last_seen_at, ref_key, compare_base, compare_head, patch_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, row.user_id, row.account_id, row.kind, row.repo, row.number, row.title, row.url, row.author, row.author_is_bot, row.role,
    row.head_sha, row.base_sha, row.updated_at, row.state, row.draft, row.labels_json, row.additions, row.deletions, row.changed_files,
    row.target_ids_json, row.comment_id ?? null, now, now, row.ref_key ?? "", row.compare_base ?? null, row.compare_head ?? null, row.patch_text ?? null,
  );
  return getItemAny(db, id)!;
}
export function updateItem(db: Database, id: string, fields: Partial<Omit<ItemRow, "id" | "user_id" | "account_id">>): void {
  updateRow(db, "items", id, null, fields);
}

// ── settings ──────────────────────────────────────────────────────
export function getSetting<T>(db: Database, userId: string, key: string, fallback: T): T {
  const row = db.query("SELECT value_json FROM settings WHERE user_id = ? AND key = ?").get(userId, key) as { value_json: string } | null;
  return row === null ? fallback : (JSON.parse(row.value_json) as T);
}
export function setSetting(db: Database, userId: string, key: string, value: unknown): void {
  db.query(
    `INSERT INTO settings (user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(userId, key, JSON.stringify(value), Date.now());
}

// ── profiles ──────────────────────────────────────────────────────
export interface ProfileRow {
  id: string;
  user_id: string;
  name: string;
  mode: string;
  options_json: string;
  version: number;
  is_default: number;
  created_at: number;
  updated_at: number;
}

export function listProfiles(db: Database, userId: string): ProfileRow[] {
  return db.query("SELECT * FROM profiles WHERE user_id = ? ORDER BY is_default DESC, created_at").all(userId) as ProfileRow[];
}
export function getProfile(db: Database, userId: string, id: string): ProfileRow | null {
  return db.query("SELECT * FROM profiles WHERE id = ? AND user_id = ?").get(id, userId) as ProfileRow | null;
}
export function insertProfile(db: Database, row: { user_id: string; name: string; mode: string; options: unknown; is_default?: boolean }): ProfileRow {
  const id = newId();
  const now = Date.now();
  db.query("INSERT INTO profiles (id, user_id, name, mode, options_json, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, row.user_id, row.name, row.mode, JSON.stringify(row.options ?? {}), row.is_default ? 1 : 0, now, now,
  );
  return getProfile(db, row.user_id, id)!;
}
export function updateProfile(db: Database, userId: string, id: string, fields: { name?: string; mode?: string; options?: unknown }): void {
  const cur = getProfile(db, userId, id);
  if (cur === null) return;
  db.query("UPDATE profiles SET name = ?, mode = ?, options_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ?").run(
    fields.name ?? cur.name, fields.mode ?? cur.mode, fields.options !== undefined ? JSON.stringify(fields.options) : cur.options_json, Date.now(), id, userId,
  );
}
export function setDefaultProfile(db: Database, userId: string, id: string): void {
  db.transaction(() => {
    db.query("UPDATE profiles SET is_default = 0 WHERE user_id = ?").run(userId);
    db.query("UPDATE profiles SET is_default = 1 WHERE id = ? AND user_id = ?").run(id, userId);
  })();
}
export function deleteProfile(db: Database, userId: string, id: string): ProfileRow | null {
  return db.query("DELETE FROM profiles WHERE id = ? AND user_id = ? RETURNING *").get(id, userId) as ProfileRow | null;
}
