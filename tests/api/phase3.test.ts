import { afterEach, describe, expect, it } from "bun:test";
import { harness } from "./harness.js";
import { runNext } from "../../src/jobs/worker.js";
import { prune } from "../../src/store/db.js";
import { findingMarker } from "../../src/verdict/verdict.js";
import type { Finding } from "../../src/review/finding.js";

let h: ReturnType<typeof harness>;
afterEach(() => h?.stop());

const guardRemoved: Finding = {
  category: "GUARD-REMOVED", file: "src/a.ts", line_start: 1, line_end: 1,
  evidence: "const a = check(user);", evidence_kind: "removed", claim: "check removed", detail: "d",
};
const note: Finding = {
  category: "OTHER", file: "src/a.ts", line_start: 1, line_end: 1,
  evidence: "const a = 1;", evidence_kind: "present", claim: "magic number", detail: "d",
};
const B_DIFF = ["diff --git a/src/b.ts b/src/b.ts", "--- a/src/b.ts", "+++ b/src/b.ts", "@@ -1,1 +1,1 @@", "-let b = 0;", "+let b = 2;", ""].join("\n");

async function withItem(findings: Finding[] = []) {
  h = harness({ findings });
  const ids = await h.ready();
  h.gh.pulls.push({ repo: "o/r", number: 7, title: "feature", author: "octo", headSha: "abc1234" });
  const target = await h.json("POST", "/api/v1/targets", { accountId: ids.accountId, name: "Mine", type: "search", params: { query: "author:@me" } });
  await h.json("POST", `/api/v1/targets/${target.body.target.id}/poll`);
  const items = await h.json("GET", "/api/v1/items");
  return { ...ids, itemId: items.body.items[0].id as string, targetId: target.body.target.id as string };
}

async function reviewNow(itemId: string, extra: Record<string, unknown> = {}) {
  const q = await h.json("POST", "/api/v1/reviews", { itemId, ...extra });
  expect(q.status).toBe(202);
  await runNext(h.rt);
  return q.body.id as number;
}

describe("outputs", () => {
  it("posts a GitHub review with inline comments on diff lines, always as COMMENT, and audits it", async () => {
    const { itemId } = await withItem([note]);
    const id = await reviewNow(itemId);
    const posted = await h.json("POST", `/api/v1/reviews/${id}/publish`, { output: "pr-review" });
    expect(posted.status).toBe(200);
    expect(h.gh.reviews).toHaveLength(1);
    expect(h.gh.reviews[0]).toMatchObject({ event: "COMMENT", commit_id: "abc1234", comments: [{ path: "src/a.ts", line: 1 }] });
    expect(h.gh.comments).toHaveLength(0);
    const audit = await h.json("GET", "/api/v1/audit");
    expect(audit.body.audit.map((a: { action: string }) => a.action)).toContain("post_review");
    const review = await h.json("GET", `/api/v1/reviews/${id}`);
    expect(review.body.outputs).toMatchObject([{ type: "pr-review", status: "sent" }]);
  });

  it("exports markdown and json without the hidden marker", async () => {
    const { itemId } = await withItem([note]);
    const id = await reviewNow(itemId);
    const md = await h.call("GET", `/api/v1/reviews/${id}/export.md`);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    const text = await md.text();
    expect(text).toStartWith("# o/r #7: feature");
    expect(text).not.toContain("<!--");
    const json = await h.json("GET", `/api/v1/reviews/${id}/export.json`);
    expect(json.body.result.findings[0].claim).toBe("magic number");
  });

  it("a dismissed blocking finding stops blocking and leaves the comment", async () => {
    const { itemId } = await withItem([guardRemoved]);
    const id = await reviewNow(itemId);
    expect((await h.json("GET", `/api/v1/reviews/${id}`)).body.result.verdict.conclusion).toBe("action_required");
    const r = await h.json("POST", `/api/v1/reviews/${id}/dismissals`, { marker: findingMarker(guardRemoved), note: "intended" });
    expect(r.body.result.verdict.conclusion).toBe("success");
    expect(r.body.result.findings[0]).toMatchObject({ dismissed: true, dismissNote: "intended" });
    await h.json("POST", `/api/v1/reviews/${id}/publish`);
    expect(h.gh.comments[0]!.body).toContain("Dismissed");
    const back = await h.json("DELETE", `/api/v1/reviews/${id}/dismissals`, { marker: findingMarker(guardRemoved) });
    expect(back.body.result.verdict.conclusion).toBe("action_required");
  });
});

