import { describe, expect, it } from "bun:test";
import { harness } from "./harness.js";
import { bootstrapAdmin, countUsers } from "../../src/auth/auth.js";

describe("setup and login", () => {
  it("an empty instance reports needsSetup and creates the admin once", async () => {
    const h = harness();
    expect(await (await h.call("GET", "/api/v1/setup")).json()).toEqual({ needsSetup: true });
    const res = await h.call("POST", "/api/v1/setup", { login: "owner", password: "long enough pass" });
    expect(res.status).toBe(200);
    expect((await h.call("GET", "/api/v1/auth/me")).status).toBe(200);
    expect((await h.call("POST", "/api/v1/setup", { login: "second", password: "long enough pass" })).status).toBe(409);
  });

  it("protects the API without a session", async () => {
    const h = harness();
    await h.signIn();
    h.clearCookie();
    expect((await h.call("GET", "/api/v1/state")).status).toBe(401);
    expect((await h.call("GET", "/api/v1/events")).status).toBe(401);
  });

  it("logs in, serves state, logs out", async () => {
    const h = harness();
    await h.signIn();
    const state = (await (await h.call("GET", "/api/v1/state")).json()) as { user: { login: string } };
    expect(state.user.login).toBe("owner");
    await h.call("POST", "/api/v1/auth/logout");
    expect((await h.call("GET", "/api/v1/state")).status).toBe(401);
  });

  it("rejects a wrong password and rate-limits repeated failures", async () => {
    const h = harness();
    await h.signIn();
    h.clearCookie();
    for (let i = 0; i < 10; i++) expect((await h.call("POST", "/api/v1/auth/login", { login: "owner", password: "nope" })).status).toBe(401);
    expect((await h.call("POST", "/api/v1/auth/login", { login: "owner", password: "correct horse battery" })).status).toBe(429);
  });

  it("stores only the hash of the session token", async () => {
    const h = harness();
    await h.signIn();
    const row = h.rt.db.query("SELECT id FROM sessions").get() as { id: string };
    expect(row.id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("csrf", () => {
  it("refuses mutations without the fetch header or from another origin", async () => {
    const h = harness();
    await h.signIn();
    expect((await h.call("POST", "/api/v1/poll", {}, { "x-requested-with": "" })).status).toBe(403);
    expect((await h.call("POST", "/api/v1/poll", {}, { origin: "https://evil.example" })).status).toBe(403);
    expect((await h.call("POST", "/api/v1/poll", {}, { origin: "http://localhost" })).status).toBe(200);
  });
});

describe("bootstrapAdmin", () => {
  it("turns the v1 PANEL_PASSWORD into the first admin, only on an empty instance", async () => {
    const h = harness();
    expect(await bootstrapAdmin(h.rt.db, { PANEL_USER: "admin", PANEL_PASSWORD: "v1-panel-password" })).toMatchObject({ login: "admin", role: "admin" });
    expect(await bootstrapAdmin(h.rt.db, { PANEL_PASSWORD: "another-password" })).toBeNull();
    expect(countUsers(h.rt.db)).toBe(1);
  });
});
