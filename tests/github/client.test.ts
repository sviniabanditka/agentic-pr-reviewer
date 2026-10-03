import { afterAll, describe, expect, it } from "bun:test";
import { GitHub, GitHubError, parsePrRef } from "../../src/github/client.js";
import { fakeGitHub } from "../fakes/github.js";

const gh = fakeGitHub({ "tok-octo": "octo" });
afterAll(() => gh.stop());
gh.pulls.push(
  { repo: "o/r", number: 1, title: "mine", author: "octo", headSha: "aaa" },
  { repo: "o/r", number: 2, title: "asked", author: "bob", headSha: "bbb", reviewers: ["octo"], labels: ["api"] },
  { repo: "o/r", number: 3, title: "closed", author: "octo", headSha: "ccc", state: "closed", merged: true },
);

describe("GitHub client", () => {
  const client = new GitHub("tok-octo", gh.url);

  it("reads the login, scopes and rate-limit headers", async () => {
    expect(await client.whoami()).toMatchObject({ login: "octo", scopes: ["repo", "read:org"] });
    expect(client.rate.get("core")).toMatchObject({ limit: 5000, remaining: 4999 });
  });

  it("searches open PRs and maps labels", async () => {
    const hits = await client.searchPrs("is:open review-requested:@me");
    expect(hits.map((h) => h.number)).toEqual([2]);
    expect(hits[0]!.labels).toEqual(["api"]);
    expect(client.rate.get("search")?.limit).toBe(30);
  });

  it("reads pull details including the merged state", async () => {
    expect((await client.pull("o/r", 3)).state).toBe("merged");
    expect(await client.pullDiff("o/r", 1)).toStartWith("diff --git");
  });

  it("creates the marked comment once, then edits it", async () => {
    const first = await client.upsertComment("o/r", 1, "octo", "<!-- m -->", "<!-- m -->\none", null);
    const second = await client.upsertComment("o/r", 1, "octo", "<!-- m -->", "<!-- m -->\ntwo", null);
    expect(second.id).toBe(first.id);
    expect(gh.writes.map((w) => w.method)).toEqual(["POST", "PATCH"]);
  });

  it("raises GitHubError with the status", async () => {
    const bad = new GitHub("nope", gh.url);
    const err = await bad.whoami().catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(401);
  });
});

describe("parsePrRef", () => {
  it("accepts URLs and short forms", () => {
    expect(parsePrRef("https://github.com/o/r/pull/12")).toEqual({ repo: "o/r", number: 12 });
    expect(parsePrRef("o/r#3")).toEqual({ repo: "o/r", number: 3 });
    expect(parsePrRef("github.com/o/r/pull/9/files")).toBeNull();
    expect(parsePrRef("nonsense")).toBeNull();
  });
});
