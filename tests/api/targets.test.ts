import { afterEach, describe, expect, it } from "bun:test";
import { harness } from "./harness.js";

let h: ReturnType<typeof harness>;
afterEach(() => h?.stop());

async function setup() {
  const ids = await h.ready();
  h.gh.pulls.push(
    { repo: "o/r", number: 1, title: "mine", author: "octo", headSha: "a1", labels: ["api"] },
    { repo: "o/r", number: 2, title: "draft", author: "octo", headSha: "a2", draft: true },
    { repo: "other/x", number: 3, title: "upstream", author: "octo", headSha: "a3" },
    { repo: "o/r", number: 4, title: "asked", author: "bob", headSha: "a4", reviewers: ["octo"] },
    { repo: "o/r", number: 5, title: "bot", author: "dependabot[bot]", authorType: "Bot", headSha: "a5", reviewers: ["octo"] },
  );
  return ids;
}

describe("targets", () => {
  it("search targets apply drafts, bots and owners filters and set the role", async () => {
    h = harness();
    const { accountId } = await setup();
    const mine = await h.json("POST", "/api/v1/targets", { accountId, name: "Mine", type: "search", params: { query: "author:@me" }, filters: { owners: ["o"] } });
    const asked = await h.json("POST", "/api/v1/targets", { accountId, name: "Asked", type: "search", params: { query: "review-requested:@me" }, filters: { owners: ["nobody"] } });
    await h.json("POST", `/api/v1/targets/${mine.body.target.id}/poll`);
    await h.json("POST", `/api/v1/targets/${asked.body.target.id}/poll`);
    const items = (await h.json("GET", "/api/v1/items")).body.items as { number: number; role: string; headSha: string }[];
    expect(items.map((i) => i.number).sort()).toEqual([1, 4]); // no draft, no upstream, no bot; owners never hide requests
    expect(items.find((i) => i.number === 1)).toMatchObject({ role: "author", headSha: "a1" });
    expect(items.find((i) => i.number === 4)!.role).toBe("review_requested");
  });

  it("preview lists matches without storing them", async () => {
    h = harness();
    const { accountId } = await setup();
    const res = await h.json("POST", "/api/v1/targets/preview", { accountId, name: "x", type: "search", params: { query: "author:@me" }, filters: { labelsInclude: ["api"] } });
    expect(res.body.items.map((i: { number: number }) => i.number)).toEqual([1]);
    expect((await h.json("GET", "/api/v1/items")).body.items).toEqual([]);
  });

  it("a merged PR leaves the open list with its state", async () => {
    h = harness();
    const { accountId } = await setup();
    const t = await h.json("POST", "/api/v1/targets", { accountId, name: "Mine", type: "search", params: { query: "author:@me" }, filters: { owners: ["o"] } });
    await h.json("POST", `/api/v1/targets/${t.body.target.id}/poll`);
    Object.assign(h.gh.pulls[0]!, { state: "closed", merged: true });
    await h.json("POST", `/api/v1/targets/${t.body.target.id}/poll`);
    expect((await h.json("GET", "/api/v1/items")).body.items).toEqual([]);
    const all = (await h.json("GET", "/api/v1/items?state=all")).body.items as { number: number; state: string }[];
    expect(all.find((i) => i.number === 1)!.state).toBe("merged");
  });

  it("repo targets list every open PR of the repository", async () => {
    h = harness();
    const { accountId } = await setup();
    const t = await h.json("POST", "/api/v1/targets", { accountId, name: "repo", type: "repo", params: { repo: "o/r" }, filters: { drafts: true } });
    await h.json("POST", `/api/v1/targets/${t.body.target.id}/poll`);
    const numbers = (await h.json("GET", "/api/v1/items")).body.items.map((i: { number: number }) => i.number).sort();
    expect(numbers).toEqual([1, 2, 4]);
  });

  it("a PR can be added by URL", async () => {
    h = harness();
    const { accountId } = await setup();
    const res = await h.json("POST", "/api/v1/items", { accountId, url: "https://github.com/other/x/pull/3" });
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({ repo: "other/x", number: 3, role: "watching" });
    expect((await h.json("POST", "/api/v1/items", { accountId, url: "not a url" })).status).toBe(400);
    expect((await h.json("POST", "/api/v1/items", { accountId, url: "o/r#99" })).status).toBe(400);
  });

  it("validates target params", async () => {
    h = harness();
    const { accountId } = await setup();
    expect((await h.json("POST", "/api/v1/targets", { accountId, name: "x", type: "search", params: {} })).status).toBe(400);
    expect((await h.json("POST", "/api/v1/targets", { accountId, name: "x", type: "repo", params: { repo: "bad repo" } })).status).toBe(400);
  });
});
