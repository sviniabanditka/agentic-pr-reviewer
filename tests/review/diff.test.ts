import { describe, expect, it } from "bun:test";
import { prepareDiff, renderDiffForPrompt } from "../../src/review/diff.js";
import type { RawPatchFile } from "../../src/review/diff.js";

function file(overrides: Partial<RawPatchFile> & { path: string }): RawPatchFile {
  return { status: "modified", additions: 0, deletions: 0, ...overrides };
}

describe("prepareDiff — hunk numbering", () => {
  it("numbers new-side lines per hunk, continuing across multiple hunks in the same file", () => {
    // Hand-computed from the @@ headers: hunk 1 new side starts at 10, hunk 2 at 30.
    const patch = [
      "@@ -10,3 +10,4 @@",
      " context a",
      "+added a",
      " context b",
      "@@ -40,2 +30,3 @@",
      " context c",
      "+added c",
      " context d",
    ].join("\n");

    const result = prepareDiff([file({ path: "src/foo.ts", patch })]);
    const prepared = result.files[0]!;

    expect(prepared.newLines).toEqual([
      { line: 10, text: "context a" },
      { line: 11, text: "added a" },
      { line: 12, text: "context b" },
      { line: 30, text: "context c" },
      { line: 31, text: "added c" },
      { line: 32, text: "context d" },
    ]);
    expect(prepared.promptText).toContain("10  context a\n11 +added a\n12  context b");
    expect(prepared.promptText).toContain("30  context c\n31 +added c\n32  context d");
  });

  it("keeps a delete-only hunk with only __old hunk__, no __new hunk__ block", () => {
    const patch = ["@@ -5,3 +4,0 @@", "-removed one", "-removed two", "-removed three"].join("\n");

    const result = prepareDiff([file({ path: "src/gone.ts", patch })]);
    const prepared = result.files[0]!;

    expect(prepared.promptText).not.toContain("__new hunk__");
    expect(prepared.promptText).toContain("__old hunk__\n removed one\n removed two\n removed three");
    expect(prepared.newLines).toEqual([]);
    expect(prepared.removedLines).toEqual(["removed one", "removed two", "removed three"]);
  });

  it("omits __old hunk__ for an added-only hunk", () => {
    const patch = ["@@ -5,0 +5,2 @@", "+added one", "+added two"].join("\n");

    const result = prepareDiff([file({ path: "src/new.ts", patch })]);
    const prepared = result.files[0]!;

    expect(prepared.promptText).not.toContain("__old hunk__");
    expect(prepared.promptText).toContain("__new hunk__\n5 +added one\n6 +added two");
    expect(prepared.removedLines).toEqual([]);
  });

  it("omits __old hunk__ when a hunk has context but no removed lines", () => {
    const patch = ["@@ -5,2 +5,3 @@", " context only", "+added line", " more context"].join("\n");

    const result = prepareDiff([file({ path: "src/mixed.ts", patch })]);
    const prepared = result.files[0]!;

    expect(prepared.promptText).not.toContain("__old hunk__");
  });
});

describe("prepareDiff — skip reasons", () => {
  it("skips binary files (no patch) with reason binary", () => {
    const result = prepareDiff([file({ path: "assets/logo.png" })]);

    expect(result.files).toEqual([]);
    expect(result.skippedFiles).toEqual([{ path: "assets/logo.png", reason: "binary" }]);
  });

  it("skips lockfiles by basename deny-list, even with a valid patch", () => {
    const patch = ["@@ -1,1 +1,1 @@", "-a", "+b"].join("\n");
    const result = prepareDiff([
      file({ path: "pnpm-lock.yaml", patch }),
      file({ path: "vendor/yarn.lock", patch }),
      file({ path: "dist/app.min.js", patch }),
      file({ path: "src/foo.ts.snap", patch }),
    ]);

    expect(result.files).toEqual([]);
    expect(result.skippedFiles).toEqual([
      { path: "pnpm-lock.yaml", reason: "lockfile" },
      { path: "vendor/yarn.lock", reason: "lockfile" },
      { path: "dist/app.min.js", reason: "lockfile" },
      { path: "src/foo.ts.snap", reason: "lockfile" },
    ]);
  });
});

describe("prepareDiff — rename mapping", () => {
  it("carries oldPath through for a renamed file", () => {
    const patch = ["@@ -1,1 +1,1 @@", "-old content", "+new content"].join("\n");
    const result = prepareDiff([
      file({ path: "src/renamed.ts", oldPath: "src/original.ts", status: "renamed", patch }),
    ]);

    expect(result.files[0]!.oldPath).toBe("src/original.ts");
    expect(result.files[0]!.status).toBe("renamed");
  });

  it("omits oldPath when the file was not renamed", () => {
    const patch = ["@@ -1,1 +1,1 @@", "-old content", "+new content"].join("\n");
    const result = prepareDiff([file({ path: "src/plain.ts", patch })]);

    expect(result.files[0]!.oldPath).toBeUndefined();
  });
});

