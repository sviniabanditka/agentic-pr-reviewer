import { estimateTokens, parseHunks, prepareDiff, renderHunk, type PreparedDiff, type RawPatchFile } from "./diff.js";

export interface ChunkOptions {
  /** Input tokens per model run for the diff itself. */
  budgetTokens: number;
  /** Runs per review at most; what does not fit is listed as not reviewed. */
  maxChunks: number;
}

export const DEFAULT_CHUNKING: ChunkOptions = { budgetTokens: 32_000, maxChunks: 6 };

interface Part {
  path: string;
  text: string;
  tokens: number;
  /** Position in the PR: file order, then part order. */
  seq: number;
}

export interface Chunk {
  index: number;
  paths: string[];
  text: string;
  tokens: number;
}

export interface ChunkedDiff {
  /** Every reviewable file, for verifying quoted evidence wherever it comes from. */
  full: PreparedDiff;
  chunks: Chunk[];
  skippedFiles: { path: string; reason: string }[];
  tokenEstimate: number;
}

/**
 * Splits a PR into model-sized chunks instead of dropping the tail. Files go into the
 * fullest chunk they fit (largest first); a file bigger than the budget is split by
 * hunks, each part repeating the file header.
 */
export function chunkDiff(files: RawPatchFile[], opts: ChunkOptions = DEFAULT_CHUNKING): ChunkedDiff {
  const full = prepareDiff(files, { maxTokens: Number.POSITIVE_INFINITY, softThreshold: 0, hardThreshold: 0 });
  const raw = new Map(files.map((f) => [f.path, f]));
  const parts: Part[] = [];
  for (const file of full.files) {
    if (file.tokenEstimate <= opts.budgetTokens) {
      parts.push({ path: file.path, text: file.promptText, tokens: file.tokenEstimate, seq: parts.length });
      continue;
    }
    const hunks = parseHunks(raw.get(file.path)?.patch ?? "").map(renderHunk);
    const groups: string[][] = [[]];
    let size = 0;
    for (const hunk of hunks) {
      const t = estimateTokens(hunk);
      if (size + t > opts.budgetTokens && groups[groups.length - 1]!.length > 0) {
        groups.push([]);
        size = 0;
      }
      groups[groups.length - 1]!.push(hunk);
      size += t;
    }
    groups.forEach((g, i) => {
      const text = `## File: '${file.path}' (part ${i + 1} of ${groups.length})\n\n${g.join("\n")}`;
      parts.push({ path: file.path, text, tokens: estimateTokens(text), seq: parts.length });
    });
  }

  const bins: Part[][] = [];
  const sizes: number[] = [];
  const overflow = new Set<string>();
  for (const part of [...parts].sort((a, b) => b.tokens - a.tokens)) {
    let best = -1;
    for (let i = 0; i < bins.length; i++) {
      if (sizes[i]! + part.tokens <= opts.budgetTokens && (best === -1 || sizes[i]! > sizes[best]!)) best = i;
    }
    if (best === -1 && bins.length < opts.maxChunks) {
      bins.push([]);
      sizes.push(0);
      best = bins.length - 1;
    }
    if (best === -1) {
      overflow.add(part.path);
      continue;
    }
    bins[best]!.push(part);
    sizes[best]! += part.tokens;
  }

  // Keep the PR's own order inside each chunk; it reads better than size order.
  const chunks = bins.map((bin, index) => {
    const sorted = [...bin].sort((a, b) => a.seq - b.seq);
    return { index, paths: [...new Set(sorted.map((p) => p.path))], text: sorted.map((p) => p.text).join("\n\n"), tokens: sizes[index]! };
  });
  const skippedFiles = [...full.skippedFiles, ...[...overflow].map((path) => ({ path, reason: "over_budget" }))];
  return { full, chunks, skippedFiles, tokenEstimate: chunks.reduce((t, c) => t + c.tokens, 0) };
}

/** The diff section of one run's prompt: this chunk, what the others hold, what nobody reviews. */
export function renderChunk(diff: ChunkedDiff, chunk: Chunk): string {
  const sections = [chunk.text];
  if (diff.chunks.length > 1) {
    const elsewhere = diff.chunks.filter((c) => c.index !== chunk.index).flatMap((c) => c.paths).filter((p) => !chunk.paths.includes(p));
    sections.unshift(`(This is part ${chunk.index + 1} of ${diff.chunks.length} of the pull request. Review only the files shown here.)`);
    if (elsewhere.length) sections.push(`## Reviewed in other parts (not shown here)\n${[...new Set(elsewhere)].join("\n")}`);
  }
  if (diff.skippedFiles.length) sections.push(`## Files not shown\n${diff.skippedFiles.map((s) => `${s.path} (${s.reason})`).join("\n")}`);
  return sections.join("\n\n");
}

/** Everything the review covers, rendered once: the cache key input. */
export function renderAll(diff: ChunkedDiff): string {
  return diff.chunks.map((c) => c.text).join("\n\n") + (diff.skippedFiles.length ? `\n\n## Files not shown\n${diff.skippedFiles.map((s) => `${s.path} (${s.reason})`).join("\n")}` : "");
}
