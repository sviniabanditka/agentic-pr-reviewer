import { describe, expect, it } from "bun:test";
import { chunkDiff, renderChunk } from "../../src/review/chunk.js";
import type { RawPatchFile } from "../../src/review/diff.js";

function file(path: string, lines: number): RawPatchFile {
  const body = Array.from({ length: lines }, (_, i) => `+const line${i} = "${"x".repeat(40)}";`).join("\n");
  return { path, status: "added", additions: lines, deletions: 0, patch: `@@ -0,0 +1,${lines} @@\n${body}` };
}

describe("chunkDiff", () => {
  it("keeps a small PR in one chunk", () => {
    const d = chunkDiff([file("a.ts", 5), file("b.ts", 5)], { budgetTokens: 32000, maxChunks: 6 });
    expect(d.chunks).toHaveLength(1);
    expect(d.chunks[0]!.paths).toEqual(["a.ts", "b.ts"]);
    expect(d.skippedFiles).toEqual([]);
  });

  it("spreads files over chunks instead of dropping them", () => {
    const files = Array.from({ length: 6 }, (_, i) => file(`f${i}.ts`, 40));
    const d = chunkDiff(files, { budgetTokens: 1500, maxChunks: 6 });
    expect(d.chunks.length).toBeGreaterThan(1);
    expect(d.chunks.flatMap((c) => c.paths).sort()).toEqual(files.map((f) => f.path).sort());
    expect(d.chunks.every((c) => c.tokens <= 1500)).toBe(true);
  });

  it("splits a file bigger than the budget by hunks", () => {
    const hunks = Array.from({ length: 4 }, (_, h) => `@@ -0,0 +${h * 100 + 1},30 @@\n` + Array.from({ length: 30 }, (_, i) => `+const h${h}l${i} = "${"y".repeat(40)}";`).join("\n")).join("\n");
    const big: RawPatchFile = { path: "big.ts", status: "added", additions: 120, deletions: 0, patch: hunks };
    const d = chunkDiff([big], { budgetTokens: 1200, maxChunks: 6 });
    expect(d.chunks.length).toBeGreaterThan(1);
    expect(d.chunks.some((c) => c.text.includes("## File: 'big.ts' (part 1 of"))).toBe(true);
  });

  it("lists what does not fit in maxChunks as over budget", () => {
    const files = Array.from({ length: 5 }, (_, i) => file(`f${i}.ts`, 40));
    const d = chunkDiff(files, { budgetTokens: 1000, maxChunks: 2 });
    expect(d.chunks).toHaveLength(2);
    expect(d.skippedFiles.some((s) => s.reason === "over_budget")).toBe(true);
  });

  it("tells each part what the others hold", () => {
    const d = chunkDiff([file("a.ts", 40), file("b.ts", 40)], { budgetTokens: 1000, maxChunks: 6 });
    const text = renderChunk(d, d.chunks[0]!);
    expect(text).toContain("part 1 of 2");
    expect(text).toContain("Reviewed in other parts");
  });

  it("verification sees every file even when they are split across chunks", () => {
    const d = chunkDiff([file("a.ts", 40), file("b.ts", 40)], { budgetTokens: 1000, maxChunks: 6 });
    expect(d.full.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });
});
