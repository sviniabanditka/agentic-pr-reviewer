import { findingMarker, isBlockingCandidate } from "../verdict/verdict.js";
import type { ReviewResult } from "../review/run.js";
import type { VerifiedFinding } from "../review/verify.js";

export const COMMENT_MARKER = "<!-- agentic-pr-reviewer -->";

// GitHub rejects comment bodies over 65536 characters.
const BODY_LIMIT = 60_000;

export interface CommentMeta {
  repo: string;
  /** Finding links point at this commit, so they stay right after later pushes. */
  headSha: string;
  model: string;
  elapsedMs: number;
}

export function renderComment(result: ReviewResult, meta: CommentMeta): string {
  const header = [
    COMMENT_MARKER,
    "🤖 Agentic PR Reviewer",
    "",
    `**${verdictIcon(result)} ${result.verdict.title}**`,
    "",
    `<sub>commit \`${meta.headSha.slice(0, 7)}\` · ${meta.model} · ${Math.round(meta.elapsedMs / 1000)}s</sub>`,
  ].join("\n");

  const confirmed = new Set(result.confirmedMarkers);
  const blocking = result.findings.filter((f) => isBlockingCandidate(f) && confirmed.has(findingMarker(f)));
  const unconfirmed = result.findings.filter((f) => isBlockingCandidate(f) && !confirmed.has(findingMarker(f)));
  const notes = result.findings.filter((f) => !isBlockingCandidate(f) && f.evidenceCheck !== "not_found");
  const lowConfidence = result.findings.filter((f) => !isBlockingCandidate(f) && f.evidenceCheck === "not_found");

  const sections = [
    section("### 🟥 Blocking", blocking, meta),
    section("### 🟧 Blocking, not confirmed by a second run", unconfirmed, meta),
    section("### 🟨 Notes", notes, meta),
  ].filter((s) => s !== "");

  const tail: string[] = [];
  if (lowConfidence.length > 0) {
    tail.push(details(`Low confidence — quoted evidence not found in the diff (${lowConfidence.length})`, lowConfidence.map((f) => renderFinding(f, meta)).join("\n\n")));
  }
  if (result.skippedFiles.length > 0) {
    tail.push(details(`Not reviewed (${result.skippedFiles.length})`, result.skippedFiles.map((s) => `- \`${s.path}\` (${s.reason})`).join("\n")));
  }

  const body = [header, ...sections, ...tail].join("\n\n");
  return body.length <= BODY_LIMIT ? body : `${body.slice(0, BODY_LIMIT)}\n\n… (truncated)`;
}

function verdictIcon(result: ReviewResult): string {
  if (result.verdict.conclusion === "success") return "✅";
  return result.confirmedMarkers.length > 0 ? "🟥" : "⚠️";
}

function section(title: string, findings: VerifiedFinding[], meta: CommentMeta): string {
  if (findings.length === 0) return "";
  return [title, ...findings.map((f) => renderFinding(f, meta))].join("\n\n");
}

function renderFinding(f: VerifiedFinding, meta: CommentMeta): string {
  const range = f.line_start === f.line_end ? `${f.line_start}` : `${f.line_start}-${f.line_end}`;
  const anchor = f.line_start === f.line_end ? `L${f.line_start}` : `L${f.line_start}-L${f.line_end}`;
  const link = `https://github.com/${meta.repo}/blob/${meta.headSha}/${f.file}#${anchor}`;
  const lines = [`**\`${f.category}\`** [\`${f.file}:${range}\`](${link}) — **${f.claim}**`, "", f.detail];
  if (f.evidence.trim() !== "") {
    const fence = f.evidence.includes("```") ? "````" : "```";
    lines.push("", details("evidence", `${fence}\n${f.evidence}\n${fence}`));
  }
  return lines.join("\n");
}

function details(summary: string, content: string): string {
  return `<details><summary>${summary}</summary>\n\n${content}\n\n</details>`;
}
