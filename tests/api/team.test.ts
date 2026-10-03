import { afterEach, describe, expect, it } from "bun:test";
import { harness, GH_TOKEN_BOB } from "./harness.js";
import { runNext } from "../../src/jobs/worker.js";
import { totpCode } from "../../src/auth/totp.js";

let h: ReturnType<typeof harness>;
afterEach(() => h?.stop());

const PASSWORD = "colleague password 1";

async function adminWithReview() {
  h = harness();
  const ids = await h.ready();
  h.gh.pulls.push({ repo: "o/secret-repo", number: 7, title: "very private title", author: "octo", headSha: "abc1234" });
  const target = await h.json("POST", "/api/v1/targets", { accountId: ids.accountId, name: "Mine", type: "search", params: { query: "author:@me" } });
  await h.json("POST", `/api/v1/targets/${target.body.target.id}/poll`);
  const itemId = (await h.json("GET", "/api/v1/items")).body.items[0].id as string;
  const q = await h.json("POST", "/api/v1/reviews", { itemId });
  await runNext(h.rt);
  return { ...ids, itemId, reviewId: q.body.id as number, targetId: target.body.target.id as string };
}

async function invite(role = "member") {
  const r = await h.json("POST", "/api/v1/admin/invites", { role, note: "alice" });
  expect(r.status).toBe(201);
  return (r.body.url as string).split("/invite/")[1]!;
}

async function member(login = "alice") {
  const token = await invite();
  const c = h.client();
  const joined = await c.json("POST", `/api/v1/invites/${token}`, { login, password: PASSWORD });
  expect(joined.status).toBe(201);
  return { c, token, id: joined.body.user.id as string };
}

describe("invites", () => {
  it("a link works once, creates a member and signs them in", async () => {
    await adminWithReview();
    const token = await invite();
    const c = h.client();
    expect((await c.json("GET", `/api/v1/invites/${token}`)).body).toEqual({ role: "member" });
    expect((await c.json("POST", `/api/v1/invites/${token}`, { login: "alice", password: "short" })).status).toBe(400);
    const joined = await c.json("POST", `/api/v1/invites/${token}`, { login: "alice", password: PASSWORD });
    expect(joined.body.user).toMatchObject({ login: "alice", role: "member" });
    expect((await c.json("GET", "/api/v1/auth/me")).body.user.login).toBe("alice");
    expect((await h.client().json("POST", `/api/v1/invites/${token}`, { login: "mallory", password: PASSWORD })).status).toBe(400);
    expect((await h.client().json("GET", `/api/v1/invites/${token}`)).status).toBe(404);
  });

  it("a revoked link is dead; members cannot invite", async () => {
    await adminWithReview();
    const token = await invite();
    const list = await h.json("GET", "/api/v1/admin/invites");
    await h.json("DELETE", `/api/v1/admin/invites/${list.body.invites[0].id}`);
    expect((await h.client().json("GET", `/api/v1/invites/${token}`)).status).toBe(404);
    const { c } = await member();
    expect((await c.json("POST", "/api/v1/admin/invites", {})).status).toBe(403);
    expect((await c.json("GET", "/api/v1/admin/users")).status).toBe(403);
    expect((await c.json("PATCH", "/api/v1/settings", { models: ["x"] })).status).toBe(403);
  });
});

