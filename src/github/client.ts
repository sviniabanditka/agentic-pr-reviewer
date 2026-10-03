/**
 * GitHub REST over fetch, one instance per account token. Replaces shelling out to `gh`:
 * rate-limit headers are read from every response, pagination follows `Link`, and the
 * base URL can point at a fake server in tests.
 */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly resetAt?: number,
  ) {
    super(message);
  }
}

export interface RateWindow {
  limit: number;
  remaining: number;
  /** Epoch ms. */
  reset: number;
}

export interface SearchHit {
  repo: string; // "owner/name"
  number: number;
  title: string;
  url: string;
  author: string;
  authorIsBot: boolean;
  updatedAt: string;
  draft: boolean;
  labels: string[];
}

export interface PullDetails {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  authorIsBot: boolean;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  updatedAt: string;
  labels: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface PostedComment {
  id: number;
  url: string;
}

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";

interface RawPull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: { login: string; type: string } | null;
  state: string;
  merged_at?: string | null;
  merged?: boolean;
  draft?: boolean;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string; repo: { full_name: string } };
  updated_at: string;
  labels?: { name: string }[];
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

function toPull(p: RawPull): PullDetails {
  return {
    repo: p.base.repo.full_name,
    number: p.number,
    title: p.title,
    body: p.body ?? "",
    url: p.html_url,
    author: p.user?.login ?? "ghost",
    authorIsBot: p.user?.type === "Bot",
    state: p.merged_at || p.merged ? "merged" : p.state === "open" ? "open" : "closed",
    draft: p.draft === true,
    headSha: p.head.sha,
    baseSha: p.base.sha,
    headRef: p.head.ref,
    baseRef: p.base.ref,
    updatedAt: p.updated_at,
    labels: (p.labels ?? []).map((l) => l.name),
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    changedFiles: p.changed_files ?? 0,
  };
}

export class GitHub {
  /** The last rate-limit headers seen, per resource ("core", "search"). */
  readonly rate = new Map<string, RateWindow>();
  /** OAuth scopes of the token, from the last response that reported them. */
  scopes: string[] | undefined;

  constructor(
    private readonly token: string,
    private readonly base = API,
  ) {}

