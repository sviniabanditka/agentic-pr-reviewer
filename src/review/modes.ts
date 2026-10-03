import type { TSchema } from "typebox";
import { findingsSchema, SummarySchema } from "./finding.js";
import { DATA_GUARD, DO_NOT_REPORT, EVIDENCE_RULES, FINDINGS_OUTPUT } from "./prompt.js";
import { DEFAULT_CHUNKING } from "./chunk.js";

/** What each category means, as the model reads it. Modes pick from this catalog. */
export const CATEGORY_TEXT: Record<string, string> = {
  "SEC-AUTHZ":
    "The change adds or modifies a request path, query, or handler that reads or writes data scoped to a user or tenant, and no authorization or tenant-scope check is applied on that path. This includes checks that were required and are simply missing — absence counts as evidence here.",
  "GUARD-REMOVED":
    "The change deletes or weakens an existing validation, authorization check, error handler, retry, or transaction boundary, and nothing equivalent replaces it. The evidence for this category is typically a removed line.",
  "API-UNDOC":
    "The change alters the observable contract of a public function, endpoint, CLI flag, config key, or exported type (signature, return shape, required-ness, default value, or error behavior) in a way that breaks callers relying on the previous contract, without an accompanying deprecation or migration path.",
  IRREVERSIBLE:
    "The change performs an action that destroys data or state with no recovery path once merged and run — a destructive schema migration (drop / lossy alter), an in-place data rewrite without backup, deletion of files or backups, or a credential/secret committed to source (rotation required). It is NOT: lost cache or skip-list entries, data that can be re-fetched or recomputed, idempotent jobs re-running, or race conditions whose damage is retryable — those are OTHER at most.",
  NICHE: `A comment, commented-out block, or lint/type suppression this diff adds that does not earn a keep. Quote the comment or suppression line. Report deletion — never rewrite the prose into a shorter alibi.

  Meat: narration and banners ("now we", "here we", step labels), commented-out corpses, workaround sermons, and long justifications (\`IMPORTANT\`, \`do not remove\`, \`too risky\`, \`fine for now\`). Also \`eslint-disable\`, \`@ts-ignore\`, \`@ts-expect-error\`, and similar suppressions whose named rule catches real bugs or protects correctness or safety — report the suppression and name the guilty symbol.

  Keep only:
  - Legal or license headers.
  - A constraint forced by an external dependency, platform, vendor, or protocol we cannot reshape — the comment must name that foreign source, and nearby diff lines must make the constraint plausible. Surprises in our own code are not a keep: report the comment and put \`MUST KILL: <symbol>\` in detail (rename, extract, type, or rearchitecture so the behavior is obvious without prose). Do not write the reshape.
  - \`// prettier-ignore\`. Lint suppressions survive only when the named rule is faulty, pedantic, or style-only.
  - Doc comments that state a public API contract.
  - Issue or RFC links that explain a constraint the code cannot express.

  That list is the only keep. If nearby diff lines do not clearly prove a keep, the comment is a finding. You only see the diff: do not invent a foreign gotcha that is not evidenced there. Pre-existing comments on unchanged lines are not in scope.`,
  INTENT:
    'The author\'s claim and the diff disagree. The claim is the "Author\'s claim" section of the message; report INTENT only when that section is present. A gap is one of three shapes: the claim says a path, behaviour or file stays untouched and the diff changes it; the diff changes a contract, migration, config, dependency or behaviour the claim never mentions; the claim describes a change the diff does not contain. Write the claim field as "Intent says <the claim\'s words>; diff shows <what the diff does>". Evidence is the diff line that contradicts the claim ("present" or "removed"); a change the claim promises and the diff lacks uses "absent". Grain is not a gap: "adds width and height to thumbnails" covers the helper that computes them, and a summary that names a responsibility covers every file of it. Report the gap between claim and code, never the wording of the claim.',
  SECRET:
    "A credential, token, private key, password or connection string with a password added to source, config, fixtures or logs. Quote the line; never repeat the secret's value in claim or detail beyond its first four characters.",
  INJECTION:
    "Untrusted input reaches a SQL, shell, template, path, regex, deserialization, or HTML sink without parameterization, escaping or validation on that path.",
  CRYPTO:
    "Weak or misused cryptography: broken algorithms (MD5/SHA-1 for security, ECB, static IVs), hardcoded keys, disabled certificate checks, non-constant-time comparison of secrets, home-made crypto.",
  OTHER:
    "A real defect you are confident about that does not fit the categories above. Report it so it is visible, but understand it will never block a merge on its own.",
};

