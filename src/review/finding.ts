import { Type, type TSchema } from "typebox";

/** The v1 blocking set; the default for the triage mode. */
export const BLOCKING_CATEGORIES = ["SEC-AUTHZ", "GUARD-REMOVED", "API-UNDOC", "IRREVERSIBLE"] as const;
export const TRIAGE_CATEGORIES = [...BLOCKING_CATEGORIES, "NICHE", "INTENT", "OTHER"];

export interface Finding {
  category: string;
  file: string;
  line_start: number;
  line_end: number;
  evidence: string;
  evidence_kind: "present" | "absent" | "removed";
  claim: string;
  detail: string;
}

/** The structured-output schema for a findings mode, with its own category list. */
export function findingsSchema(categories: string[]): TSchema {
  return Type.Object({
    findings: Type.Array(
      Type.Object({
        category: Type.Union(categories.map((c) => Type.Literal(c))),
        file: Type.String({ description: "Path of the file as it appears in the diff (new side)" }),
        line_start: Type.Number({ description: "First line on the new side the finding refers to" }),
        line_end: Type.Number({ description: "Last line on the new side the finding refers to" }),
        evidence: Type.String({
          description: 'Verbatim line copied from the diff that proves the claim. Empty string when evidence_kind is "absent"',
        }),
        evidence_kind: Type.Union([Type.Literal("present"), Type.Literal("absent"), Type.Literal("removed")]),
        claim: Type.String({ description: "One-sentence assertion headline, Devin style" }),
        detail: Type.String({ description: "Explanation: why this matters and what to do" }),
      }),
    ),
  });
}

export const SubmitFindingsSchema = findingsSchema(TRIAGE_CATEGORIES);

export interface PrSummary {
  title: string;
  summary: string;
  changes: string[];
  risks: string[];
  testing: string[];
}

export const SummarySchema = Type.Object({
  title: Type.String({ description: "A pull request title, imperative mood, under 72 characters" }),
  summary: Type.String({ description: "Two to five sentences: what changes and why, for a reviewer" }),
  changes: Type.Array(Type.String(), { description: "The notable changes, one line each" }),
  risks: Type.Array(Type.String(), { description: "What could break or needs a careful look; empty if nothing" }),
  testing: Type.Array(Type.String(), { description: "How to verify the change; empty if the diff gives no basis" }),
});
