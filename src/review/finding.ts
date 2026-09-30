import { Type, type Static } from "typebox";

export const BLOCKING_CATEGORIES = [
  "SEC-AUTHZ",
  "GUARD-REMOVED",
  "API-UNDOC",
  "IRREVERSIBLE",
] as const;

// Literals listed explicitly: mapping over a const array widens away literal types
// and collapses Static<> fields to never (typebox + TS7).
const FindingSchema = Type.Object({
  category: Type.Union([
    Type.Literal("SEC-AUTHZ"),
    Type.Literal("GUARD-REMOVED"),
    Type.Literal("API-UNDOC"),
    Type.Literal("IRREVERSIBLE"),
    Type.Literal("NICHE"),
    Type.Literal("INTENT"),
    Type.Literal("OTHER"),
  ]),
  file: Type.String({ description: "Path of the file as it appears in the diff (new side)" }),
  line_start: Type.Number({ description: "First line on the new side the finding refers to" }),
  line_end: Type.Number({ description: "Last line on the new side the finding refers to" }),
  evidence: Type.String({
    description:
      'Verbatim line copied from the diff that proves the claim. Empty string when evidence_kind is "absent"',
  }),
  evidence_kind: Type.Union([
    Type.Literal("present"),
    Type.Literal("absent"),
    Type.Literal("removed"),
  ]),
  claim: Type.String({ description: "One-sentence assertion headline, Devin style" }),
  detail: Type.String({ description: "Explanation: why this matters and what to do" }),
});

export type Finding = Static<typeof FindingSchema>;

export const SubmitFindingsSchema = Type.Object({
  findings: Type.Array(FindingSchema),
});