describe("incremental reviews", () => {
  async function pushAndReview(fullDiff: string) {
    const findings = [guardRemoved];
    const { itemId, targetId } = await withItem(findings);
    const first = await reviewNow(itemId);
    findings.length = 0; // the delta has nothing new
    h.gh.pulls[0]!.headSha = "def5678";
    h.gh.pulls[0]!.diff = fullDiff;
    h.gh.pulls[0]!.updatedAt = "2026-01-05T00:00:00Z";
    h.gh.compares.set("o/r:abc1234...def5678", B_DIFF);
    await h.json("POST", `/api/v1/targets/${targetId}/poll`);
    const second = await reviewNow(itemId, { incremental: true });
    return { first, second, review: await h.json("GET", `/api/v1/reviews/${second}`) };
  }

  it("reviews only the delta and keeps findings whose code is still in the PR", async () => {
    const full = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,2 @@", "-const a = check(user);", "+const a = 1;", " export default a;", B_DIFF].join("\n");
    const { first, review } = await pushAndReview(full);
    expect(review.body.review).toMatchObject({ kind: "incremental", base_job_id: first, status: "done", head_sha: "def5678" });
    expect(h.claude.calls.at(-1)!.user).toContain("src/b.ts");
    expect(h.claude.calls.at(-1)!.user).not.toContain("check(user)");
    expect(review.body.result.findings).toMatchObject([{ category: "GUARD-REMOVED", state: "still_open" }]);
    expect(review.body.result.verdict.conclusion).toBe("action_required");
    expect(review.body.result.incremental).toMatchObject({ baseSha: "abc1234", fixed: [] });
  });

  it("findings whose code left the PR are listed as fixed", async () => {
    const { review } = await pushAndReview(B_DIFF);
    expect(review.body.result.findings).toHaveLength(0);
    expect(review.body.result.incremental.fixed).toMatchObject([{ category: "GUARD-REMOVED" }]);
    expect(review.body.result.verdict.conclusion).toBe("success");
  });

  it("refuses without a finished review or without new commits", async () => {
    const { itemId } = await withItem();
    expect((await h.json("POST", "/api/v1/reviews", { itemId, incremental: true })).status).toBe(409);
    await reviewNow(itemId);
    expect((await h.json("POST", "/api/v1/reviews", { itemId, incremental: true })).body.error).toContain("no new commits");
  });
});

describe("compare and patch items", () => {
  it("reviews a compare range and never posts it", async () => {
    const { accountId } = await withItem([note]);
    h.gh.compares.set("o/r:main...feature", B_DIFF);
    const added = await h.json("POST", "/api/v1/items", { accountId, kind: "compare", repo: "o/r", base: "main", head: "feature" });
    expect(added.status).toBe(201);
    expect(added.body.item).toMatchObject({ kind: "compare", title: "main...feature" });
    const id = await reviewNow(added.body.item.id);
    expect((await h.json("GET", `/api/v1/reviews/${id}`)).body.review.status).toBe("done");
    expect(h.claude.calls.at(-1)!.user).toContain("src/b.ts");
    expect((await h.json("POST", `/api/v1/reviews/${id}/publish`)).status).toBe(409);
    expect(h.gh.writes).toHaveLength(0);
    expect((await h.json("POST", "/api/v1/items", { accountId, kind: "compare", repo: "o/r", base: "x", head: "y" })).status).toBe(400);
  });

  it("reviews a pasted patch; rejects text that is not a diff", async () => {
    const { accountId } = await withItem();
    expect((await h.json("POST", "/api/v1/items", { accountId, kind: "patch", title: "p", patch: "hello" })).status).toBe(400);
    const added = await h.json("POST", "/api/v1/items", { accountId, kind: "patch", title: "local change", patch: B_DIFF });
    expect(added.status).toBe(201);
    const again = await h.json("POST", "/api/v1/items", { accountId, kind: "patch", title: "same", patch: B_DIFF });
    expect(again.body.item.id).toBe(added.body.item.id);
    const id = await reviewNow(added.body.item.id);
    expect((await h.json("GET", `/api/v1/reviews/${id}`)).body.review.status).toBe("done");
  });
});

