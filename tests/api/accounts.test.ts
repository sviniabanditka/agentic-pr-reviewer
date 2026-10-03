import { afterEach, describe, expect, it } from "bun:test";
import { CLAUDE_TOKEN, GH_TOKEN, GH_TOKEN_BOB, harness } from "./harness.js";

let h: ReturnType<typeof harness>;
afterEach(() => h?.stop());

describe("accounts", () => {
  it("adds a GitHub account by token, never returns the token, refuses duplicates and bad tokens", async () => {
    h = harness();
    await h.signIn();
    const res = await h.json("POST", "/api/v1/accounts", { token: GH_TOKEN, label: "work" });
    expect(res.status).toBe(201);
    expect(res.body.account).toMatchObject({ login: "octo", label: "work", tokenHint: `…${GH_TOKEN.slice(-4)}`, scopes: "repo, read:org" });
    expect(JSON.stringify(res.body)).not.toContain(GH_TOKEN);
    expect(JSON.stringify(res.body)).not.toContain("secret");
    expect((await h.json("POST", "/api/v1/accounts", { token: GH_TOKEN })).status).toBe(400);
    expect((await h.json("POST", "/api/v1/accounts", { token: "ghtest_unknown_token_value_000000000" })).body.error).toContain("rejected");
    const row = h.rt.db.query("SELECT ciphertext FROM secrets").get() as { ciphertext: string };
    expect(row.ciphertext).not.toContain(GH_TOKEN);
  });

  it("deleting an account removes its secret", async () => {
    h = harness();
    await h.signIn();
    const a = await h.json("POST", "/api/v1/accounts", { token: GH_TOKEN });
    expect((await h.json("DELETE", `/api/v1/accounts/${a.body.account.id}`)).status).toBe(200);
    expect((h.rt.db.query("SELECT COUNT(*) AS n FROM secrets").get() as { n: number }).n).toBe(0);
  });
});

describe("credentials", () => {
  it("validates with a probe and stores the limits", async () => {
    h = harness();
    await h.signIn();
    const res = await h.json("POST", "/api/v1/credentials", { provider: "claude-cli", label: "personal", token: CLAUDE_TOKEN });
    expect(res.status).toBe(201);
    expect(res.body.credential).toMatchObject({ label: "personal", status: "ok" });
    expect(res.body.credential.limits.sevenDay.utilization).toBe(0.2);
  });

  it("a rejected token is not kept", async () => {
    h = harness({ probeFails: true });
    await h.signIn();
    const res = await h.json("POST", "/api/v1/credentials", { provider: "claude-cli", token: CLAUDE_TOKEN });
    expect(res.status).toBe(400);
    expect((h.rt.db.query("SELECT COUNT(*) AS n FROM credentials").get() as { n: number }).n).toBe(0);
    expect((h.rt.db.query("SELECT COUNT(*) AS n FROM secrets").get() as { n: number }).n).toBe(0);
  });
});

describe("isolation between users", () => {
  it("a user sees and touches only their own rows", async () => {
    h = harness();
    const { accountId } = await h.ready();
    h.gh.pulls.push({ repo: "o/r", number: 1, title: "x", author: "octo", headSha: "a1" });
    const t = await h.json("POST", "/api/v1/targets", { accountId, name: "Mine", type: "search", params: { query: "author:@me" } });
    await h.json("POST", `/api/v1/targets/${t.body.target.id}/poll`);
    const item = (await h.json("GET", "/api/v1/items")).body.items[0];

    const bob = h.client();
    await bob.signIn("bob", "another long password", "member");
    expect((await bob.json("GET", "/api/v1/accounts")).body.accounts).toEqual([]);
    expect((await bob.json("GET", "/api/v1/items")).body.items).toEqual([]);
    expect((await bob.json("GET", `/api/v1/items/${item.id}`)).status).toBe(404);
    expect((await bob.json("POST", "/api/v1/reviews", { itemId: item.id })).status).toBe(409);
    expect((await bob.json("PATCH", `/api/v1/accounts/${accountId}`, { label: "x" })).status).toBe(404);
    expect((await bob.json("DELETE", `/api/v1/targets/${t.body.target.id}`)).status).toBe(404);
    expect((await bob.json("POST", "/api/v1/targets", { accountId, name: "steal", type: "search", params: { query: "x" } })).status).toBe(400);
    expect((await bob.json("PATCH", "/api/v1/settings", { models: ["x"] })).status).toBe(403);
    // bob adds his own account and sees only that
    await bob.json("POST", "/api/v1/accounts", { token: GH_TOKEN_BOB });
    expect((await bob.json("GET", "/api/v1/accounts")).body.accounts.map((a: { login: string }) => a.login)).toEqual(["bob"]);
  });
});