export type Confirmation = "never" | "blocking";

export interface ModeDef {
  id: string;
  label: string;
  description: string;
  output: "findings" | "summary";
  categories: string[];
  blocking: string[];
  confirmation: Confirmation;
  intro: string;
  confidence: string;
  /** Only meaningful with an author's claim (the PR body). */
  needsIntent?: boolean;
}

const TRIAGE_CONFIDENCE = `## Confidence bar

Apply an asymmetric confidence bar. Be thorough and proactive on anything that looks like a security issue or a real bug in the blocking categories — dig for it, and report it even if you are not 100% certain, as long as the evidence rule above is satisfied. NICHE inverts the minor-point bar: if a keep clause is not proven by nearby diff lines, report the comment. For anything else smaller or more speculative, hold a much higher bar: report it only when you are genuinely certain. When in doubt on a minor point that is not NICHE, prefer not reporting over guessing.`;

export const MODES: Record<string, ModeDef> = {
  "diff-triage": {
    id: "diff-triage",
    label: "Triage",
    description: "Merge-holding defects, comment slop and gaps between the description and the diff. The default.",
    output: "findings",
    categories: ["SEC-AUTHZ", "GUARD-REMOVED", "API-UNDOC", "IRREVERSIBLE", "NICHE", "INTENT", "OTHER"],
    blocking: ["SEC-AUTHZ", "GUARD-REMOVED", "API-UNDOC", "IRREVERSIBLE"],
    confirmation: "blocking",
    intro:
      "You are a senior software engineer reviewing a pull request diff for merge-holding defects and for comment slop that should not land. You are not reviewing naming, tests, formatting, or anything a linter already covers deterministically.",
    confidence: TRIAGE_CONFIDENCE,
  },
  "security-audit": {
    id: "security-audit",
    label: "Security audit",
    description: "Only security: authorization, removed guards, injection, secrets, crypto, irreversible operations. Higher recall.",
    output: "findings",
    categories: ["SEC-AUTHZ", "GUARD-REMOVED", "INJECTION", "SECRET", "CRYPTO", "IRREVERSIBLE", "OTHER"],
    blocking: ["SEC-AUTHZ", "GUARD-REMOVED", "INJECTION", "SECRET", "CRYPTO", "IRREVERSIBLE"],
    confirmation: "blocking",
    intro:
      "You are an application security engineer auditing a pull request diff. Look only for security defects: broken or missing authorization, removed guards, injection, leaked secrets, misused cryptography and irreversible destructive operations. Ignore style, naming, performance and general code quality entirely.",
    confidence: `## Confidence bar

Favour recall. Report a plausible security defect in the blocking categories even when you are not certain, as long as the evidence rule is satisfied; a human will confirm it. Use OTHER only for a real security-relevant defect outside the listed categories.`,
  },
  "intent-check": {
    id: "intent-check",
    label: "Intent check",
    description: "Only whether the PR description matches what the diff does. Cheap; run it before asking for review.",
    output: "findings",
    categories: ["INTENT"],
    blocking: [],
    confirmation: "never",
    needsIntent: true,
    intro:
      "You are reviewing whether a pull request's description matches its diff. Report only gaps between the author's claim and the code; do not review the code's quality.",
    confidence: `## Confidence bar

Report a gap only when the diff clearly contradicts or omits what the claim says. Wording, tone and level of detail are not gaps.`,
  },
  summary: {
    id: "summary",
    label: "Summary",
    description: "Writes a PR title and description from the diff: what changes, risks, how to test.",
    output: "summary",
    categories: [],
    blocking: [],
    confirmation: "never",
    intro:
      "You are writing a pull request description for reviewers from the diff alone. Be concrete and brief; describe behaviour, not files. Do not invent motivation the diff does not show.",
    confidence: "",
  },
  custom: {
    id: "custom",
    label: "Custom",
    description: "Your own categories and instructions on top of the evidence rules.",
    output: "findings",
    categories: ["OTHER"],
    blocking: [],
    confirmation: "blocking",
    intro: "You are a senior software engineer reviewing a pull request diff.",
    confidence: `## Confidence bar

Report what you are confident about and can support with evidence from the diff. Prefer not reporting over guessing.`,
  },
};

