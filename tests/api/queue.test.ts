import { describe, expect, it } from "bun:test";
import { harness } from "./harness.js";

const pr = { account: "work", repo: "o/r", number: 7, title: "t", url: "https://github.com/o/r/pull/7", author: "a", role: "author", updatedAt: "2026-01-01T00:00:00Z", headSha: "abc123" };

describe("review queue over the API", () => {
  it("queues a listed PR once, refuses unlisted ones and bad models, cancels while queued", async () => {
    const h = harness();
    await h.signIn();
    h.rt.openPrs.set("work", [pr]);

    expect((await h.call("POST", "/api/review", { account: "work", repo: "x/y", number: 1 })).status).toBe(409);
    expect((await h.call("POST", "/api/review", { account: "work", repo: "o/r", number: 7, model: "gpt-5" })).status).toBe(409);

    const res = await h.call("POST", "/api/review", { account: "work", repo: "o/r", number: 7, model: "opus" });
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: number };
    expect((await h.call("POST", "/api/review", { account: "work", repo: "o/r", number: 7 })).status).toBe(409);

    expect((await h.call("POST", `/api/jobs/${jobId}/cancel`)).status).toBe(200);
    expect((await h.call("POST", `/api/jobs/${jobId}/cancel`)).status).toBe(409);
    const job = await (await h.call("GET", `/api/jobs/${jobId}`)).json();
    expect(job).toMatchObject({ status: "skipped", error: "cancelled", model: "opus" });
  });

  it("publishing refuses anything but a finished review", async () => {
    const h = harness();
    await h.signIn();
    expect((await h.call("POST", "/api/jobs/999/publish")).status).toBe(409);
  });
});
