import type { Finding } from "./finding.js";
import type { PreparedDiff } from "./diff.js";

export type EvidenceCheck = "matched" | "not_found" | "skipped_absent";

/** A finding after its quoted evidence was checked against the diff. */
export interface VerifiedFinding extends Finding {
  evidenceCheck: EvidenceCheck;
  /**
   * For absence findings: the new-side line at line_start, quoted by the pipeline rather
   * than the model, so the marker survives a reworded claim in the confirmation run.
   */
  anchor?: string;
}

function matchesLine(needle: string, lines: string[]): boolean {
  return lines.some((line) => {
    const hay = line.trim();
    return hay === needle || hay.includes(needle);
  });
}

// Models quote multi-line blocks despite the one-line instruction; a block
// counts as matched when every line of it matches individually.
function matchesEvidence(evidence: string, lines: string[]): boolean {
  const needles = evidence
    .split("\n")
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "");
  if (needles.length === 0) return false;
  return needles.every((needle) => matchesLine(needle, lines));
}

function checkEvidence(finding: Finding, diff: PreparedDiff): EvidenceCheck {
  if (finding.evidence_kind === "absent") return "skipped_absent";

  const file = diff.files.find((f) => f.path === finding.file);
  if (!file) return "not_found";

  const lines =
    finding.evidence_kind === "present"
      ? file.newLines.map((l) => l.text)
      : file.removedLines;

  return matchesEvidence(finding.evidence, lines) ? "matched" : "not_found";
}

// GUARD-REMOVED asserts a deleted guard, so its proof must be a removed line;
// with present/absent evidence the claim is cross-layer speculation → OTHER.
function normalizeCategory(finding: Finding): Finding {
  if (finding.category !== "GUARD-REMOVED" || finding.evidence_kind === "removed") return finding;
  return {
    ...finding,
    category: "OTHER",
    detail: `${finding.detail}\n\n_Downgraded from GUARD-REMOVED: claim lacks removed-line evidence._`,
  };
}

export function verifyFindings(findings: Finding[], diff: PreparedDiff): VerifiedFinding[] {
  return findings.map((finding) => {
    const normalized = normalizeCategory(finding);
    const verified: VerifiedFinding = { ...normalized, evidenceCheck: checkEvidence(normalized, diff) };
    if (normalized.evidence_kind === "absent") {
      const line = diff.files.find((f) => f.path === normalized.file)?.newLines.find((l) => l.line === normalized.line_start);
      if (line && line.text.trim() !== "") verified.anchor = line.text;
    }
    return verified;
  });
}
