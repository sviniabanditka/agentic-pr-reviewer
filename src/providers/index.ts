import { callClaude, probeLimits, type ClaudeLimits, type ClaudeRequest, type ClaudeSettings, type RunResult } from "../review/claude.js";
import { callAnthropic, probeAnthropic } from "./anthropic.js";

/**
 * A way to reach a model: Claude Code on the user's subscription (`claude-cli`) or the
 * Messages API with an API key (`anthropic-api`). A credential names its provider.
 */
export interface Provider {
  id: string;
  label: string;
  complete(req: ClaudeRequest, settings: ClaudeSettings): Promise<RunResult>;
  probe(settings: ClaudeSettings): Promise<ClaudeLimits | undefined>;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** Context window in tokens; bounds the per-run diff budget. */
  context: number;
}

/** Known models; the settings page decides which ones the pickers offer. */
export const MODEL_CATALOG: ModelInfo[] = [
  { id: "sonnet", label: "Sonnet (latest)", context: 200_000 },
  { id: "opus", label: "Opus (latest)", context: 200_000 },
  { id: "haiku", label: "Haiku (latest)", context: 200_000 },
  { id: "claude-fable-5-1", label: "Fable 5.1", context: 200_000 },
  { id: "claude-opus-5-5", label: "Opus 5.5", context: 200_000 },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", context: 200_000 },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", context: 200_000 },
];

export const PROVIDERS: Record<string, Provider> = {
  "claude-cli": { id: "claude-cli", label: "Claude Code (subscription)", complete: callClaude, probe: probeLimits },
  "anthropic-api": { id: "anthropic-api", label: "Anthropic API (API key)", complete: (req, s) => callAnthropic(req, s), probe: (s) => probeAnthropic(s) },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

const providerOf = (s: ClaudeSettings): Provider => PROVIDERS[s.provider ?? "claude-cli"] ?? PROVIDERS["claude-cli"]!;
export const complete = (req: ClaudeRequest, s: ClaudeSettings): Promise<RunResult> => providerOf(s).complete(req, s);
export const probe = (s: ClaudeSettings): Promise<ClaudeLimits | undefined> => providerOf(s).probe(s);
