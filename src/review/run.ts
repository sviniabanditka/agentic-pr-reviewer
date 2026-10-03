import { buildUserMessage } from "./prompt.js";
import { renderChunk, type ChunkedDiff } from "./chunk.js";
import { verifyFindings, type VerifiedFinding } from "./verify.js";
import { outputSchema, systemPrompt, type ResolvedProfile } from "./modes.js";
import { checkVerdict, findingMarker, isBlockingCandidate, type CheckVerdict } from "../verdict/verdict.js";
import type { ClaudeRequest, ReviewOutcome, RunResult } from "./claude.js";
import type { PrContext } from "./context.js";
import type { PrSummary } from "./finding.js";

export interface ReviewResult {
  outcome: ReviewOutcome;
  confirmationOutcome?: ReviewOutcome;
  verdict: CheckVerdict;
  findings: VerifiedFinding[];
  confirmedMarkers: string[];
  skippedFiles: { path: string; reason: string }[];
  usage: { runs: number; tokensIn: number; tokensOut: number; costUsd: number; latencyModelMs: number };
  errorMessage?: string;
  /** Since v2.1: what produced the result. Older stored results lack these. */
  mode?: string;
  blocking?: string[];
  chunks?: number;
  summary?: PrSummary;
  /** Incremental reviews: what the review compared against and what got fixed since. */
  incremental?: { baseJobId: number; baseSha: string; fixed: VerifiedFinding[] };
}

export interface ReviewInput {
  diff: ChunkedDiff;
  context: PrContext;
  intent?: string;
  profile: ResolvedProfile;
}

export interface RunMeta {
  purpose: "review" | "confirm";
  chunk: number;
  chunks: number;
}

export interface ReviewDeps {
  call: (req: ClaudeRequest, meta: RunMeta) => Promise<RunResult>;
  log: (msg: string) => void;
  /** Tells the panel which run is going on. */
  stage?: (stage: "review" | "confirm") => void;
  /** Waits between attempts of one run; tests pass zeroes. */
  retryDelaysMs?: number[];
  /** Aborts between and during model calls when the review is cancelled. */
  signal?: AbortSignal;
}

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

const INCONCLUSIVE: Partial<Record<ReviewOutcome, true>> = { didnt_look: true, error: true };
const DEFAULT_RETRY_DELAYS_MS = [10_000, 30_000];

export function isInconclusive(outcome: ReviewOutcome): boolean {
  return INCONCLUSIVE[outcome] === true;
}

/**
 * Runs a profile over a chunked diff: one model run per chunk, evidence checked against
 * the whole diff, findings merged by marker. When the profile asks for confirmation, the
 * chunks that produced blocking candidates run again and only reproduced markers count.
 */
