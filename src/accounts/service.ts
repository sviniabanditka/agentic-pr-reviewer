import { join } from "node:path";
import { GitHub, GitHubError } from "../github/client.js";
import { deleteSecret, fingerprint, getSecret, putSecret } from "../store/secrets.js";
import {
  getCredentialAny,
  insertAccount,
  insertCredential,
  listAccounts,
  updateAccount,
  updateCredential,
  type AccountRow,
  type CredentialRow,
} from "../store/repos.js";
import type { ClaudeLimits, ClaudeSettings } from "../review/claude.js";
import type { Runtime } from "../runtime.js";

export { PROVIDER_IDS as PROVIDERS } from "../providers/index.js";
import { PROVIDER_IDS } from "../providers/index.js";

/** A GitHub client for the account; the token is decrypted for this call only. */
export function githubFor(rt: Runtime, account: AccountRow): GitHub {
  return new GitHub(getSecret(rt.db, rt.requireBox(), account.token_secret_id), rt.deps.githubBase);
}

export function claudeSettingsFor(rt: Runtime, credential: CredentialRow, model: string): ClaudeSettings {
  return {
    provider: credential.provider,
    oauthToken: getSecret(rt.db, rt.requireBox(), credential.secret_id),
    model,
    // One state dir per credential, so two subscriptions never share Claude Code's local state.
    configDir: join(rt.dataDir, "claude", credential.id),
  };
}

export class InputError extends Error {}

/** Validates a GitHub token, stores it encrypted, returns the new account. */
export async function addAccount(rt: Runtime, userId: string, input: { token: string; label?: string }): Promise<AccountRow> {
  const token = input.token.trim();
  if (token.length < 20) throw new InputError("that does not look like a GitHub token");
  const gh = new GitHub(token, rt.deps.githubBase);
  let who;
  try {
    who = await gh.whoami();
  } catch (error) {
    throw new InputError(error instanceof GitHubError && error.status === 401 ? "GitHub rejected the token" : `could not check the token: ${error instanceof Error ? error.message : error}`);
  }
  if (listAccounts(rt.db, userId).some((a) => a.login.toLowerCase() === who.login.toLowerCase())) {
    throw new InputError(`@${who.login} is already added`);
  }
  const secretId = putSecret(rt.db, rt.requireBox(), userId, "github-token", token);
  const account = insertAccount(rt.db, {
    user_id: userId,
    login: who.login,
    label: input.label?.trim() || who.login,
    token_secret_id: secretId,
    token_hint: fingerprint(token),
    scopes: who.scopes?.join(", ") ?? null,
  });
  rt.githubRate.set(account.id, { core: gh.rate.get("core") });
  rt.log("info", `account @${who.login} added`, { userId, account: account.label });
  return account;
}

/** Re-checks a token: still valid, still the same login, current scopes and quota. */
export async function checkAccount(rt: Runtime, account: AccountRow): Promise<AccountRow> {
  const gh = githubFor(rt, account);
  try {
    const who = await gh.whoami();
    const quota = await gh.rateLimit();
    rt.githubRate.set(account.id, quota);
    const wrong = who.login.toLowerCase() !== account.login.toLowerCase();
    updateAccount(rt.db, null, account.id, {
      status: wrong ? "invalid" : "ok",
      status_detail: wrong ? `token now belongs to @${who.login}` : null,
      scopes: who.scopes?.join(", ") ?? account.scopes,
      checked_at: Date.now(),
    });
  } catch (error) {
    const invalid = error instanceof GitHubError && error.status === 401;
    updateAccount(rt.db, null, account.id, {
      status: invalid ? "invalid" : "error",
      status_detail: error instanceof Error ? error.message : String(error),
      checked_at: Date.now(),
    });
  }
  return { ...account, ...(rt.db.query("SELECT * FROM accounts WHERE id = ?").get(account.id) as AccountRow) };
}

export function replaceAccountToken(rt: Runtime, account: AccountRow, token: string): void {
  const secretId = putSecret(rt.db, rt.requireBox(), account.user_id, "github-token", token.trim());
  updateAccount(rt.db, null, account.id, { token_secret_id: secretId, token_hint: fingerprint(token.trim()) });
  deleteSecret(rt.db, account.token_secret_id);
}

/** Validates a model credential with a probe, stores it encrypted. */
export async function addCredential(rt: Runtime, userId: string, input: { provider: string; label?: string; token: string }): Promise<CredentialRow> {
  if (!PROVIDER_IDS.includes(input.provider)) throw new InputError(`unknown provider ${input.provider}`);
  const token = input.token.trim();
  if (token.length < 20) throw new InputError(input.provider === "anthropic-api" ? "that does not look like an Anthropic API key" : "that does not look like a token from `claude setup-token`");
  const secretId = putSecret(rt.db, rt.requireBox(), userId, "claude-token", token);
  const credential = insertCredential(rt.db, {
    user_id: userId,
    provider: input.provider,
    label: input.label?.trim() || "Claude subscription",
    secret_id: secretId,
    token_hint: fingerprint(token),
  });
  const checked = await checkCredential(rt, credential);
  if (checked.status === "invalid") {
    rt.db.query("DELETE FROM credentials WHERE id = ?").run(credential.id);
    deleteSecret(rt.db, secretId);
    throw new InputError(`Claude rejected the token: ${checked.status_detail ?? "unknown error"}`);
  }
  rt.log("info", `credential "${checked.label}" added`, { userId });
  return checked;
}

/** Probes the subscription: validity plus the 5-hour and 7-day usage windows. */
export async function checkCredential(rt: Runtime, credential: CredentialRow): Promise<CredentialRow> {
  try {
    const limits = await rt.deps.probeLimits(claudeSettingsFor(rt, credential, "haiku"));
    recordLimits(rt, credential, limits);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    updateCredential(rt.db, null, credential.id, {
      status: /401|invalid|not logged in|authenticate/i.test(detail) ? "invalid" : "error",
      status_detail: detail.slice(0, 300),
      checked_at: Date.now(),
    });
  }
  const fresh = getCredentialAny(rt.db, credential.id)!;
  rt.bus.emit({ type: "status", data: { credential: publicCredential(fresh) }, userId: fresh.user_id });
  return fresh;
}

export function recordLimits(rt: Runtime, credential: CredentialRow, limits: ClaudeLimits | undefined): void {
  updateCredential(rt.db, null, credential.id, {
    status: "ok",
    status_detail: null,
    ...(limits !== undefined ? { limits_json: JSON.stringify(limits) } : {}),
    checked_at: Date.now(),
  });
  const fresh = getCredentialAny(rt.db, credential.id);
  if (fresh) rt.bus.emit({ type: "status", data: { credential: publicCredential(fresh) }, userId: fresh.user_id });
}

// ── what the API returns: never secret ids or tokens ──────────────
export function publicAccount(rt: Runtime, a: AccountRow) {
  return {
    id: a.id,
    login: a.login,
    label: a.label,
    kind: a.kind,
    tokenHint: a.token_hint,
    scopes: a.scopes,
    credentialId: a.credential_id,
    model: a.model,
    profileId: a.profile_id,
    status: a.status,
    statusDetail: a.status_detail,
    checkedAt: a.checked_at,
    github: rt.githubRate.get(a.id) ?? null,
  };
}

export function publicCredential(c: CredentialRow) {
  return {
    id: c.id,
    provider: c.provider,
    label: c.label,
    tokenHint: c.token_hint,
    status: c.status,
    statusDetail: c.status_detail,
    limits: c.limits_json ? (JSON.parse(c.limits_json) as ClaudeLimits) : null,
    checkedAt: c.checked_at,
  };
}
