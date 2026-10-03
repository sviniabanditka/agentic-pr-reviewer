import { BLOCKING_CATEGORIES, type Finding } from "../review/finding.js";
import type { ReviewOutcome } from "../review/claude.js";
import type { VerifiedFinding } from "../review/verify.js";

export interface CheckVerdict {
  conclusion: "success" | "action_required";
  title: string;
}

// A hallucinated quote (not_found) never blocks; skipped_absent may — for
// SEC-AUTHZ the absence of a check is itself the evidence.
export function isBlockingCandidate(f: VerifiedFinding, blocking: readonly string[] = BLOCKING_CATEGORIES): boolean {
  return blocking.includes(f.category) && f.evidenceCheck !== "not_found";
}

export function checkVerdict(
  finalOutcome: ReviewOutcome,
  confirmationOutcome: ReviewOutcome | undefined,
  confirmedCount: number,
): CheckVerdict {
  if (finalOutcome === "didnt_look" || finalOutcome === "error") {
    return { conclusion: "action_required", title: "human required: agent produced no verdict" };
  }
  if (confirmationOutcome === "didnt_look" || confirmationOutcome === "error") {
    return { conclusion: "action_required", title: "human required: confirmation run produced no verdict" };
  }
  if (confirmedCount > 0) {
    return { conclusion: "action_required", title: `${confirmedCount} blocking finding(s) confirmed by a second run` };
  }
  return { conclusion: "success", title: "no blocking findings" };
}

// A finding's identity across runs: line numbers shift and model-worded claims vary,
// so the hash anchors on code — the quoted evidence, or for an absence finding the line
// the pipeline found at its position — and on the claim only when there is neither.
export function findingMarker(f: Finding & { anchor?: string }): string {
  const anchor = f.evidence.trim().length > 0 ? f.evidence : f.anchor?.trim() ? f.anchor : f.claim;
  const normalized = anchor
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .toLowerCase();
  const hash12 = sha256Hex(`${f.category}|${f.file}|${normalized}`).slice(0, 12);
  return `<!-- triage:v3:${f.category}:${f.file}:${hash12} -->`;
}

export function sha256Hex(input: string): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}
