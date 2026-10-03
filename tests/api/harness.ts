import { memoryDb } from "../../src/store/db.js";
import { SecretBox } from "../../src/store/secrets.js";
import { createApp } from "../../src/api/app.js";
import { createUser } from "../../src/auth/auth.js";
import { Runtime, type Deps } from "../../src/runtime.js";
import { fakeGitHub } from "../fakes/github.js";
import type { RunResult } from "../../src/review/claude.js";
import type { Finding } from "../../src/review/finding.js";

export const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
export const GH_TOKEN = "ghtest_octo_token_value_000000000000";
export const GH_TOKEN_BOB = "ghtest_bob_token_value_0000000000000";
export const CLAUDE_TOKEN = "claudetest_token_value_0000000000000";

export function scriptedClaude(findings: Finding[] = []) {
  const calls: { system: string; user: string }[] = [];
  const callClaude: Deps["callClaude"] = async (req) => {
    calls.push({ system: req.system, user: req.user });
    const result: RunResult = {
      outcome: findings.length ? "findings" : "no_findings",
      findings,
      latencyMs: 5,
      usage: { input: 100, output: 10 },
      limits: { fiveHour: { utilization: 0.1, resetsAt: Date.now() + 3600_000 }, checkedAt: Date.now() },
    };
    return result;
  };
  return { calls, callClaude };
}

/** A runtime on an in-memory database with fake GitHub and Claude, and a cookie-keeping client. */
export function harness(opts: { findings?: Finding[]; probeFails?: boolean } = {}) {
  const gh = fakeGitHub({ [GH_TOKEN]: "octo", [GH_TOKEN_BOB]: "bob" });
  const claude = scriptedClaude(opts.findings);
  const rt = new Runtime({
    db: memoryDb(),
    box: new SecretBox(TEST_KEY),
    dataDir: "/tmp/apr-test",
    quiet: true,
    deps: {
      githubBase: gh.url,
      callClaude: claude.callClaude,
      probeLimits: async () => {
        if (opts.probeFails) throw new Error("Failed to authenticate. API Error: 401 Invalid bearer token");
        return { fiveHour: { utilization: 0.07, resetsAt: Date.now() + 3600_000 }, sevenDay: { utilization: 0.2, resetsAt: Date.now() + 86400_000 }, checkedAt: Date.now() };
      },
    },
  });
  // Polls run inline in tests; the real scheduler is not started.
  rt.setPollHandler(async (targetId) => {
    const { pollTarget } = await import("../../src/scheduler/targets.js");
    const ids = targetId ? [targetId] : (rt.db.query("SELECT id FROM targets").all() as { id: string }[]).map((r) => r.id);
    for (const id of ids) {
      const t = rt.db.query("SELECT * FROM targets WHERE id = ?").get(id) as never;
      await pollTarget(rt, t).catch(() => {});
    }
  });
  const app = createApp(rt, {});

  function client() {
    let cookie = "";
    async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
      const res = await app.request(`http://localhost${path}`, {
        method,
        headers: {
          host: "localhost",
          ...(cookie ? { cookie } : {}),
          ...(method !== "GET" ? { "x-requested-with": "fetch", "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = /max-age=0/i.test(set) ? "" : set.split(";")[0]!;
      return res;
    }
    async function json<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
      const res = await call(method, path, body);
      return { status: res.status, body: (await res.json()) as T };
    }
    async function signIn(login = "owner", password = "correct horse battery", role: "admin" | "member" = "admin"): Promise<string> {
      const user = await createUser(rt.db, login, password, role);
      const res = await call("POST", "/api/v1/auth/login", { login, password });
      if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
      return user.id;
    }
    return { call, json, signIn, clearCookie: () => (cookie = "") };
  }

  const main = client();
  /** Signs in, adds the octo account and a Claude credential attached to it. */
  async function ready(): Promise<{ accountId: string; credentialId: string }> {
    await main.signIn();
    const account = await main.json("POST", "/api/v1/accounts", { token: GH_TOKEN, label: "work" });
    const credential = await main.json("POST", "/api/v1/credentials", { provider: "claude-cli", token: CLAUDE_TOKEN });
    await main.json("PATCH", `/api/v1/accounts/${account.body.account.id}`, { credentialId: credential.body.credential.id });
    return { accountId: account.body.account.id, credentialId: credential.body.credential.id };
  }

  return { rt, app, gh, claude, ...main, client, ready, stop: () => gh.stop() };
}
