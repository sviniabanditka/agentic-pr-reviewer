import { afterEach, describe, expect, it } from "bun:test";
import { harness } from "./harness.js";
import { runNext } from "../../src/jobs/worker.js";

let h: ReturnType<typeof harness>;
afterEach(() => h?.stop());

async function withItem() {
  const ids = await h.ready();
  h.gh.pulls.push({ repo: "o/r", number: 7, title: "feature", author: "octo", headSha: "abc1234", body: "Adds a feature. Auth unchanged." });
  const t = await h.json("POST", "/api/v1/targets", { accountId: ids.accountId, name: "Mine", type: "search", params: { query: "author:@me" } });
  await h.json("POST", `/api/v1/targets/${t.body.target.id}/poll`);
  return { ...ids, itemId: (await h.json("GET", "/api/v1/items")).body.items[0].id as string };
}

describe("profiles", () => {
  it("every user starts with the built-in profiles, triage as default", async () => {
    h = harness();
    await h.signIn();
    const res = await h.json("GET", "/api/v1/profiles");
    expect(res.body.profiles.map((p: { name: string }) => p.name)).toEqual(["Triage", "Security audit", "Intent check", "Summary"]);
    expect(res.body.profiles[0].isDefault).toBe(true);
  });

  it("creates, edits (bumping the version), sets default and refuses deleting the default", async () => {
    h = harness();
    await h.signIn();
    const created = await h.json("POST", "/api/v1/profiles", {
      name: "Perf", mode: "custom", options: { customCategories: [{ id: "perf", description: "N+1 queries and unbounded loops" }], blocking: ["PERF"] },
    });
    expect(created.status).toBe(201);
    expect(created.body.profile.resolved).toMatchObject({ categories: ["PERF", "OTHER"], blocking: ["PERF"] });
    const id = created.body.profile.id;
    const edited = await h.json("PATCH", `/api/v1/profiles/${id}`, { options: { customCategories: [{ id: "perf", description: "N+1" }], confirmation: "never" } });
    expect(edited.body.profile.version).toBe(2);
    await h.json("POST", `/api/v1/profiles/${id}/default`);
    expect((await h.json("DELETE", `/api/v1/profiles/${id}`)).status).toBe(409);
    expect((await h.json("POST", "/api/v1/profiles", { name: "x", mode: "custom", options: {} })).status).toBe(400);
    expect((await h.json("POST", "/api/v1/profiles", { name: "x", mode: "nope", options: {} })).status).toBe(400);
  });

  it("a review runs with the chosen profile and records each model call", async () => {
    h = harness();
    const { itemId } = await withItem();
    const audit = (await h.json("GET", "/api/v1/profiles")).body.profiles.find((p: { name: string }) => p.name === "Security audit");
    const q = await h.json("POST", "/api/v1/reviews", { itemId, profileId: audit.id });
    expect(q.status).toBe(202);
    await runNext(h.rt);
    expect(h.claude.calls[0]!.system).toContain("application security engineer");
    expect(h.claude.calls[0]!.system).toContain("- INJECTION:");
    const details = await h.json("GET", `/api/v1/reviews/${q.body.id}`);
    expect(details.body.review).toMatchObject({ status: "done", profile_name: "Security audit", mode: "security-audit", chunks: 1 });
    expect(details.body.runs).toHaveLength(1);
    expect(details.body.runs[0]).toMatchObject({ purpose: "review", tokens_in: 100 });
  });

  it("the account's profile is used when none is chosen", async () => {
    h = harness();
    const { itemId, accountId } = await withItem();
    const intent = (await h.json("GET", "/api/v1/profiles")).body.profiles.find((p: { name: string }) => p.name === "Intent check");
    await h.json("PATCH", `/api/v1/accounts/${accountId}`, { profileId: intent.id });
    const q = await h.json("POST", "/api/v1/reviews", { itemId });
    await runNext(h.rt);
    expect((await h.json("GET", `/api/v1/reviews/${q.body.id}`)).body.review.mode).toBe("intent-check");
    expect(h.claude.calls[0]!.user).toContain("## Author's claim");
  });

  it("a profile cannot be used by another user", async () => {
    h = harness();
    const { itemId } = await withItem();
    const bob = h.client();
    await bob.signIn("bob", "another long password", "member");
    const bobs = (await bob.json("GET", "/api/v1/profiles")).body.profiles[0];
    expect((await h.json("POST", "/api/v1/reviews", { itemId, profileId: bobs.id })).status).toBe(409);
  });

  it("previews the exact prompt for an item", async () => {
    h = harness();
    const { itemId } = await withItem();
    const triage = (await h.json("GET", "/api/v1/profiles")).body.profiles[0];
    const res = await h.json("POST", `/api/v1/profiles/${triage.id}/preview`, { itemId });
    expect(res.status).toBe(200);
    expect(res.body.system).toContain("## Evidence rules");
    expect(res.body.user).toContain("## File: 'src/a.ts'");
    expect(res.body.chunks).toBe(1);
  });
});

describe("insights", () => {
  it("summarises finished reviews by model and category", async () => {
    h = harness({ findings: [{ category: "NICHE", file: "src/a.ts", line_start: 1, line_end: 1, evidence: "export default a;", evidence_kind: "present", claim: "c", detail: "d" }] });
    const { itemId } = await withItem();
    await h.json("POST", "/api/v1/reviews", { itemId, model: "opus" });
    await runNext(h.rt);
    const res = await h.json("GET", "/api/v1/insights?days=7");
    expect(res.body.byModel[0]).toMatchObject({ model: "opus", reviews: 1 });
    expect(res.body.categories).toEqual({ NICHE: 1 });
  });
});