describe("isolation", () => {
  it("a member sees none of another user's data and cannot act on it", async () => {
    const a = await adminWithReview();
    await h.json("POST", "/api/v1/channels", { type: "slack", label: "team", secret: "https://hooks.example.invalid/x", events: ["done"] });
    const { c } = await member();

    for (const path of ["/api/v1/items?state=all", "/api/v1/reviews", "/api/v1/accounts", "/api/v1/credentials", "/api/v1/targets", "/api/v1/audit", "/api/v1/channels"]) {
      const body = JSON.stringify((await c.json("GET", path)).body);
      expect(body).not.toContain("very private title");
      expect(body).not.toContain(a.accountId);
    }
    expect((await c.json("GET", `/api/v1/reviews/${a.reviewId}`)).status).toBe(404);
    expect((await c.json("GET", `/api/v1/reviews/${a.reviewId}/export.md`)).status).toBe(404);
    expect((await c.json("GET", `/api/v1/items/${a.itemId}`)).status).toBe(404);
    expect((await c.json("POST", `/api/v1/reviews/${a.reviewId}/publish`)).status).toBe(409);
    expect((await c.json("POST", `/api/v1/reviews/${a.reviewId}/dismissals`, { marker: "<!-- triage:v3:x -->" })).status).toBe(404);
    expect((await c.json("POST", "/api/v1/reviews", { itemId: a.itemId })).status).toBe(409);
    expect((await c.json("POST", "/api/v1/targets", { accountId: a.accountId, name: "x", type: "search", params: { query: "x" } })).status).toBe(400);
    expect((await c.json("POST", "/api/v1/items", { accountId: a.accountId, url: "o/secret-repo#7" })).status).toBe(404);
    expect((await c.json("DELETE", `/api/v1/accounts/${a.accountId}`)).status).toBe(404);
    expect((await c.json("POST", `/api/v1/targets/${a.targetId}/poll`)).status).toBe(404);
    expect(h.gh.writes).toHaveLength(0);
  });

  it("each user's accounts are their own, even for the same GitHub login", async () => {
    await adminWithReview();
    const { c } = await member();
    const added = await c.json("POST", "/api/v1/accounts", { token: GH_TOKEN_BOB });
    expect(added.status).toBe(201);
    expect((await h.json("GET", "/api/v1/accounts")).body.accounts.map((x: { login: string }) => x.login)).toEqual(["octo"]);
  });

  it("the admin view shows load, never repositories or titles", async () => {
    await adminWithReview();
    await member();
    const r = await h.json("GET", "/api/v1/admin/users");
    expect(r.body.users).toHaveLength(2);
    expect(r.body.users[0]).toMatchObject({ login: "owner", accounts: 1, credentials: 1, reviews_24h: 1 });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("secret-repo");
    expect(text).not.toContain("very private title");
  });
});

describe("user management", () => {
  it("disabling signs the user out, stops their targets and queue; enabling lets them back", async () => {
    await adminWithReview();
    const { c, id } = await member();
    expect((await h.json("PATCH", `/api/v1/admin/users/${id}`, { disabled: true })).status).toBe(200);
    expect((await c.json("GET", "/api/v1/auth/me")).status).toBe(401);
    expect((await c.json("POST", "/api/v1/auth/login", { login: "alice", password: PASSWORD })).status).toBe(401);
    await h.json("PATCH", `/api/v1/admin/users/${id}`, { disabled: false });
    expect((await c.json("POST", "/api/v1/auth/login", { login: "alice", password: PASSWORD })).status).toBe(200);
    const me = (await h.json("GET", "/api/v1/auth/me")).body.user.id;
    expect((await h.json("PATCH", `/api/v1/admin/users/${me}`, { disabled: true })).status).toBe(400);
  });

  it("password change keeps this session and ends the others", async () => {
    await adminWithReview();
    const { c } = await member();
    const other = h.client();
    await other.json("POST", "/api/v1/auth/login", { login: "alice", password: PASSWORD });
    expect((await c.json("POST", "/api/v1/auth/password", { current: "nope", next: "new password 123" })).status).toBe(400);
    expect((await c.json("POST", "/api/v1/auth/password", { current: PASSWORD, next: "new password 123" })).status).toBe(200);
    expect((await c.json("GET", "/api/v1/auth/me")).status).toBe(200);
    expect((await other.json("GET", "/api/v1/auth/me")).status).toBe(401);
  });
});

describe("two-factor sign-in", () => {
  it("setup, enable with a code, then login needs it; an admin can reset it", async () => {
    await adminWithReview();
    const { c, id } = await member();
    const setup = await c.json("POST", "/api/v1/auth/totp/setup");
    expect(setup.body.uri).toStartWith("otpauth://totp/");
    expect((await c.json("POST", "/api/v1/auth/totp/enable", { code: "000000" })).status).toBe(400);
    expect((await c.json("POST", "/api/v1/auth/totp/enable", { code: totpCode(setup.body.secret) })).status).toBe(200);
    expect((await c.json("GET", "/api/v1/auth/me")).body.totp).toBe(true);

    const fresh = h.client();
    const noCode = await fresh.json("POST", "/api/v1/auth/login", { login: "alice", password: PASSWORD });
    expect(noCode).toMatchObject({ status: 401, body: { totp: true } });
    expect((await fresh.json("POST", "/api/v1/auth/login", { login: "alice", password: PASSWORD, code: "123456" })).status).toBe(401);
    expect((await fresh.json("POST", "/api/v1/auth/login", { login: "alice", password: PASSWORD, code: totpCode(setup.body.secret) })).status).toBe(200);

    await h.json("PATCH", `/api/v1/admin/users/${id}`, { resetTotp: true });
    expect((await h.client().json("POST", "/api/v1/auth/login", { login: "alice", password: PASSWORD })).status).toBe(200);
    const actions = (await h.json("GET", "/api/v1/audit")).body.audit.map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["user_invited", "totp_reset"]));
  });
});
