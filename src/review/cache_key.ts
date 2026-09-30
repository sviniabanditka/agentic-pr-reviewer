import { sha256Hex } from "../verdict/verdict.js";

/** Bump when the prompt changes, or stale verdicts outlive the rules that produced them. */
export const PROMPT_VERSION = "v7";

export function cacheKey(diffText: string, model: string, intent = ""): string {
  return `verdict:${sha256Hex([PROMPT_VERSION, model, diffText, intent].join(" "))}`;
}
