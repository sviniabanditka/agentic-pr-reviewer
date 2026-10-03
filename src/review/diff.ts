export type FileStatus = "added" | "modified" | "deleted" | "renamed";

/** One file's patch as the GitHub API or `git diff` hands it over. */
export interface RawPatchFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** Unified diff body for this file; absent for binary files. */
  patch?: string;
}

export interface NewLine {
  line: number;
  text: string;
}

export type SkipReason = "over_budget" | "binary" | "lockfile";

export interface PreparedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  /** __new hunk__ / __old hunk__ rendering with new-side line numbers. */
  promptText: string;
  /** Added and context lines on the new side, with new-side line numbers. */
  newLines: NewLine[];
  /** Removed line texts, without the leading minus. */
  removedLines: string[];
  tokenEstimate: number;
}

export interface PreparedDiff {
  files: PreparedFile[];
  skippedFiles: { path: string; reason: SkipReason }[];
  tokenEstimate: number;
}

export interface BudgetOptions {
  /** Input token cap for the whole diff. */
  maxTokens: number;
  /** Remaining budget below this → the file is skipped as over_budget, later ones still tried. */
  softThreshold: number;
  /** Remaining budget below this → stop adding files entirely. */
  hardThreshold: number;
}

const DEFAULT_BUDGET: BudgetOptions = { maxTokens: 32000, softThreshold: 1500, hardThreshold: 1000 };

const CHARS_PER_TOKEN = 3.5;

const LOCKFILE_DENY_LIST: Record<string, true> = {
  "pnpm-lock.yaml": true,
  "package-lock.json": true,
  "yarn.lock": true,
  "bun.lockb": true,
  "composer.lock": true,
  "Gemfile.lock": true,
  "Cargo.lock": true,
  "go.sum": true,
  "poetry.lock": true,
};
const LOCKFILE_DENY_SUFFIXES = [".min.js", ".min.css", ".map", ".snap"];

function basename(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? path : path.slice(lastSlash + 1);
}

export function isLockfile(path: string): boolean {
  const name = basename(path);
  if (LOCKFILE_DENY_LIST[name] === true) return true;
  return LOCKFILE_DENY_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

type HunkLine =
  | { kind: "context"; newLine: number; text: string }
  | { kind: "added"; newLine: number; text: string }
  | { kind: "removed"; text: string };

export interface Hunk {
  lines: HunkLine[];
}

const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Parses a unified diff body (gh's per-file "patch") into hunks, tracking new-side
// line numbers from each "@@" header rather than trusting counts in the diff body.
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let newLineCursor = 0;

  for (const rawLine of patch.split("\n")) {
    const header = HUNK_HEADER_PATTERN.exec(rawLine);
    if (header !== null) {
      current = { lines: [] };
      hunks.push(current);
      newLineCursor = Number(header[1]);
      continue;
    }
    if (current === null) continue;

    const marker = rawLine.charAt(0);
    if (marker === "+") {
      current.lines.push({ kind: "added", newLine: newLineCursor, text: rawLine.slice(1) });
      newLineCursor += 1;
    } else if (marker === "-") {
      current.lines.push({ kind: "removed", text: rawLine.slice(1) });
    } else if (marker === " ") {
      current.lines.push({ kind: "context", newLine: newLineCursor, text: rawLine.slice(1) });
      newLineCursor += 1;
    }
    // A line starting with "\" (e.g. "\ No newline at end of file") carries no content.
  }

  return hunks;
}

export function renderHunk(hunk: Hunk): string {
  const newSideLines = hunk.lines.filter((line) => line.kind !== "removed");
  const oldSideLines = hunk.lines.filter((line) => line.kind !== "added");
  const hasRemovedLines = oldSideLines.some((line) => line.kind === "removed");

  const blocks: string[] = [];
  if (newSideLines.length > 0) {
    const rendered = newSideLines.map((line) => {
      const prefix = line.kind === "added" ? "+" : " ";
      return `${line.newLine} ${prefix}${line.text}`;
    });
    blocks.push(`__new hunk__\n${rendered.join("\n")}`);
  }
  if (hasRemovedLines) {
    const rendered = oldSideLines.map((line) => ` ${line.text}`);
    blocks.push(`__old hunk__\n${rendered.join("\n")}`);
  }
  return blocks.join("\n");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function buildPromptText(path: string, hunks: Hunk[]): string {
  const hunkBlocks = hunks.map(renderHunk);
  return `## File: '${path}'\n\n${hunkBlocks.join("\n")}`;
}

function collectNewLines(hunks: Hunk[]): NewLine[] {
  const lines: NewLine[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== "removed") lines.push({ line: line.newLine, text: line.text });
    }
  }
  return lines;
}

function collectRemovedLines(hunks: Hunk[]): string[] {
  const lines: string[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "removed") lines.push(line.text);
    }
  }
  return lines;
}

export function prepareDiff(files: RawPatchFile[], budget: BudgetOptions = DEFAULT_BUDGET): PreparedDiff {

  const preparedFiles: PreparedFile[] = [];
  const skippedFiles: { path: string; reason: SkipReason }[] = [];
  let consumed = 0;
  let overBudgetStop = false;

  for (const file of files) {
    if (overBudgetStop) {
      skippedFiles.push({ path: file.path, reason: "over_budget" });
      continue;
    }
    if (file.patch === undefined) {
      skippedFiles.push({ path: file.path, reason: "binary" });
      continue;
    }
    if (isLockfile(file.path)) {
      skippedFiles.push({ path: file.path, reason: "lockfile" });
      continue;
    }

    const hunks = parseHunks(file.patch);
    const promptText = buildPromptText(file.path, hunks);
    const tokenEstimate = estimateTokens(promptText);
    const remaining = budget.maxTokens - consumed;

    if (remaining < budget.hardThreshold) {
      skippedFiles.push({ path: file.path, reason: "over_budget" });
      overBudgetStop = true;
      continue;
    }
    if (remaining - tokenEstimate < budget.softThreshold) {
      skippedFiles.push({ path: file.path, reason: "over_budget" });
      continue;
    }

    preparedFiles.push({
      path: file.path,
      status: file.status,
      promptText,
      newLines: collectNewLines(hunks),
      removedLines: collectRemovedLines(hunks),
      tokenEstimate,
      ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
    });
    consumed += tokenEstimate;
  }

  return {
    files: preparedFiles,
    skippedFiles,
    tokenEstimate: preparedFiles.reduce((sum, f) => sum + f.tokenEstimate, 0),
  };
}

export function renderDiffForPrompt(diff: PreparedDiff): string {
  const fileBlocks = diff.files.map((file) => file.promptText);
  const sections = [fileBlocks.join("\n\n")];

  if (diff.skippedFiles.length > 0) {
    const lines = diff.skippedFiles.map((skipped) => `${skipped.path} (${skipped.reason})`);
    sections.push(`## Files not shown\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}
