import { buildUserMessage } from "./prompt.js";
import { renderDiffForPrompt, type PreparedDiff } from "./diff.js";
import { verifyFindings, type VerifiedFinding } from "./verify.js";
import { checkVerdict, findingMarker, isBlockingCandidate, type CheckVerdict } from "../verdict/verdict.js";
import type { PrContext } from "./context.js";
import type { ReviewOutcome, RunResult } from "./claude.js";

export interface ReviewResult {
  outcome: ReviewOutcome;
  confirmationOutcome?: ReviewOutcome;
  verdict: CheckVerdict;
  findings: VerifiedFinding[];
  confirmedMarkers: string[];
  skippedFiles: { path: string; reason: string }[];
  usage: { runs: number; tokensIn: number; tokensOut: number; costUsd: number; latencyModelMs: number };
  errorMessage?: string;
}

export interface ReviewInput {
  diff: PreparedDiff;
  context: PrContext;
  intent?: string;
}

export interface ReviewDeps {
  call: (userMessage: string) => Promise<RunResult>;
  log: (msg: string) => void;
  /** Tells the panel which run is going on. */
  stage?: (stage: "review" | "confirm") => void;
  /** Waits between attempts of one run; tests pass zeroes. */
  retryDelaysMs?: number[];
}

const INCONCLUSIVE: Partial<Record<ReviewOutcome, true>> = { didnt_look: true, error: true };
const DEFAULT_RETRY_DELAYS_MS = [10_000, 30_000];

export function isInconclusive(outcome: ReviewOutcome): boolean {
  return INCONCLUSIVE[outcome] === true;
}

export async function review(input: ReviewInput, deps: ReviewDeps): Promise<ReviewResult> {
  const message = buildUserMessage(input.context, renderDiffForPrompt(input.diff), input.intent);
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const runs: RunResult[] = [];

  const runWithRetries = async (name: string): Promise<RunResult> => {
    for (let attempt = 0; ; attempt++) {
      deps.log(`${name}: model run ${attempt + 1}`);
      const result = await deps.call(message);
      runs.push(result);
      if (!isInconclusive(result.outcome) || attempt >= delays.length) return result;
      deps.log(`${name}: ${result.outcome} (${result.errorMessage ?? "-"}), retry in ${delays[attempt]! / 1000}s`);
      await Bun.sleep(delays[attempt]!);
    }
  };

  const base = { skippedFiles: input.diff.skippedFiles };
  deps.stage?.("review");
  const first = await runWithRetries("review");
  const findings = verifyFindings(first.findings, input.diff);
  const candidates = findings.filter(isBlockingCandidate);

  if (isInconclusive(first.outcome) || candidates.length === 0) {
    return {
      ...base,
      outcome: first.outcome,
      verdict: checkVerdict(first.outcome, undefined, 0),
      findings,
      confirmedMarkers: [],
      usage: sumUsage(runs),
      ...(first.errorMessage !== undefined ? { errorMessage: first.errorMessage } : {}),
    };
  }

  // A blocking finding holds a merge, so one run is not trusted: a second,
  // independent run must reproduce the same marker.
  deps.log(`${candidates.length} blocking candidate(s), confirmation run`);
  deps.stage?.("confirm");
  const confirmation = await runWithRetries("confirm");
  const confirmedMarkers = new Set(
    verifyFindings(confirmation.findings, input.diff).filter(isBlockingCandidate).map(findingMarker),
  );
  const confirmed = candidates.filter((f) => confirmedMarkers.has(findingMarker(f)));

  return {
    ...base,
    outcome: first.outcome,
    confirmationOutcome: confirmation.outcome,
    verdict: checkVerdict(first.outcome, confirmation.outcome, confirmed.length),
    findings,
    confirmedMarkers: confirmed.map(findingMarker),
    usage: sumUsage(runs),
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
