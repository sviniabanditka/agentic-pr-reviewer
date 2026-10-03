/**
 * A small in-memory GitHub REST server for tests: users by token, pulls, search,
 * comments and the diff media type. Records every write.
 */
export interface FakePull {
  repo: string;
  number: number;
  title: string;
  author: string;
  authorType?: "User" | "Bot";
  state?: "open" | "closed";
  merged?: boolean;
  draft?: boolean;
  headSha: string;
  reviewers?: string[];
  labels?: string[];
  body?: string;
  diff?: string;
  updatedAt?: string;
  changedFiles?: number;
}

export interface FakeComment {
  id: number;
  repo: string;
  number: number;
  author: string;
  body: string;
}

const DEFAULT_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-const a = check(user);",
  "+const a = 1;",
  " export default a;",
  "",
].join("\n");

export function fakeGitHub(users: Record<string, string>) {
  const pulls: FakePull[] = [];
  const comments: FakeComment[] = [];
  const writes: { method: string; path: string; body: unknown; user: string }[] = [];
  let nextComment = 1000;
  /** "owner/repo:base...head" → diff text. */
  const compares = new Map<string, string>();
  const reviews: { id: number; repo: string; number: number; author: string; commit_id: string; body: string; event: string; comments: { path: string; line: number; body: string }[] }[] = [];

  const raw = (p: FakePull) => ({
    number: p.number,
    title: p.title,
    body: p.body ?? "",
    html_url: `https://github.com/${p.repo}/pull/${p.number}`,
    user: { login: p.author, type: p.authorType ?? "User" },
    state: p.state ?? "open",
    merged_at: p.merged ? "2026-01-02T00:00:00Z" : null,
    draft: p.draft ?? false,
    head: { sha: p.headSha, ref: "feature" },
    base: { sha: "base000", ref: "main", repo: { full_name: p.repo } },
    updated_at: p.updatedAt ?? "2026-01-01T00:00:00Z",
    labels: (p.labels ?? []).map((name) => ({ name })),
    additions: 1,
    deletions: 1,
    changed_files: p.changedFiles ?? 1,
  });

  const headers = (resource = "core") => ({
    "content-type": "application/json",
    "x-ratelimit-resource": resource,
    "x-ratelimit-limit": resource === "search" ? "30" : "5000",
    "x-ratelimit-remaining": resource === "search" ? "29" : "4999",
    "x-ratelimit-reset": "1999999999",
    "x-oauth-scopes": "repo, read:org",
  });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const login = users[(req.headers.get("authorization") ?? "").replace("Bearer ", "")];
      if (!login) return Response.json({ message: "Bad credentials" }, { status: 401 });
      const path = url.pathname;
      const json = (body: unknown, status = 200, resource = "core") => new Response(JSON.stringify(body), { status, headers: headers(resource) });

      if (path === "/user") return json({ login, name: login });
      if (path === "/rate_limit") return json({ resources: { core: { limit: 5000, remaining: 4999, reset: 1999999999 }, search: { limit: 30, remaining: 29, reset: 1999999999 } } });

      if (path === "/search/issues") {
        const q = url.searchParams.get("q") ?? "";
        const hits = pulls.filter((p) => {
          if ((p.state ?? "open") !== "open") return false;
          if (q.includes("review-requested:@me") && !(p.reviewers ?? []).includes(login)) return false;
          if (q.includes("author:@me") && p.author !== login) return false;
          const repo = /repo:(\S+)/.exec(q)?.[1];
          if (repo && p.repo !== repo) return false;
          return true;
        });
        return json(
          {
            items: hits.map((p) => ({
              repository_url: `https://api.github.com/repos/${p.repo}`,
              number: p.number,
              title: p.title,
              html_url: `https://github.com/${p.repo}/pull/${p.number}`,
              user: { login: p.author, type: p.authorType ?? "User" },
              updated_at: p.updatedAt ?? "2026-01-01T00:00:00Z",
              draft: p.draft ?? false,
              labels: (p.labels ?? []).map((name) => ({ name })),
            })),
          },
          200,
          "search",
        );
      }

      let m = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(path);
      if (m) return json(pulls.filter((p) => p.repo === m![1] && (p.state ?? "open") === "open").map(raw));

      m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path);
      if (m) {
        const p = pulls.find((x) => x.repo === m![1] && x.number === Number(m![2]));
        if (!p) return json({ message: "Not Found" }, 404);
        if ((req.headers.get("accept") ?? "").includes("diff")) return new Response(p.diff ?? DEFAULT_DIFF, { headers: headers() });
        return json(raw(p));
      }

      m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(path);
      if (m) {
        const [repo, number] = [m[1]!, Number(m[2])];
        if (req.method === "POST") {
          const body = (await req.json()) as { body: string };
          writes.push({ method: "POST", path, body, user: login });
          const c = { id: nextComment++, repo, number, author: login, body: body.body };
          comments.push(c);
          return json({ id: c.id, html_url: `https://github.com/${repo}/pull/${number}#issuecomment-${c.id}` }, 201);
        }
        return json(comments.filter((c) => c.repo === repo && c.number === number).map((c) => ({ id: c.id, body: c.body, user: { login: c.author } })));
      }

      m = /^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/.exec(path);
      if (m && req.method === "PATCH") {
        const c = comments.find((x) => x.id === Number(m![2]));
        if (!c) return json({ message: "Not Found" }, 404);
        const body = (await req.json()) as { body: string };
        writes.push({ method: "PATCH", path, body, user: login });
        c.body = body.body;
        return json({ id: c.id, html_url: `https://github.com/${c.repo}/pull/${c.number}#issuecomment-${c.id}` });
      }

      m = /^\/repos\/([^/]+\/[^/]+)\/compare\/(.+)$/.exec(path);
      if (m) {
        const diff = compares.get(`${m[1]}:${decodeURIComponent(m[2]!)}`);
        return diff === undefined ? json({ message: "Not Found" }, 404) : new Response(diff, { headers: headers() });
      }

      m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/.exec(path);
      if (m && req.method === "POST") {
        const body = (await req.json()) as { commit_id: string; body: string; event: string; comments: { path: string; line: number; body: string }[] };
        writes.push({ method: "POST", path, body, user: login });
        const id = nextComment++;
        reviews.push({ id, repo: m[1]!, number: Number(m[2]), author: login, ...body });
        return json({ id, html_url: `https://github.com/${m[1]}/pull/${m[2]}#pullrequestreview-${id}` });
      }

      return json({ message: `fake: no route for ${req.method} ${path}` }, 404);
    },
  });

  return { url: `http://localhost:${server.port}`, pulls, comments, writes, compares, reviews, stop: () => server.stop(true) };
}
