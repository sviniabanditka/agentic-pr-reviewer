import { afterEach, describe, expect, it } from "bun:test";
import { harness } from "./harness.js";
import { runNext } from "../../src/jobs/worker.js";
import { Client, loadConfig, parseArgs, reviewDiff } from "../../src/cli/apr.js";
import type { Finding } from "../../src/review/finding.js";

let h: ReturnType<typeof harness>;
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  h?.stop();
});

const DIFF = ["diff --git a/src/b.ts b/src/b.ts", "--- a/src/b.ts", "+++ b/src/b.ts", "@@ -1,1 +1,1 @@", "-let b = check(user);", "+let b = 2;", ""].join("\n");
const guard: Finding = { category: "GUARD-REMOVED", file: "src/b.ts", line_start: 1, line_end: 1, evidence: "let b = check(user);", evidence_kind: "removed", claim: "check removed", detail: "d" };

describe("api tokens", () => {
  it("a token authenticates without cookies or csrf headers, cannot mint tokens or reach admin, and can be revoked", async () => {
    h = harness();
    await h.ready();
    const created = await h.json("POST", "/api/v1/tokens", { label: "laptop" });
    expect(created.status).toBe(201);
    const token = created.body.token as string;
    expect(token).toStartWith("apr_");
    const list = await h.json("GET", "/api/v1/tokens");
    expect(JSON.stringify(list.body)).not.toContain(token);

    const bearer = (method: string, path: string, body?: unknown) =>
      h.app.request(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect((await bearer("GET", "/api/v1/state")).status).toBe(200);
    expect((await bearer("POST", "/api/v1/tokens", { label: "x" })).status).toBe(403);
    expect((await bearer("GET", "/api/v1/admin/users")).status).toBe(403);
    expect((await h.app.request("http://localhost/api/v1/state", { headers: { authorization: "Bearer apr_wrong" } })).status).toBe(401);

    await h.json("DELETE", `/api/v1/tokens/${created.body.id}`);
    expect((await bearer("GET", "/api/v1/state")).status).toBe(401);
  });
});

describe("apr cli", () => {
  it("parses options and reads config from the environment", () => {
    expect(parseArgs(["review", "develop", "--title", "t", "--json"])).toMatchObject({ cmd: "review", base: "develop", title: "t", json: true, staged: false });
    expect(() => parseArgs(["review", "--nope"])).toThrow();
    expect(loadConfig({ APR_URL: "https://x/", APR_TOKEN: "apr_t", HOME: "/nonexistent" })).toEqual({ url: "https://x", token: "apr_t" });
    expect(() => loadConfig({ HOME: "/nonexistent" })).toThrow();
  });

  it("reviews a local diff end to end and returns the markdown; nothing reaches GitHub", async () => {
    h = harness({ findings: [guard] });
    await h.ready();
    const { token } = (await h.json("POST", "/api/v1/tokens", { label: "cli" })).body;
    server = Bun.serve({ port: 0, fetch: h.app.fetch });
    const worker = setInterval(() => void runNext(h.rt), 20);
    try {
      const statuses: string[] = [];
      const { review, markdown } = await reviewDiff(new Client({ url: `http://localhost:${server.port}`, token }), { diff: DIFF, title: "local work", repo: "o/r" }, (s) => statuses.push(s), 20);
      expect(review).toMatchObject({ status: "done", conclusion: "action_required" });
      expect(markdown).toContain("check removed");
      expect(statuses.at(-1)).toBe("done");
      expect(h.gh.writes).toHaveLength(0);
    } finally {
      clearInterval(worker);
    }
  });
});
