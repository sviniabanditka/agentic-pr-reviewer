import { sha256Hex } from "../verdict/verdict.js";

/** Bump when the prompt changes, or stale verdicts outlive the rules that produced them. */
export const PROMPT_VERSION = "v8";

/** The profile snapshot is part of the key: a different mode or category set is a different review. */
export function cacheKey(diffText: string, model: string, intent = "", profile = ""): string {
  return `verdict:${sha256Hex([PROMPT_VERSION, model, profile, diffText, intent].join(" "))}`;
}