export async function review(input: ReviewInput, deps: ReviewDeps): Promise<ReviewResult> {
  const { diff, profile } = input;
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const system = systemPrompt(profile);
  const schema = outputSchema(profile);
  const intent = profile.intent === "pr-body" ? input.intent : undefined;
  const runs: RunResult[] = [];
  const n = diff.chunks.length;
  const base = { skippedFiles: diff.skippedFiles, mode: profile.mode.id, blocking: profile.blocking, chunks: n };

  const runChunk = async (purpose: RunMeta["purpose"], chunk: number): Promise<RunResult> => {
    const req = { system, user: buildUserMessage(input.context, renderChunk(diff, diff.chunks[chunk]!), intent), schema };
    const label = n > 1 ? `${purpose} ${chunk + 1}/${n}` : purpose;
    for (let attempt = 0; ; attempt++) {
      if (deps.signal?.aborted) throw new Cancelled();
      deps.log(`${label}: model run ${attempt + 1}`);
      const result = await deps.call(req, { purpose, chunk, chunks: n });
      if (deps.signal?.aborted) throw new Cancelled();
      runs.push(result);
      if (!isInconclusive(result.outcome) || attempt >= delays.length) return result;
      deps.log(`${label}: ${result.outcome} (${result.errorMessage ?? "-"}), retry in ${delays[attempt]! / 1000}s`);
      await Bun.sleep(delays[attempt]!);
    }
  };

  if (profile.mode.needsIntent && !intent?.trim()) {
    return { ...base, outcome: "no_findings", verdict: { conclusion: "success", title: "no description to check against" }, findings: [], confirmedMarkers: [], usage: sumUsage(runs) };
  }

  deps.stage?.("review");
  const first: RunResult[] = [];
  for (let i = 0; i < n; i++) {
    const result = await runChunk("review", i);
    first.push(result);
    if (isInconclusive(result.outcome)) {
      return { ...base, outcome: result.outcome, verdict: checkVerdict(result.outcome, undefined, 0), findings: [], confirmedMarkers: [], usage: sumUsage(runs), ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}) };
    }
  }

  if (profile.mode.output === "summary") {
    return { ...base, outcome: "no_findings", verdict: { conclusion: "success", title: "summary ready" }, findings: [], confirmedMarkers: [], usage: sumUsage(runs), summary: mergeSummaries(first.map((r) => r.output as PrSummary)) };
  }

  const findings = dedupe(first.flatMap((r) => verifyFindings(r.findings, diff.full)));
  const candidates = findings.filter((f) => isBlockingCandidate(f, profile.blocking));
  const outcome: ReviewOutcome = findings.length > 0 ? "findings" : "no_findings";

  if (candidates.length === 0 || profile.confirmation === "never") {
    const confirmed = profile.confirmation === "never" ? candidates.map(findingMarker) : [];
    return { ...base, outcome, verdict: checkVerdict(outcome, undefined, confirmed.length), findings, confirmedMarkers: confirmed, usage: sumUsage(runs) };
  }

  // A blocking finding holds a merge, so one run is not trusted: a second, independent
  // run of the chunks that raised it must reproduce the same marker.
  deps.log(`${candidates.length} blocking candidate(s), confirmation run`);
  deps.stage?.("confirm");
  const chunksToConfirm = diff.chunks.filter((c) => candidates.some((f) => c.paths.includes(f.file))).map((c) => c.index);
  const reproduced = new Set<string>();
  let confirmationOutcome: ReviewOutcome = "no_findings";
  for (const i of chunksToConfirm.length ? chunksToConfirm : [0]) {
    const result = await runChunk("confirm", i);
    if (isInconclusive(result.outcome)) {
      confirmationOutcome = result.outcome;
      break;
    }
    if (result.outcome === "findings") confirmationOutcome = "findings";
    verifyFindings(result.findings, diff.full).filter((f) => isBlockingCandidate(f, profile.blocking)).forEach((f) => reproduced.add(findingMarker(f)));
  }
  const confirmed = candidates.filter((f) => reproduced.has(findingMarker(f)));

  return {
    ...base,
    outcome,
    confirmationOutcome,
    verdict: checkVerdict(outcome, confirmationOutcome, confirmed.length),
    findings,
    confirmedMarkers: confirmed.map(findingMarker),
    usage: sumUsage(runs),
  };
}

function dedupe(findings: VerifiedFinding[]): VerifiedFinding[] {
  const seen = new Map<string, VerifiedFinding>();
  for (const f of findings) if (!seen.has(findingMarker(f))) seen.set(findingMarker(f), f);
  return [...seen.values()];
}

function mergeSummaries(parts: PrSummary[]): PrSummary {
  if (parts.length === 1) return parts[0]!;
  return {
    title: parts[0]!.title,
    summary: parts.map((p) => p.summary).join(" "),
    changes: parts.flatMap((p) => p.changes),
    risks: parts.flatMap((p) => p.risks),
    testing: parts.flatMap((p) => p.testing),
  };
}

function sumUsage(runs: RunResult[]): ReviewResult["usage"] {
  return {
    runs: runs.length,
    tokensIn: runs.reduce((t, r) => t + (r.usage?.input ?? 0), 0),
    tokensOut: runs.reduce((t, r) => t + (r.usage?.output ?? 0), 0),
    costUsd: runs.reduce((t, r) => t + (r.costUsd ?? 0), 0),
    latencyModelMs: runs.reduce((t, r) => t + r.latencyMs, 0),
  };
}