describe("prepareDiff — budget", () => {
  // Each file's promptText is padded to a known character length so tokenEstimate
  // is exactly predictable: Math.ceil(chars / 3.5).
  function paddedFile(path: string, contentChars: number): RawPatchFile {
    const content = "x".repeat(contentChars);
    const patch = ["@@ -1,1 +1,1 @@", `+${content}`].join("\n");
    return file({ path, patch });
  }

  it("soft-skips a file that would drop remaining budget below softThreshold, but keeps trying later files", () => {
    // maxTokens 100, softThreshold 20, hardThreshold 5.
    // File A costs ~15 tokens (consumed -> 15, remaining 85).
    // File B costs ~70 tokens: remaining(85) - 70 = 15 < softThreshold(20) -> soft-skip.
    // File C costs ~10 tokens: remaining(85) - 10 = 75 >= softThreshold(20) -> kept.
    const fileA = paddedFile("a.ts", Math.floor(15 * 3.5) - "## File: 'a.ts'\n\n__new hunk__\n1 +".length);
    const fileB = paddedFile("b.ts", Math.floor(70 * 3.5) - "## File: 'b.ts'\n\n__new hunk__\n1 +".length);
    const fileC = paddedFile("c.ts", Math.floor(10 * 3.5) - "## File: 'c.ts'\n\n__new hunk__\n1 +".length);

    const result = prepareDiff([fileA, fileB, fileC], { maxTokens: 100, softThreshold: 20, hardThreshold: 5 });

    expect(result.files.map((f) => f.path)).toEqual(["a.ts", "c.ts"]);
    expect(result.skippedFiles).toEqual([{ path: "b.ts", reason: "over_budget" }]);
  });

  it("hard-stops and skips all remaining files once remaining budget drops below hardThreshold", () => {
    // maxTokens 50, hardThreshold 10. First file consumes down to remaining < 10.
    const fileA = paddedFile("a.ts", Math.floor(45 * 3.5) - "## File: 'a.ts'\n\n__new hunk__\n1 +".length);
    const fileB = paddedFile("b.ts", 5);
    const fileC = paddedFile("c.ts", 5);

    const result = prepareDiff([fileA, fileB, fileC], { maxTokens: 50, softThreshold: 1, hardThreshold: 10 });

    expect(result.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(result.skippedFiles).toEqual([
      { path: "b.ts", reason: "over_budget" },
      { path: "c.ts", reason: "over_budget" },
    ]);
  });

  it("uses default budget (32000/1500/1000) when no options given", () => {
    const patch = ["@@ -1,1 +1,1 @@", "+small change"].join("\n");
    const result = prepareDiff([file({ path: "src/tiny.ts", patch })]);

    expect(result.files).toHaveLength(1);
    expect(result.skippedFiles).toEqual([]);
  });
});

describe("prepareDiff — token estimate", () => {
  it("computes tokenEstimate as ceil(promptText chars / 3.5), and totals across files", () => {
    const patch = ["@@ -1,1 +1,1 @@", "+abc"].join("\n");
    const result = prepareDiff([file({ path: "src/a.ts", patch })]);
    const prepared = result.files[0]!;

    expect(prepared.tokenEstimate).toBe(Math.ceil(prepared.promptText.length / 3.5));
    expect(result.tokenEstimate).toBe(prepared.tokenEstimate);
  });
});

describe("renderDiffForPrompt", () => {
  it("joins file blocks with a blank line and appends a Files not shown section when files were skipped", () => {
    const patch = ["@@ -1,1 +1,1 @@", "+content"].join("\n");
    const diff = prepareDiff([
      file({ path: "src/a.ts", patch }),
      file({ path: "src/b.png" }),
      file({ path: "pnpm-lock.yaml", patch }),
    ]);

    const rendered = renderDiffForPrompt(diff);

    expect(rendered).toContain("## File: 'src/a.ts'");
    expect(rendered).toContain("## Files not shown\nsrc/b.png (binary)\npnpm-lock.yaml (lockfile)");
  });

  it("omits the Files not shown section when nothing was skipped", () => {
    const patch = ["@@ -1,1 +1,1 @@", "+content"].join("\n");
    const diff = prepareDiff([file({ path: "src/a.ts", patch })]);

    const rendered = renderDiffForPrompt(diff);

    expect(rendered).not.toContain("Files not shown");
  });
});
