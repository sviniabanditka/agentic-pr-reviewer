import type { Database } from "bun:sqlite";
import { checkVerdict, findingMarker } from "../verdict/verdict.js";
import { isInconclusive, type ReviewResult } from "./run.js";

export function dismissedMarkers(db: Database, itemId: string | null): Map<string, string> {
  if (!itemId) return new Map();
  const rows = db.query("SELECT marker, note FROM dismissals WHERE item_id = ?").all(itemId) as { marker: string; note: string }[];
  return new Map(rows.map((r) => [r.marker, r.note]));
}

/**
 * Applies the item's dismissals to a stored result: dismissed findings are flagged, stop
 * blocking, and the verdict is recomputed without them.
 */
export function applyDismissals(result: ReviewResult, dismissed: Map<string, string>): ReviewResult {
  if (dismissed.size === 0 || result.summary) return result;
  const findings = result.findings.map((f) => (dismissed.has(findingMarker(f)) ? { ...f, dismissed: true, dismissNote: dismissed.get(findingMarker(f)) } : f));
  const confirmedMarkers = result.confirmedMarkers.filter((m) => !dismissed.has(m));
  if (confirmedMarkers.length === result.confirmedMarkers.length && findings.every((f, i) => f === result.findings[i])) return result;
  const verdict = isInconclusive(result.outcome)
    ? result.verdict
    : confirmedMarkers.length === 0 && result.confirmedMarkers.length > 0
      ? { conclusion: "success" as const, title: `${result.confirmedMarkers.length} blocking finding(s) dismissed` }
      : checkVerdict(result.outcome, result.confirmationOutcome, confirmedMarkers.length);
  return { ...result, findings, confirmedMarkers, verdict };
}
