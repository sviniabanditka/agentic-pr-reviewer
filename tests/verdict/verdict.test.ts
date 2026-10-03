import { describe, expect, it } from "bun:test";
import { checkVerdict, findingMarker, isBlockingCandidate } from "../../src/verdict/verdict.js";
import type { Finding } from "../../src/review/finding.js";
import type { VerifiedFinding } from "../../src/review/verify.js";

function intentFinding(): VerifiedFinding {
  return {
    category: "INTENT",
    file: "src/a.ts",
    line_start: 1,
    line_end: 1,
    evidence: "export function widen(x: number) {",
    evidence_kind: "present",
    claim: "Intent says config stays untouched; diff shows config.ts changed",
    detail: "detail",
    evidenceCheck: "matched",
  };
}

describe("INTENT findings are non-blocking", () => {
  it("a matched INTENT finding is not a blocking candidate", () => {
    expect(isBlockingCandidate(intentFinding())).toBe(false);
  });
});

function finding(overrides: Partial<Finding> & { file: string }): Finding {
  return {
    category: "OTHER",
    line_start: 1,
    line_end: 1,
    evidence: "evidence text",
    evidence_kind: "present",
    claim: "claim text",
    detail: "detail text",
    ...overrides,
  };
}

describe("findingMarker", () => {
  it("is deterministic for the same input", () => {
    const f = finding({ file: "a.ts", category: "SEC-AUTHZ", claim: "missing authz check" });

    expect(findingMarker(f)).toBe(findingMarker(f));
  });

  it("survives a claim rephrasing when the evidence is unchanged", () => {
    const base = finding({ file: "a.ts", category: "SEC-AUTHZ", claim: "no authz on this path", evidence: "$q->delete();" });
    const rephrased = finding({ file: "a.ts", category: "SEC-AUTHZ", claim: "handler lacks a tenant check", evidence: "$q->delete();" });

    expect(findingMarker(base)).toBe(findingMarker(rephrased));
  });

  it("survives a line shift and evidence re-indentation", () => {
    const base = finding({ file: "a.ts", line_start: 3, line_end: 5, evidence: "if (x) {\n  y();\n}" });
    const shifted = finding({ file: "a.ts", line_start: 40, line_end: 42, evidence: "  if (x) {\n    y();\n  }" });

    expect(findingMarker(base)).toBe(findingMarker(shifted));
  });

  it("changes when the evidence changes", () => {
    const base = finding({ file: "a.ts", evidence: "foo()" });
    const changed = finding({ file: "a.ts", evidence: "bar()" });

    expect(findingMarker(base)).not.toBe(findingMarker(changed));
  });

  it("falls back to the claim for evidence-less findings", () => {
    const base = finding({ file: "a.ts", evidence: "", evidence_kind: "absent", claim: "claim one" });
    const other = finding({ file: "a.ts", evidence: "", evidence_kind: "absent", claim: "claim two" });

    expect(findingMarker(base)).not.toBe(findingMarker(other));
  });

  it("has the documented shape with a 12-hex-char hash", () => {
    const f = finding({ file: "src/a.ts", category: "OTHER", line_start: 3, line_end: 5, claim: "x" });

    expect(findingMarker(f)).toMatch(/^<!-- triage:v3:OTHER:src\/a\.ts:[0-9a-f]{12} -->$/);
  });
});

describe("checkVerdict", () => {
  it("no verdict from the first run is never a success", () => {
    expect(checkVerdict("error", undefined, 0).conclusion).toBe("action_required");
  });

  it("a failed confirmation run is never a success", () => {
    expect(checkVerdict("findings", "didnt_look", 0).conclusion).toBe("action_required");
  });

  it("confirmed findings require action, none is a success", () => {
    expect(checkVerdict("findings", "findings", 2).title).toBe("2 blocking finding(s) confirmed by a second run");
    expect(checkVerdict("no_findings", undefined, 0).conclusion).toBe("success");
  });
});
