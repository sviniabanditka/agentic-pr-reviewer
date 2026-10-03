import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Token-shaped literals must never land in the repository, not even in fixtures.
const PATTERNS = [
  /ghp_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{40,}/,
  /gho_[A-Za-z0-9]{30,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /sk-or-[A-Za-z0-9_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const SKIP = new Set(["node_modules", ".git", "data", "dist"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("repository", () => {
  it("contains no token-shaped literals", () => {
    const root = join(import.meta.dir, "../..");
    const hits = files(root)
      .filter((f) => !/\.(png|jpg|woff2?|lockb)$/.test(f))
      .filter((f) => PATTERNS.some((p) => p.test(readFileSync(f, "utf8"))));
    expect(hits).toEqual([]);
  });
});
