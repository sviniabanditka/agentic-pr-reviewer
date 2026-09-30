import { describe, expect, it } from "bun:test";
import { COMMENT_MARKER, renderComment } from "../../src/github/comment.js";
import { findingMarker } from "../../src/verdict/verdict.js";
import type { ReviewResult } from "../../src/review/run.js";
import type { VerifiedFinding } from "../../src/review/verify.js";

const meta = { repo: "o/r", headSha: "abcdef1234567", model: "sonnet", elapsedMs: 21400 };

function finding(overrides: Partial<VerifiedFinding> = {}): VerifiedFinding {
  return {
    category: "SEC-AUTHZ",
    file: "src/a.ts",
    line_start: 4,
    line_end: 5,
    evidence: "db.find({ id })",
    evidence_kind: "present",
    claim: "query is not scoped to the user",
    detail: "add the owner filter",
    evidenceCheck: "matched",
    ...overrides,
  };
}

function result(findings: VerifiedFinding[], confirmed: VerifiedFinding[] = []): ReviewResult {
  return {
    outcome: findings.length > 0 ? "findings" : "no_findings",
    verdict: confirmed.length > 0
      ? { conclusion: "action_required", title: "1 blocking finding(s) confirmed by a second run" }
      : { conclusion: "success", title: "no blocking findings" },
    findings,
    confirmedMarkers: confirmed.map(findingMarker),
    skippedFiles: [],
    usage: { runs: 1, tokensIn: 1, tokensOut: 1, costUsd: 0, latencyModelMs: 1 },
  };
}

describe("renderComment", () => {
  it("starts with the hidden marker and the bare Agentic PR Reviewer header", () => {
    const [first, second] = renderComment(result([]), meta).split("\n");
    expect(first).toBe(COMMENT_MARKER);
    expect(second).toBe("🤖 Agentic PR Reviewer");
  });

  it("names the reviewed commit, the model and the time", () => {
    expect(renderComment(result([]), meta)).toContain("<sub>commit `abcdef1` · sonnet · 21s</sub>");
  });

  it("puts a confirmed blocking finding under Blocking with a link to the line at the head commit", () => {
    const f = finding();
    const body = renderComment(result([f], [f]), meta);
    expect(body).toContain("### 🟥 Blocking");
    expect(body).toContain("https://github.com/o/r/blob/abcdef1234567/src/a.ts#L4-L5");
  });

  it("an unconfirmed blocking finding is shown apart from confirmed ones", () => {
    const body = renderComment(result([finding()]), meta);
    expect(body).toContain("not confirmed by a second run");
    expect(body).not.toContain("### 🟥 Blocking\n");
  });

  it("hides findings whose quote was not found in the diff under low confidence", () => {
    const body = renderComment(result([finding({ category: "OTHER", evidenceCheck: "not_found" })]), meta);
    expect(body).toContain("<summary>Low confidence");
    expect(body).not.toContain("### 🟨 Notes");
  });

  it("stays under GitHub's comment size limit", () => {
    const huge = Array.from({ length: 400 }, (_, i) => finding({ category: "NICHE", claim: `c${i}`, detail: "x".repeat(300) }));
    expect(renderComment(result(huge), meta).length).toBeLessThan(65536);
  });
});
