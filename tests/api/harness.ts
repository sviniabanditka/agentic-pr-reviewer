import { memoryDb } from "../../src/store/db.js";
import { SecretBox } from "../../src/store/secrets.js";
import { createApp } from "../../src/api/app.js";
import { createUser } from "../../src/auth/auth.js";
import { Runtime } from "../../src/runtime.js";
import type { Config } from "../../src/config.js";

export const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    pollIntervalSec: 30,
    models: ["sonnet", "opus", "haiku"],
    dataDir: "/tmp/apr-test",
    port: 0,
    accounts: [
      { name: "work", login: "octo", model: "sonnet", triggers: ["review_requested", "author"], githubToken: "gh-test", claudeToken: "cl-test" },
    ],
    ...overrides,
  };
}

/** A runtime on an in-memory database and the Hono app over it, plus a cookie-keeping client. */
export function harness(cfg = testConfig()) {
  const rt = new Runtime(cfg, memoryDb(), new SecretBox(TEST_KEY), true);
  const app = createApp(rt);
  let cookie = "";

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        host: "localhost",
        ...(cookie ? { cookie } : {}),
        ...(method !== "GET" ? { "x-requested-with": "fetch", "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const res = await app.request(`http://localhost${path}`, init);
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!.includes("=;") || /max-age=0/i.test(set) ? "" : set.split(";")[0]!;
    return res;
  }

  async function signIn(login = "owner", password = "correct horse battery"): Promise<void> {
    await createUser(rt.db, login, password, "admin");
    const res = await call("POST", "/api/v1/auth/login", { login, password });
    if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  }

  return { rt, app, call, signIn, clearCookie: () => (cookie = "") };
}
