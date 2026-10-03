import { afterEach, describe, expect, it } from "bun:test";
import { harness } from "./harness.js";
import { runNext } from "../../src/jobs/worker.js";
import type { Finding } from "../../src/review/finding.js";

let h: ReturnType<typeof harness>;
afterEach(() => h?.stop());

const guardRemoved: Finding = {
  category: "GUARD-REMOVED", file: "src/a.ts", line_start: 1, line_end: 1,
  evidence: "const a = check(user);", evidence_kind: "removed", claim: "check removed", detail: "d",
};

async function withItem() {
  const ids = await h.ready();
  h.gh.pulls.push({ repo: "o/r", number: 7, title: "feature", author: "octo", headSha: "abc1234" });
  const target = await h.json("POST", "/api/v1/targets", { accountId: ids.accountId, name: "Mine", type: "search", params: { query: "author:@me" } });
  await h.json("POST", `/api/v1/targets/${target.body.target.id}/poll`);
  const items = await h.json("GET", "/api/v1/items");
  return { ...ids, itemId: items.body.items[0].id as string, targetId: target.body.target.id as string };
}

describe("review lifecycle", () => {
  it("reviews an item, keeps the result private, posts only on publish, edits on repost", async () => {
    h = harness({ findings: [guardRemoved] });
    const { itemId } = await withItem();

    const queued = await h.json("POST", "/api/v1/reviews", { itemId, model: "opus" });
    expect(queued.status).toBe(202);
    expect((await h.json("POST", "/api/v1/reviews", { itemId })).status).toBe(409);

    expect(await runNext(h.rt)).toBe(true);
    const done = await h.json("GET", `/api/v1/reviews/${queued.body.id}`);
    expect(done.body.review).toMatchObject({ status: "done", model: "opus", confirmed: 1, conclusion: "action_required" });
    expect(h.claude.calls).toHaveLength(2); // blocking candidate → confirmation run
    expect(h.gh.writes).toHaveLength(0);

    const posted = await h.json("POST", `/api/v1/reviews/${queued.body.id}/publish`);
    expect(posted.status).toBe(200);
    expect(h.gh.writes.map((w) => w.method)).toEqual(["POST"]);
    expect(h.gh.comments[0]!.body).toStartWith("<!-- agentic-pr-reviewer -->\n🤖 Agentic PR Reviewer");

    await h.json("POST", "/api/v1/reviews", { itemId });
    await runNext(h.rt);
    const second = (await h.json("GET", "/api/v1/reviews")).body.reviews[0];
    await h.json("POST", `/api/v1/reviews/${second.id}/publish`);
    expect(h.gh.writes.map((w) => w.method)).toEqual(["POST", "PATCH"]);
    const first = await h.json("GET", `/api/v1/reviews/${queued.body.id}`);
    expect(first.body.review.comment_url).toBeNull();
  });

  it("refuses unknown items and models, cancels while queued", async () => {
    h = harness();
    const { itemId } = await withItem();
    expect((await h.json("POST", "/api/v1/reviews", { itemId: "nope" })).status).toBe(409);
    expect((await h.json("POST", "/api/v1/reviews", { itemId, model: "gpt-5" })).status).toBe(409);
    const q = await h.json("POST", "/api/v1/reviews", { itemId });
    expect((await h.json("POST", `/api/v1/reviews/${q.body.id}/cancel`)).status).toBe(200);
    expect((await h.json("POST", `/api/v1/reviews/${q.body.id}/cancel`)).status).toBe(409);
    expect((await h.json("POST", `/api/v1/reviews/${q.body.id}/publish`)).status).toBe(409);
  });

  it("needs a credential on the account", async () => {
    h = harness();
    const { itemId, accountId } = await withItem();
    await h.json("PATCH", `/api/v1/accounts/${accountId}`, { credentialId: null });
    const res = await h.json("POST", "/api/v1/reviews", { itemId });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("no Claude credential");
  });

  it("auto-review queues once per new head sha", async () => {
    h = harness();
    const ids = await h.ready();
    h.gh.pulls.push({ repo: "o/r", number: 8, title: "auto", author: "octo", headSha: "s1" });
    const t = await h.json("POST", "/api/v1/targets", { accountId: ids.accountId, name: "auto", type: "search", params: { query: "author:@me" }, automation: "auto-review" });
    await h.json("POST", `/api/v1/targets/${t.body.target.id}/poll`);
    await h.json("POST", `/api/v1/targets/${t.body.target.id}/poll`);
    expect((await h.json("GET", "/api/v1/reviews")).body.reviews).toHaveLength(1);
    await runNext(h.rt);
    h.gh.pulls[0]!.headSha = "s2";
    h.gh.pulls[0]!.updatedAt = "2026-02-01T00:00:00Z";
    await h.json("POST", `/api/v1/targets/${t.body.target.id}/poll`);
    expect((await h.json("GET", "/api/v1/reviews")).body.reviews).toHaveLength(2);
    expect(h.gh.writes).toHaveLength(0);
  });
});
