import { checkOutput, type ClaudeLimits, type ClaudeRequest, type ClaudeSettings, type RunResult } from "../review/claude.js";

const API = process.env.ANTHROPIC_API_URL ?? "https://api.anthropic.com";
const TIMEOUT_MS = 300_000;
const MAX_OUTPUT = 16_000;

/** Claude Code accepts aliases; the Messages API wants model ids. */
const ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  haiku: "claude-haiku-4-5-20251001",
  fable: "claude-fable-5-1",
};

export const apiModel = (model: string): string => ALIASES[model] ?? model;

function headers(key: string): Record<string, string> {
  return { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
}

/**
 * One review run on the Messages API with an API key. Same contract as the CLI path: no
 * tools the model can use on its own — the only tool is the forced `submit` whose input is
 * the structured output, checked against the schema like any model output.
 */
export async function callAnthropic(req: ClaudeRequest, settings: ClaudeSettings, base = API): Promise<RunResult> {
  const startedAt = Date.now();
  const signal = settings.signal ? AbortSignal.any([settings.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: headers(settings.oauthToken),
      signal,
      body: JSON.stringify({
        model: apiModel(settings.model),
        max_tokens: MAX_OUTPUT,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        tools: [{ name: "submit", description: "Submit the review result.", input_schema: req.schema }],
        tool_choice: { type: "tool", name: "submit" },
      }),
    });
  } catch (error) {
    return { outcome: "error", findings: [], latencyMs: Date.now() - startedAt, errorMessage: error instanceof Error ? error.message : String(error) };
  }
  const body = (await res.json().catch(() => ({}))) as {
    content?: { type: string; name?: string; input?: unknown }[];
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    error?: { message?: string };
    stop_reason?: string;
  };
  const latencyMs = Date.now() - startedAt;
  if (!res.ok) return { outcome: "error", findings: [], latencyMs, errorMessage: `Anthropic API ${res.status}: ${body.error?.message ?? "request failed"}` };
  const u = body.usage ?? {};
  const usage = { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 };
  const output = body.content?.find((c) => c.type === "tool_use" && c.name === "submit")?.input;
  return checkOutput({ outcome: "no_findings", findings: [], output, latencyMs, usage, ...(body.stop_reason === "max_tokens" ? { errorMessage: "output cut at max_tokens" } : {}) }, req.schema);
}

/** An API key has no subscription windows; the probe only proves the key works. */
export async function probeAnthropic(settings: ClaudeSettings, base = API): Promise<ClaudeLimits | undefined> {
  const res = await fetch(`${base}/v1/models?limit=1`, { headers: headers(settings.oauthToken), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${res.status === 401 ? "invalid API key" : "request failed"}`);
  return undefined;
}