  private async request(path: string, init: RequestInit & { accept?: string } = {}): Promise<Response> {
    const res = await fetch(path.startsWith("http") ? path : `${this.base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: init.accept ?? "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "agentic-pr-reviewer",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    this.readHeaders(res);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {}
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000 || undefined;
      throw new GitHubError(`GitHub ${res.status} on ${init.method ?? "GET"} ${path.replace(this.base, "")}: ${message}`, res.status, reset);
    }
    return res;
  }

  private readHeaders(res: Response): void {
    const resource = res.headers.get("x-ratelimit-resource");
    const limit = res.headers.get("x-ratelimit-limit");
    if (resource && limit) {
      this.rate.set(resource, {
        limit: Number(limit),
        remaining: Number(res.headers.get("x-ratelimit-remaining") ?? 0),
        reset: Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000,
      });
    }
    const scopes = res.headers.get("x-oauth-scopes");
    if (scopes !== null) this.scopes = scopes.split(",").map((s) => s.trim()).filter(Boolean);
  }

  private async json<T>(path: string, init?: RequestInit & { accept?: string }): Promise<T> {
    return (await (await this.request(path, init)).json()) as T;
  }

  /** Follows `Link: rel="next"` up to `maxPages`. */
  private async paginate<T>(path: string, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path;
    for (let page = 0; next !== null && page < maxPages; page++) {
      const res = await this.request(next);
      out.push(...((await res.json()) as T[]));
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
    }
    return out;
  }

  async whoami(): Promise<{ login: string; name: string | null; scopes: string[] | undefined }> {
    const user = await this.json<{ login: string; name: string | null }>("/user");
    return { login: user.login, name: user.name, scopes: this.scopes };
  }

  async rateLimit(): Promise<{ core: RateWindow; search: RateWindow }> {
    const r = (await this.json<{ resources: Record<string, { limit: number; remaining: number; reset: number }> }>("/rate_limit")).resources;
    const w = (x: { limit: number; remaining: number; reset: number } | undefined): RateWindow => ({
      limit: x?.limit ?? 0,
      remaining: x?.remaining ?? 0,
      reset: (x?.reset ?? 0) * 1000,
    });
    return { core: w(r.core), search: w(r.search) };
  }

  /** Open PRs matching a search query (the caller adds the qualifiers). */
  async searchPrs(query: string, maxResults = 100): Promise<SearchHit[]> {
    const q = encodeURIComponent(`is:pr ${query}`);
    const body = await this.json<{ items: SearchItem[] }>(`/search/issues?q=${q}&per_page=${Math.min(100, maxResults)}&sort=updated`);
    return body.items.map((i) => ({
      repo: i.repository_url.split("/repos/")[1] ?? "",
      number: i.number,
      title: i.title,
      url: i.html_url,
      author: i.user?.login ?? "ghost",
      authorIsBot: i.user?.type === "Bot",
      updatedAt: i.updated_at,
      draft: i.draft === true,
      labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
    }));
  }

  async listOpenPulls(repo: string): Promise<PullDetails[]> {
    const pulls = await this.paginate<RawPull>(`/repos/${repo}/pulls?state=open&per_page=100&sort=updated&direction=desc`, 3);
    return pulls.map(toPull);
  }

  async pull(repo: string, number: number): Promise<PullDetails> {
    return toPull(await this.json<RawPull>(`/repos/${repo}/pulls/${number}`));
  }

  /** The whole PR as one `git diff` text, the format parseDiffOutput reads. */
  async pullDiff(repo: string, number: number): Promise<string> {
    return (await this.request(`/repos/${repo}/pulls/${number}`, { accept: "application/vnd.github.diff" })).text();
  }

  async compareDiff(repo: string, base: string, head: string): Promise<string> {
    return (await this.request(`/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, { accept: "application/vnd.github.diff" })).text();
  }

  /**
   * Edits this account's marked comment on the PR, or creates it. Found by marker and
   * author, never by "last comment of the user": that may be one written by hand.
   */
  async upsertComment(repo: string, number: number, login: string, marker: string, body: string, knownId: number | null): Promise<PostedComment> {
    const id = knownId ?? (await this.findComment(repo, number, login, marker));
    if (id !== null) {
      try {
        return toPosted(await this.json(`/repos/${repo}/issues/comments/${id}`, { method: "PATCH", body: JSON.stringify({ body }) }));
      } catch (error) {
        // Deleted by someone: fall through and post a fresh one.
        if (!(error instanceof GitHubError) || error.status !== 404) throw error;
      }
    }
    return toPosted(await this.json(`/repos/${repo}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) }));
  }

  private async findComment(repo: string, number: number, login: string, marker: string): Promise<number | null> {
    const comments = await this.paginate<{ id: number; body: string; user: { login: string } | null }>(`/repos/${repo}/issues/${number}/comments?per_page=100`);
    const mine = comments.find((c) => c.user?.login.toLowerCase() === login.toLowerCase() && c.body.includes(marker));
    return mine?.id ?? null;
  }
}

interface SearchItem {
  repository_url: string;
  number: number;
  title: string;
  html_url: string;
  user: { login: string; type: string } | null;
  updated_at: string;
  draft?: boolean;
  labels?: ({ name: string } | string)[];
}

function toPosted(c: unknown): PostedComment {
  const comment = c as { id: number; html_url: string };
  return { id: comment.id, url: comment.html_url };
}

/** Parses "owner/repo#12", "owner/repo/pull/12" or a full PR URL. */
export function parsePrRef(input: string): { repo: string; number: number } | null {
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:\/pull\/|#)(\d+)\/?(?:[?#].*)?$/.exec(input.trim());
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
}