describe("auto-post", () => {
  it("needs the account login typed to turn on, then posts after the review and audits both", async () => {
    h = harness({ findings: [note] });
    const { accountId } = await h.ready();
    h.gh.pulls.push({ repo: "o/r", number: 9, title: "x", author: "octo", headSha: "aaa0000" });
    const body = { accountId, name: "Auto", type: "search", params: { query: "author:@me" }, automation: "auto-post" };
    expect((await h.json("POST", "/api/v1/targets", body)).status).toBe(400);
    expect((await h.json("POST", "/api/v1/targets", { ...body, confirmLogin: "bob" })).status).toBe(400);
    const t = await h.json("POST", "/api/v1/targets", { ...body, confirmLogin: "OCTO" });
    expect(t.status).toBe(201);
    await h.json("POST", `/api/v1/targets/${t.body.target.id}/poll`);
    const queued = (await h.json("GET", "/api/v1/reviews")).body.reviews[0];
    expect(queued).toMatchObject({ auto_post: 1, priority: 0, status: "queued" });
    await runNext(h.rt);
    expect(h.gh.comments).toHaveLength(1);
    const actions = (await h.json("GET", "/api/v1/audit")).body.audit.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["target_auto_post_enabled", "auto_post"]));
  });
});

describe("queue", () => {
  it("manual reviews run before automatic ones", async () => {
    const { itemId, accountId } = await withItem();
    h.gh.pulls.push({ repo: "o/r", number: 8, title: "auto", author: "octo", headSha: "bbb0000" });
    await h.json("POST", "/api/v1/targets", { accountId, name: "Auto", type: "repo", params: { repo: "o/r" }, automation: "auto-review" });
    await h.rt.requestPoll();
    const manual = await h.json("POST", "/api/v1/reviews", { itemId });
    await runNext(h.rt);
    expect((await h.json("GET", `/api/v1/reviews/${manual.body.id}`)).body.review.status).toBe("done");
  });

  it("cancels a running review", async () => {
    const { itemId } = await withItem([note]);
    const q = await h.json("POST", "/api/v1/reviews", { itemId });
    const call = h.rt.deps.callClaude;
    h.rt.deps.callClaude = async (req, settings) => {
      expect((await h.json("POST", `/api/v1/reviews/${q.body.id}/cancel`)).status).toBe(200);
      return call(req, settings);
    };
    await runNext(h.rt);
    expect((await h.json("GET", `/api/v1/reviews/${q.body.id}`)).body.review).toMatchObject({ status: "skipped", error: "cancelled" });
  });
});

describe("channels, retention", () => {
  it("stores the channel URL encrypted and never returns it", async () => {
    await withItem();
    expect((await h.json("POST", "/api/v1/channels", { type: "webhook", label: "w", secret: "http://insecure.example", events: ["done"] })).status).toBe(400);
    const added = await h.json("POST", "/api/v1/channels", { type: "slack", label: "team", secret: "https://hooks.example.invalid/T000/B000/secretpart", events: ["done", "blocking"] });
    expect(added.status).toBe(201);
    const list = await h.call("GET", "/api/v1/channels");
    expect(await list.text()).not.toContain("secretpart");
    expect((await h.json("DELETE", `/api/v1/channels/${added.body.channel.id}`)).status).toBe(200);
  });

  it("drops stored findings after the retention window, keeps the verdict", async () => {
    const { itemId } = await withItem([note]);
    const id = await reviewNow(itemId);
    expect((await h.json("PATCH", "/api/v1/settings", { retentionDays: 1 })).body.retentionDays).toBe(1);
    h.rt.db.query("UPDATE jobs SET finished_at = ? WHERE id = ?").run(Date.now() - 2 * 86400_000, id);
    prune(h.rt.db);
    const r = await h.json("GET", `/api/v1/reviews/${id}`);
    expect(r.body).toMatchObject({ result: null, purged: true });
    expect(r.body.review.verdict_title).toBeTruthy();
    expect((await h.json("GET", `/api/v1/reviews/${id}/export.md`)).status).toBe(404);
  });
});
