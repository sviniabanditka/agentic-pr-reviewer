/**
 * Every GitHub call goes through the gh CLI with the account's token in GH_TOKEN:
 * no global `gh auth switch`, so two accounts never race on the active one.
 */
export class GhError extends Error {}

async function gh(token: string, args: string[], input?: string): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: input !== undefined ? new TextEncoder().encode(input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      GH_TOKEN: token,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new GhError(`gh ${args.slice(0, 2).join(" ")} failed: ${stderr.trim().slice(0, 300) || `exit ${exitCode}`}`);
  }
  return stdout;
}

export async function whoami(token: string): Promise<string> {
  return (await gh(token, ["api", "user", "--jq", ".login"])).trim();
}

export interface RateWindow {
  limit: number;
  remaining: number;
  /** Epoch ms. */
  reset: number;
}

/** The token's REST and search quotas; this endpoint itself costs nothing. */
export async function rateLimit(token: string): Promise<{ core: RateWindow; search: RateWindow }> {
  const out = await gh(token, ["api", "rate_limit"]);
  const r = (JSON.parse(out) as { resources: Record<string, { limit: number; remaining: number; reset: number }> }).resources;
  const w = (x: { limit: number; remaining: number; reset: number } | undefined): RateWindow => ({
    limit: x?.limit ?? 0,
    remaining: x?.remaining ?? 0,
    reset: (x?.reset ?? 0) * 1000,
  });
  return { core: w(r.core), search: w(r.search) };
}

export interface SearchHit {
  repo: string; // "owner/name"
  number: number;
  title: string;
  url: string;
  author: string;
  authorIsBot: boolean;
  updatedAt: string;
}

/** Open, non-draft PRs matching a qualifier such as `review-requested:@me`. */
export async function searchPrs(token: string, qualifier: string): Promise<SearchHit[]> {
  const out = await gh(token, [
    "api", "-X", "GET", "search/issues",
    "-f", `q=is:pr is:open draft:false archived:false ${qualifier}`,
    "-f", "per_page=100",
  ]);
  const items = (JSON.parse(out) as { items: SearchItem[] }).items;
  return items.map((i) => ({
    repo: i.repository_url.split("/repos/")[1] ?? "",
    number: i.number,
    title: i.title,
    url: i.html_url,
    author: i.user.login,
    authorIsBot: i.user.type === "Bot",
    updatedAt: i.updated_at,
  }));
}

interface SearchItem {
  repository_url: string;
  number: number;
  title: string;
  html_url: string;
  user: { login: string; type: string };
  updated_at: string;
}

export interface PrDetails {
  title: string;
  body: string;
  headRefOid: string;
  baseRefOid: string;
  headRefName: string;
  isDraft: boolean;
}

export async function viewPr(token: string, repo: string, number: number): Promise<PrDetails> {
  const out = await gh(token, [
    "pr", "view", String(number), "--repo", repo,
    "--json", "title,body,headRefOid,baseRefOid,headRefName,isDraft",
  ]);
  return JSON.parse(out) as PrDetails;
}

/** The whole PR as one `git diff` text, the format parseDiffOutput reads. */
export async function prDiff(token: string, repo: string, number: number): Promise<string> {
  return gh(token, ["pr", "diff", String(number), "--repo", repo, "--color", "never"]);
}

export interface PostedComment {
  id: number;
  url: string;
}

/**
 * Edits this reviewer's comment on the PR, or creates it. The comment is found by
 * marker and author, never by "last comment of the user": that one may be a
 * comment the person wrote by hand.
 */
export async function upsertComment(
  token: string,
  repo: string,
  number: number,
  login: string,
  marker: string,
  body: string,
  knownId: number | null,
): Promise<PostedComment> {
  const payload = JSON.stringify({ body });
  const id = knownId ?? (await findComment(token, repo, number, login, marker));
  if (id !== null) {
    try {
      const out = await gh(token, ["api", "-X", "PATCH", `repos/${repo}/issues/comments/${id}`, "--input", "-"], payload);
      return toPosted(out);
    } catch (error) {
      // Deleted by someone: fall through and post a fresh one.
      if (!(error instanceof GhError) || !error.message.includes("404")) throw error;
    }
  }
  const out = await gh(token, ["api", "-X", "POST", `repos/${repo}/issues/${number}/comments`, "--input", "-"], payload);
  return toPosted(out);
}

async function findComment(token: string, repo: string, number: number, login: string, marker: string): Promise<number | null> {
  const jq = `.[] | select(.user.login == ${JSON.stringify(login)} and (.body | contains(${JSON.stringify(marker)}))) | .id`;
  const out = await gh(token, ["api", `repos/${repo}/issues/${number}/comments`, "--paginate", "--jq", jq]);
  const first = out.split("\n").find((line) => line.trim() !== "");
  return first !== undefined ? Number(first) : null;
}

function toPosted(out: string): PostedComment {
  const c = JSON.parse(out) as { id: number; html_url: string };
  return { id: c.id, url: c.html_url };
}
