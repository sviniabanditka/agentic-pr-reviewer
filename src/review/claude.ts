import { Value } from "typebox/value";
import { SubmitFindingsSchema, type Finding } from "./finding.js";
import { SYSTEM_PROMPT } from "./prompt.js";

export type ReviewOutcome = "findings" | "no_findings" | "didnt_look" | "error";

export interface TokenUsage {
  input: number;
  output: number;
}

/** Subscription usage as Claude Code reports it; utilization is 0..1, resetsAt in epoch ms. */
export interface ClaudeLimits {
  fiveHour?: { utilization: number; resetsAt: number };
  sevenDay?: { utilization: number; resetsAt: number };
  status?: string;
  checkedAt: number;
}

export interface RunResult {
  outcome: ReviewOutcome;
  /** Non-empty only when outcome === "findings". */
  findings: Finding[];
  latencyMs: number;
  usage?: TokenUsage;
  /** What the run would cost at API prices; informational on a subscription. */
  costUsd?: number;
  errorMessage?: string;
  limits?: ClaudeLimits;
}

export interface ClaudeSettings {
  oauthToken: string;
  model: string;
  /** Per-account state dir, so two accounts never share Claude Code's local state. */
  configDir: string;
}

const SCHEMA = JSON.stringify(SubmitFindingsSchema);
const TIMEOUT_MS = 300_000;

/**
 * One review run through the Claude Code CLI. `--tools ""` leaves the model
 * nothing but the diff text: untrusted PR content cannot make it read files or
 * reach the network. The env is built from scratch for the same reason — the
 * GitHub tokens of the daemon never reach this process.
 */
export async function callClaude(userMessage: string, settings: ClaudeSettings): Promise<RunResult> {
  return runClaude(
    ["--system-prompt", SYSTEM_PROMPT, "--json-schema", SCHEMA, "--model", settings.model],
    userMessage,
    settings,
  );
}

/** The cheapest call that makes Claude Code report the subscription's usage windows. */
export async function probeLimits(settings: ClaudeSettings): Promise<ClaudeLimits | undefined> {
  const run = await runClaude(["--model", "haiku"], "Reply with: ok", settings);
  if (run.limits === undefined && run.errorMessage !== undefined) throw new Error(run.errorMessage);
  return run.limits;
}

async function runClaude(args: string[], stdin: string, settings: ClaudeSettings): Promise<RunResult> {
  const startedAt = Date.now();
  const proc = Bun.spawn(
    ["claude", "-p", "--tools", "", "--output-format", "stream-json", "--verbose", "--no-session-persistence", ...args],
    {
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      timeout: TIMEOUT_MS,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        CLAUDE_CONFIG_DIR: settings.configDir,
        CLAUDE_CODE_OAUTH_TOKEN: settings.oauthToken,
        DISABLE_AUTOUPDATER: "1",
      },
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const latencyMs = Date.now() - startedAt;

  if (proc.signalCode !== null && stdout.trim() === "") {
    return { outcome: "error", findings: [], latencyMs, errorMessage: `claude killed (${proc.signalCode}), timeout ${TIMEOUT_MS / 1000}s` };
  }
  const parsed = parseClaudeStream(stdout);
  if (parsed.outcome === "error" && exitCode !== 0 && stderr.trim() !== "") {
    parsed.errorMessage = `${parsed.errorMessage ?? ""} ${stderr.trim().slice(0, 300)}`.trim();
  }
  return { ...parsed, latencyMs };
}

/** Reads `--output-format stream-json` output: the result event plus the last rate-limit event. */
export function parseClaudeStream(stdout: string): Omit<RunResult, "latencyMs"> {
  let result: Record<string, unknown> | undefined;
  let limits: ClaudeLimits | undefined;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "result") result = event;
    if (event.type === "rate_limit_event") limits = readLimits(event.rate_limit_info) ?? limits;
  }
  const meta = limits !== undefined ? { limits } : {};
  if (result === undefined) {
    return { outcome: "error", findings: [], errorMessage: `no result from claude: ${stdout.slice(0, 200)}`, ...meta };
  }
  return { ...parseClaudeResult(result), ...meta };
}

/** The result event: model output is parsed, never trusted. */
function parseClaudeResult(data: Record<string, unknown>): Omit<RunResult, "latencyMs"> {
  const usage = readUsage(data.usage);
  const cost = typeof data.total_cost_usd === "number" ? { costUsd: data.total_cost_usd } : {};
  const meta = { ...(usage !== undefined ? { usage } : {}), ...cost };

  if (data.is_error === true) {
    return { outcome: "error", findings: [], errorMessage: String(data.result ?? "claude error"), ...meta };
  }
  if (!Value.Check(SubmitFindingsSchema, data.structured_output)) {
    return { outcome: "didnt_look", findings: [], errorMessage: "no structured output matching the schema", ...meta };
  }
  const { findings } = data.structured_output;
  return { outcome: findings.length > 0 ? "findings" : "no_findings", findings, ...meta };
}

function readUsage(raw: unknown): TokenUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const n = (key: string): number => (typeof u[key] === "number" ? (u[key] as number) : 0);
  return {
    input: n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens"),
    output: n("output_tokens"),
  };
}

function readLimits(raw: unknown): ClaudeLimits | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const info = raw as { status?: unknown; unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: unknown }> };
  const windowOf = (key: string): { utilization: number; resetsAt: number } | undefined => {
    const w = info.unifiedWindows?.[key];
    return typeof w?.utilization === "number" && typeof w.resetsAt === "number"
      ? { utilization: w.utilization, resetsAt: w.resetsAt * 1000 }
      : undefined;
  };
  const fiveHour = windowOf("five_hour");
  const sevenDay = windowOf("seven_day");
  return {
    ...(fiveHour !== undefined ? { fiveHour } : {}),
    ...(sevenDay !== undefined ? { sevenDay } : {}),
    ...(typeof info.status === "string" ? { status: info.status } : {}),
    checkedAt: Date.now(),
  };
}