export interface CustomCategory {
  id: string;
  description: string;
}

export interface ProfileOptions {
  model?: string | null;
  confirmation?: Confirmation;
  /** Enabled categories; default: all of the mode's. */
  categories?: string[];
  /** Which enabled categories hold a merge; default: the mode's. */
  blocking?: string[];
  budgetTokens?: number;
  maxChunks?: number;
  intent?: "pr-body" | "none";
  /** Appended to the system prompt; written by the profile's owner. */
  instructions?: string;
  /** custom mode only */
  customCategories?: CustomCategory[];
}

/** A profile turned into exactly what one review runs with. */
export interface ResolvedProfile {
  mode: ModeDef;
  categories: { id: string; text: string }[];
  blocking: string[];
  confirmation: Confirmation;
  budgetTokens: number;
  maxChunks: number;
  intent: "pr-body" | "none";
  instructions: string;
  model: string | null;
}

export function resolveProfile(modeId: string, opts: ProfileOptions): ResolvedProfile {
  const mode = MODES[modeId] ?? MODES["diff-triage"]!;
  const catalog =
    mode.id === "custom"
      ? [...(opts.customCategories ?? []).map((c) => ({ id: c.id.toUpperCase(), text: c.description })), { id: "OTHER", text: CATEGORY_TEXT.OTHER! }]
      : mode.categories.map((id) => ({ id, text: CATEGORY_TEXT[id] ?? id }));
  const enabled = opts.categories?.length ? catalog.filter((c) => opts.categories!.includes(c.id)) : catalog;
  const ids = enabled.map((c) => c.id);
  return {
    mode,
    categories: enabled,
    blocking: (opts.blocking ?? mode.blocking).filter((b) => ids.includes(b)),
    confirmation: opts.confirmation ?? mode.confirmation,
    budgetTokens: clamp(opts.budgetTokens ?? DEFAULT_CHUNKING.budgetTokens, 4_000, 150_000),
    maxChunks: clamp(opts.maxChunks ?? DEFAULT_CHUNKING.maxChunks, 1, 20),
    intent: opts.intent ?? "pr-body",
    instructions: (opts.instructions ?? "").trim(),
    model: opts.model ?? null,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

export function systemPrompt(p: ResolvedProfile): string {
  const extra = p.instructions ? `## Additional instructions from the reviewer\n\n${p.instructions}` : "";
  if (p.mode.output === "summary") {
    return [p.mode.intro, extra, "## Output\n\nAnswer with the structured output only.", DATA_GUARD].filter(Boolean).join("\n\n");
  }
  const blocking = p.blocking;
  const nonBlocking = p.categories.map((c) => c.id).filter((c) => !blocking.includes(c));
  const lead =
    blocking.length === 0
      ? `Every finding you report must carry exactly one of these ${p.categories.length} categories. None of them is blocking: findings are visible, never grounds to hold a merge.`
      : `Every finding you report must carry exactly one of these ${p.categories.length} categories. ${list(blocking)} ${blocking.length === 1 ? "is" : "are"} blocking — a human should seriously consider holding the merge.${nonBlocking.length ? ` ${list(nonBlocking)} ${nonBlocking.length === 1 ? "is" : "are"} non-blocking: visible, never grounds to hold a merge.` : ""}`;
  const categories = `## Categories\n\n${lead}\n\n${p.categories.map((c) => `- ${c.id}: ${c.text}`).join("\n")}`;
  return [p.mode.intro, categories, EVIDENCE_RULES, p.mode.confidence, DO_NOT_REPORT, extra, `${FINDINGS_OUTPUT}\n\n${DATA_GUARD}`].filter(Boolean).join("\n\n");
}

function list(xs: string[]): string {
  return xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

export function outputSchema(p: ResolvedProfile): TSchema {
  return p.mode.output === "summary" ? SummarySchema : findingsSchema(p.categories.map((c) => c.id));
}

/** Built-in profiles every user starts with. */
export const DEFAULT_PROFILES: { name: string; mode: string; options: ProfileOptions; isDefault?: boolean }[] = [
  { name: "Triage", mode: "diff-triage", options: {}, isDefault: true },
  { name: "Security audit", mode: "security-audit", options: {} },
  { name: "Intent check", mode: "intent-check", options: {} },
  { name: "Summary", mode: "summary", options: {} },
];
