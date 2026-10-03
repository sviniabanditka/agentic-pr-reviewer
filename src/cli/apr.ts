#!/usr/bin/env bun
/**
 * apr — reviews a local diff through your Agentic PR Reviewer instance.
 *
 *   apr review [base]          git diff base...HEAD (default: the upstream, else main)
 *   apr review --staged        staged changes
 *   apr review --file x.diff   any unified diff ("-" reads stdin)
 *     --title "…"  --profile <name|id>  --model <model>  --json
 *
 * Config: APR_URL and APR_TOKEN, or ~/.config/apr/config.json {"url", "token"}.
 * Create the token in the panel: settings → api tokens. Nothing is ever posted to GitHub.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HELP = `apr — review a local diff with Agentic PR Reviewer

  apr review [base]          git diff base...HEAD (default: the upstream, else main)
  apr review --staged        staged changes
  apr review --file x.diff   any unified diff ("-" reads stdin)
    --title "…"  --profile <name|id>  --model <model>  --json

Config: APR_URL and APR_TOKEN, or ~/.config/apr/config.json {"url", "token"}.
Exit codes: 0 ok, 3 blocking findings, 1 failed. Nothing is posted to GitHub.`;

export interface Config {
  url: string;
  token: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const file = join(env.HOME ?? homedir(), ".config", "apr", "config.json");
  const stored = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Config>) : {};
  const url = env.APR_URL ?? stored.url;
  const token = env.APR_TOKEN ?? stored.token;
  if (!url || !token) throw new Error(`set APR_URL and APR_TOKEN, or write ${file} with {"url", "token"}`);
  return { url: url.replace(/\/$/, ""), token };
}

export function parseArgs(argv: string[]): { cmd: string; base?: string; staged: boolean; file?: string; title?: string; profile?: string; model?: string; json: boolean } {
  const [cmd = "help", ...rest] = argv;
  const out: ReturnType<typeof parseArgs> = { cmd, staged: false, json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const value = () => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--staged") out.staged = true;
    else if (a === "--json") out.json = true;
    else if (a === "--file") out.file = value();
    else if (a === "--title") out.title = value();
    else if (a === "--profile") out.profile = value();
    else if (a === "--model") out.model = value();
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else out.base = a;
  }
  return out;
}

function git(...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
}

function localDiff(o: ReturnType<typeof parseArgs>): { diff: string; title: string; repo?: string } {
  if (o.file) return { diff: o.file === "-" ? readFileSync(0, "utf8") : readFileSync(o.file, "utf8"), title: o.title ?? o.file };
  const remote = (() => {
    try {
      return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(git("remote", "get-url", "origin").trim())?.[1];
    } catch {
      return undefined;
    }
  })();
  const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
  if (o.staged) return { diff: git("diff", "--cached"), title: o.title ?? `${branch} (staged)`, ...(remote ? { repo: remote } : {}) };
  let base = o.base;
  if (!base) {
    try {
      base = git("rev-parse", "--abbrev-ref", "@{upstream}").trim();
      if (base.endsWith(`/${branch}`)) base = "main";
    } catch {
      base = "main";
    }
  }
  return { diff: git("diff", `${base}...HEAD`), title: o.title ?? `${branch} vs ${base}`, ...(remote ? { repo: remote } : {}) };
}

export class Client {
  constructor(private readonly cfg: Config) {}
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.url}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${this.cfg.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${(() => { try { return (JSON.parse(text) as { error?: string }).error ?? text; } catch { return text; } })()}`);
    return (path.endsWith(".md") ? text : JSON.parse(text)) as T;
  }
}

/** Adds the diff as a patch item, queues a review, waits, returns the review and its markdown. */
export async function reviewDiff(
  client: Client,
  input: { diff: string; title: string; repo?: string; profile?: string; model?: string },
  onStatus: (s: string) => void = () => {},
  pollMs = 2000,
): Promise<{ review: { id: number; status: string; conclusion: string | null; verdict_title: string | null; error: string | null }; markdown: string | null }> {
  if (!input.diff.trim()) throw new Error("the diff is empty");
  const state = await client.call<{ accounts: { id: string; credentialId: string | null }[]; profiles: { id: string; name: string }[] }>("GET", "/state");
  const account = state.accounts.find((a) => a.credentialId) ?? state.accounts[0];
  if (!account) throw new Error("add a GitHub account with a Claude credential in the panel first");
  const profile = input.profile ? state.profiles.find((p) => p.id === input.profile || p.name.toLowerCase() === input.profile!.toLowerCase()) : undefined;
  if (input.profile && !profile) throw new Error(`no profile "${input.profile}"; have: ${state.profiles.map((p) => p.name).join(", ")}`);
  const { item } = await client.call<{ item: { id: string } }>("POST", "/items", { accountId: account.id, kind: "patch", title: input.title.slice(0, 200), patch: input.diff, ...(input.repo ? { repo: input.repo } : {}) });
  const { id } = await client.call<{ id: number }>("POST", "/reviews", { itemId: item.id, ...(profile ? { profileId: profile.id } : {}), ...(input.model ? { model: input.model } : {}) });
  let last = "";
  for (;;) {
    const { review } = await client.call<{ review: { id: number; status: string; conclusion: string | null; verdict_title: string | null; error: string | null } }>("GET", `/reviews/${id}`);
    if (review.status !== last) onStatus((last = review.status));
    if (review.status === "done") return { review, markdown: await client.call<string>("GET", `/reviews/${id}/export.md`) };
    if (review.status === "error" || review.status === "skipped") return { review, markdown: null };
    await Bun.sleep(pollMs);
  }
}

async function main(): Promise<number> {
  const o = parseArgs(process.argv.slice(2));
  if (o.cmd !== "review") {
    console.log(HELP);
    return o.cmd === "help" || o.cmd === "--help" ? 0 : 2;
  }
  const client = new Client(loadConfig());
  const local = localDiff(o);
  const { review, markdown } = await reviewDiff(client, { ...local, ...(o.profile ? { profile: o.profile } : {}), ...(o.model ? { model: o.model } : {}) }, (s) => !o.json && console.error(`… ${s}`));
  if (o.json) console.log(JSON.stringify({ review, markdown }));
  else console.log(markdown ?? `review failed: ${review.error ?? review.status}`);
  if (review.status !== "done") return 1;
  // Exit 3 when the review blocks, so scripts and hooks can stop on it.
  return review.conclusion === "action_required" ? 3 : 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`apr: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
