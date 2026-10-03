import { findingMarker, isBlockingCandidate } from "../verdict/verdict.js";
import { BLOCKING_CATEGORIES } from "../review/finding.js";
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
  if (result.summary) return renderSummary(result, meta);
  const blocking = result.blocking ?? BLOCKING_CATEGORIES;
  const isBlocking = (f: VerifiedFinding) => isBlockingCandidate(f, blocking);
  const header = [
    COMMENT_MARKER,
    "🤖 Agentic PR Reviewer",
    "",
    `**${verdictIcon(result)} ${result.verdict.title}**`,
    "",
    `<sub>commit \`${meta.headSha.slice(0, 7)}\` · ${meta.model} · ${Math.round(meta.elapsedMs / 1000)}s${result.incremental ? ` · changes since \`${result.incremental.baseSha.slice(0, 7)}\`` : ""}</sub>`,
  ].join("\n");

  const confirmed = new Set(result.confirmedMarkers);
  const active = result.findings.filter((f) => !f.dismissed);
  const dismissed = result.findings.filter((f) => f.dismissed);
  const confirmedBlocking = active.filter((f) => isBlocking(f) && confirmed.has(findingMarker(f)));
  const unconfirmed = active.filter((f) => isBlocking(f) && !confirmed.has(findingMarker(f)));
  const notes = active.filter((f) => !isBlocking(f) && f.evidenceCheck !== "not_found");
  const lowConfidence = active.filter((f) => !isBlocking(f) && f.evidenceCheck === "not_found");

  const sections = [
    section("### 🟥 Blocking", confirmedBlocking, meta),
    section("### 🟧 Blocking, not confirmed by a second run", unconfirmed, meta),
    section("### 🟨 Notes", notes, meta),
  ].filter((s) => s !== "");

  const tail: string[] = [];
  if (result.incremental?.fixed.length) {
    tail.unshift(`### ✅ Fixed since \`${result.incremental.baseSha.slice(0, 7)}\`\n\n${result.incremental.fixed.map((f) => `- ~~**\`${f.category}\`** \`${f.file}\` — ${f.claim}~~`).join("\n")}`);
  }
  if (dismissed.length > 0) {
    tail.push(details(`Dismissed (${dismissed.length})`, dismissed.map((f) => `- **\`${f.category}\`** \`${f.file}\` — ${f.claim}${f.dismissNote ? ` _(${f.dismissNote})_` : ""}`).join("\n")));
  }
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
  const lines = [`**\`${f.category}\`**${f.state === "new" ? " _new_" : ""} [\`${f.file}:${range}\`](${link}) — **${f.claim}**`, "", f.detail];
  if (f.evidence.trim() !== "") {
    const fence = f.evidence.includes("```") ? "````" : "```";
    lines.push("", details("evidence", `${fence}\n${f.evidence}\n${fence}`));
  }
  return lines.join("\n");
}

function details(summary: string, content: string): string {
  return `<details><summary>${summary}</summary>\n\n${content}\n\n</details>`;
}

/** Summary mode: a ready-to-paste PR description instead of findings. */
function renderSummary(result: ReviewResult, meta: CommentMeta): string {
  const sm = result.summary!;
  const list = (title: string, xs: string[]) => (xs.length ? `### ${title}\n\n${xs.map((x) => `- ${x}`).join("\n")}` : "");
  return [
    COMMENT_MARKER,
    "🤖 Agentic PR Reviewer",
    "",
    `**${sm.title}**`,
    "",
    `<sub>commit \`${meta.headSha.slice(0, 7)}\` · ${meta.model} · ${Math.round(meta.elapsedMs / 1000)}s · summary</sub>`,
    "",
    sm.summary,
    list("Changes", sm.changes),
    list("Risks", sm.risks),
    list("How to test", sm.testing),
  ].filter((x) => x !== "").join("\n\n").slice(0, BODY_LIMIT);
}

/** Inline comments for a GitHub review: quoted, present-side findings on lines the diff contains. */
export function renderInline(result: ReviewResult, inDiff: (path: string, line: number) => boolean): { path: string; line: number; body: string }[] {
  return result.findings
    .filter((f) => !f.dismissed && f.evidence_kind === "present" && f.evidenceCheck === "matched" && inDiff(f.file, Math.max(f.line_start, f.line_end)))
    .map((f) => ({ path: f.file, line: Math.max(f.line_start, f.line_end), body: `**\`${f.category}\`** ${f.claim}\n\n${f.detail}` }));
}

/** The comment without the hidden marker, for downloads. */
export function renderMarkdown(result: ReviewResult, meta: CommentMeta & { title: string; number: number }): string {
  return `# ${meta.repo} #${meta.number}: ${meta.title}\n\n${renderComment(result, meta).replace(`${COMMENT_MARKER}\n`, "")}\n`;
}
