import { newId } from "../store/db.js";
import { getSetting } from "../store/repos.js";
import { addAccount, InputError } from "./service.js";
import type { Runtime } from "../runtime.js";

const WEB = process.env.GITHUB_WEB_URL ?? "https://github.com";
const TTL_MS = 15 * 60 * 1000;

interface Pending {
  userId: string;
  deviceCode: string;
  label?: string;
  expiresAt: number;
}

// ponytail: in memory — a restart drops pending logins, the person just clicks again.
const pending = new Map<string, Pending>();

async function post<T>(path: string, body: Record<string, string>): Promise<T> {
  const res = await fetch(`${WEB}${path}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new InputError(`GitHub answered ${res.status}`);
  return (await res.json()) as T;
}

function clientId(rt: Runtime): string {
  const id = getSetting<string>(rt.db, "", "github_oauth_client_id", "");
  if (!id) throw new InputError("signing in with GitHub needs an OAuth app: an admin sets its client id in settings");
  return id;
}

/** Starts a device login: the person opens the URL, types the code, and the panel polls. */
export async function startDeviceLogin(rt: Runtime, userId: string, label?: string) {
  const r = await post<{ device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number; error?: string }>(
    "/login/device/code",
    { client_id: clientId(rt), scope: "repo read:org" },
  );
  if (r.error) throw new InputError(`GitHub refused the device login: ${r.error}`);
  const id = newId();
  pending.set(id, { userId, deviceCode: r.device_code, ...(label ? { label } : {}), expiresAt: Date.now() + Math.min(r.expires_in * 1000, TTL_MS) });
  return { id, userCode: r.user_code, verificationUri: r.verification_uri, interval: r.interval };
}

/** One poll: "pending" until the person confirms, then the account is added like a pasted token. */
export async function pollDeviceLogin(rt: Runtime, userId: string, id: string) {
  const p = pending.get(id);
  if (!p || p.userId !== userId) throw new InputError("no such login; start again");
  if (Date.now() > p.expiresAt) {
    pending.delete(id);
    throw new InputError("the code expired; start again");
  }
  const r = await post<{ access_token?: string; error?: string }>("/login/oauth/access_token", {
    client_id: clientId(rt),
    device_code: p.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (r.error === "authorization_pending" || r.error === "slow_down") return { status: "pending" as const };
  pending.delete(id);
  if (!r.access_token) throw new InputError(`GitHub refused the login: ${r.error ?? "no token"}`);
  return { status: "done" as const, account: await addAccount(rt, userId, { token: r.access_token, ...(p.label ? { label: p.label } : {}) }) };
}
