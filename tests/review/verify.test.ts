import { describe, expect, it } from "bun:test";
import { verifyFindings } from "../../src/review/verify.js";
import type { Finding } from "../../src/review/finding.js";
import type { PreparedDiff, PreparedFile } from "../../src/review/diff.js";

function preparedFile(overrides: Partial<PreparedFile> & { path: string }): PreparedFile {
  return {
    status: "modified",
    promptText: "",
    newLines: [],
    removedLines: [],
    tokenEstimate: 0,
    ...overrides,
  };
}

function diff(files: PreparedFile[]): PreparedDiff {
  return { files, skippedFiles: [], tokenEstimate: 0 };
}

function finding(overrides: Partial<Finding> & { file: string }): Finding {
  return {
    category: "OTHER",
    line_start: 1,
    line_end: 1,
    evidence: "",
    evidence_kind: "present",
    claim: "claim",
    detail: "detail",
    ...overrides,
  };
}

describe("verifyFindings — evidence_kind present", () => {
  it("matches when a new line equals the evidence exactly", () => {
    const d = diff([preparedFile({ path: "a.ts", newLines: [{ line: 1, text: "const x = 1;" }] })]);
    const f = finding({ file: "a.ts", evidence: "const x = 1;" });

    expect(verifyFindings([f], d)[0]!.evidenceCheck).toBe("matched");
  });

  it("matches when a new line contains the evidence as a substring", () => {
    const d = diff([preparedFile({ path: "a.ts", newLines: [{ line: 1, text: "  const x = 1; // note" }] })]);
    const f = finding({ file: "a.ts", evidence: "const x = 1;" });

    expect(verifyFindings([f], d)[0]!.evidenceCheck).toBe("matched");
  });

  it("returns not_found when the evidence text is absent from every new line", () => {
    const d = diff([preparedFile({ path: "a.ts", newLines: [{ line: 1, text: "something else;" }] })]);
    const f = finding({ file: "a.ts", evidence: "const x = 1;" });

    expect(verifyFindings([f], d)[0]!.evidenceCheck).toBe("not_found");
  });

  it("matches a multi-line evidence block when every line matches individually", () => {
    const d = diff([
      preparedFile({
        path: "a.ts",
        newLines: [
          { line: 1, text: "      const x = compute();" },
          { line: 2, text: "      save(x);" },
        ],
      }),
    ]);
    const f = finding({ file: "a.ts", evidence: "const x = compute();\n      save(x);" });

    expect(verifyFindings([f], d)[0]!.evidenceCheck).toBe("matched");
  });

  it("returns not_found when one line of a multi-line evidence block does not match", () => {
    const d = diff([preparedFile({ path: "a.ts", newLines: [{ line: 1, text: "const x = compute();" }] })]);
    const f = finding({ file: "a.ts", evidence: "const x = compute();\nsave(x);" });

    expect(verifyFindings([f], d)[0]!.evidenceCheck).toBe("not_found");
  });

  it("downgrades GUARD-REMOVED with present evidence to OTHER, keeping the trace in detail", () => {
    const d = diff([preparedFile({ path: "a.ts", newLines: [{ line: 1, text: "find(id);" }] })]);
    const f = finding({ file: "a.ts", category: "GUARD-REMOVED", evidence: "find(id);" });

    const [v] = verifyFindings([f], d);
    expect(v!.category).toBe("OTHER");
    expect(v!.detail).toContain("Downgraded from GUARD-REMOVED");
  });

  it("keeps GUARD-REMOVED when evidence_kind is removed and the line matches", () => {
    const d = diff([preparedFile({ path: "a.ts", removedLines: ["validate(input);"] })]);
    const f = finding({
      file: "a.ts",
      category: "GUARD-REMOVED",
      evidence_kind: "removed",
      evidence: "validate(input);",
    });

    const [v] = verifyFindings([f], d);
    expect(v!.category).toBe("GUARD-REMOVED");
    expect(v!.evidenceCheck).toBe("matched");
  });

  it("returns not_found when the finding's file is not in the diff", () => {
    const d = diff([preparedFile({ path: "other.ts", newLines: [{ line: 1, text: "const x = 1;" }] })]);
    const f = finding({ file: "a.ts", evidence: "const x = 1;" });

    expect(verifyFindings([f], d)[0]!.evidenceCheck).toBe("not_found");
  });

  it("returns not_found when evidence is empty, even if the file has matching content", () => {
    const d = diff([preparedFile({ path: "a.ts", newLines: [{ line: 1, text: "" }] })]);
    const f = finding({ file: "a.ts", evidence: "" });

    expect(verifyFindings([f], d)[0]!.evidenceCheck).toBe("not_found");
  });
});

describe("verifyFindings — evidence_kind removed", () => {
  it("matches against removedLines, not newLines", () => {
    const d = diff([
      preparedFile({
        path: "a.ts",
        newLines: [{ line: 1, text: "safe();" }],
        removedLines: ["dangerous();"],
      }),
    ]);
    const f = finding({ file: "a.ts", evidence_kind: "removed", evidence: "dangerous();" });

    expect(verifyFindings([f], d)[0]!.evidenceCheck).toBe("matched");
  });

  it("does not match removed evidence against newLines content", () => {
    const d = diff([
      preparedFile({ path: "a.ts", newLines: [{ line: 1, text: "dangerous();" }], removedLines: [] }),
    ]);
    const f = finding({ file: "a.ts", evidence_kind: "removed", evidence: "dangerous();" });

    expect(verifyFindings([f], d)[0]!.evidenceCheck).toBe("not_found");
  });
});

describe("verifyFindings — evidence_kind absent", () => {
  it("always returns skipped_absent regardless of diff content", () => {
    const d = diff([preparedFile({ path: "a.ts" })]);
    const f = finding({ file: "a.ts", evidence_kind: "absent", evidence: "" });

    expect(verifyFindings([f], d)[0]!.evidenceCheck).toBe("skipped_absent");
  });
});
