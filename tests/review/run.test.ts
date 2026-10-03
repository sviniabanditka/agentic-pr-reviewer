import { describe, expect, it } from "bun:test";
import { review } from "../../src/review/run.js";
import { chunkDiff } from "../../src/review/chunk.js";
import { resolveProfile } from "../../src/review/modes.js";
import type { ClaudeRequest, RunResult } from "../../src/review/claude.js";
import type { Finding } from "../../src/review/finding.js";

const patch = "@@ -1,2 +1,2 @@\n-router.get(\"/o/:id\", requireAuth, handler);\n+router.get(\"/o/:id\", handler);\n export default router;";
const diff = chunkDiff([{ path: "src/orders.ts", status: "modified", additions: 1, deletions: 1, patch }]);
const context = { repo: "o/r", number: 1, title: "t", headSha: "h", baseSha: "b", branch: "x" };
const triage = resolveProfile("diff-triage", {});

const guardRemoved: Finding = {
  category: "GUARD-REMOVED", file: "src/orders.ts", line_start: 1, line_end: 1,
  evidence: 'router.get("/o/:id", requireAuth, handler);', evidence_kind: "removed", claim: "requireAuth removed", detail: "d",
};
const niche: Finding = { ...guardRemoved, category: "NICHE", evidence: "export default router;", evidence_kind: "present" };

function run(outcome: RunResult["outcome"], findings: Finding[] = [], output?: unknown): RunResult {
  return { outcome, findings, latencyMs: 1, usage: { input: 10, output: 1 }, ...(output ? { output } : {}) };
}

function scripted(results: RunResult[]) {
  const reqs: ClaudeRequest[] = [];
  let i = 0;
  return { call: async (req: ClaudeRequest) => (reqs.push(req), results[i++] ?? run("error")), calls: () => i, reqs };
}

const deps = (call: (req: ClaudeRequest) => Promise<RunResult>) => ({ call, log: () => {}, retryDelaysMs: [0, 0] });

describe("review", () => {
  it("non-blocking findings need one run", async () => {
    const s = scripted([run("findings", [niche])]);
    const r = await review({ diff, context, profile: triage }, deps(s.call));
    expect(s.calls()).toBe(1);
    expect(r.verdict.conclusion).toBe("success");
    expect(r.mode).toBe("diff-triage");
  });

  it("a blocking finding reproduced by the second run is confirmed", async () => {
    const s = scripted([run("findings", [guardRemoved]), run("findings", [guardRemoved])]);
    const r = await review({ diff, context, profile: triage }, deps(s.call));
    expect(s.calls()).toBe(2);
    expect(r.confirmedMarkers).toHaveLength(1);
    expect(r.verdict.conclusion).toBe("action_required");
    expect(r.usage.runs).toBe(2);
  });

  it("a blocking finding the second run does not reproduce stays unconfirmed", async () => {
    const s = scripted([run("findings", [guardRemoved]), run("no_findings")]);
    const r = await review({ diff, context, profile: triage }, deps(s.call));
    expect(r.confirmedMarkers).toHaveLength(0);
    expect(r.verdict.conclusion).toBe("success");
  });

  it("retries an inconclusive run and uses the first conclusive one", async () => {
    const s = scripted([run("error"), run("didnt_look"), run("no_findings")]);
    const r = await review({ diff, context, profile: triage }, deps(s.call));
    expect(s.calls()).toBe(3);
    expect(r.outcome).toBe("no_findings");
  });

  it("gives up after the retries and reports no verdict", async () => {
    const s = scripted([run("error"), run("error"), run("error")]);
    const r = await review({ diff, context, profile: triage }, deps(s.call));
    expect(r.outcome).toBe("error");
    expect(r.verdict.conclusion).toBe("action_required");
  });

  it("confirmation never: one run decides", async () => {
    const s = scripted([run("findings", [guardRemoved])]);
    const r = await review({ diff, context, profile: resolveProfile("diff-triage", { confirmation: "never" }) }, deps(s.call));
    expect(s.calls()).toBe(1);
    expect(r.confirmedMarkers).toHaveLength(1);
  });

  it("the profile's blocking set decides what holds a merge", async () => {
    const s = scripted([run("findings", [guardRemoved])]);
    const r = await review({ diff, context, profile: resolveProfile("diff-triage", { blocking: ["SEC-AUTHZ"] }) }, deps(s.call));
    expect(s.calls()).toBe(1);
    expect(r.verdict.conclusion).toBe("success");
  });

  it("intent check without a description makes no model call", async () => {
    const s = scripted([]);
    const r = await review({ diff, context, profile: resolveProfile("intent-check", {}) }, deps(s.call));
    expect(s.calls()).toBe(0);
    expect(r.verdict.title).toContain("no description");
  });

  it("summary mode returns the summary", async () => {
    const summary = { title: "Drop auth", summary: "s", changes: ["c"], risks: [], testing: [] };
    const s = scripted([run("no_findings", [], summary)]);
    const r = await review({ diff, context, profile: resolveProfile("summary", {}) }, deps(s.call));
    expect(r.summary).toEqual(summary);
    expect(s.reqs[0]!.system).toContain("pull request description");
  });

  it("reviews every chunk and confirms only the chunks with candidates", async () => {
    const big = Array.from({ length: 3 }, (_, i) => ({
      path: `f${i}.ts`, status: "added" as const, additions: 40, deletions: 0,
      patch: `@@ -0,0 +1,40 @@\n` + Array.from({ length: 40 }, (_, l) => `+const v${l} = "${"z".repeat(40)}";`).join("\n"),
    }));
    const d = chunkDiff([...big, { path: "src/orders.ts", status: "modified", additions: 1, deletions: 1, patch }], { budgetTokens: 1000, maxChunks: 6 });
    expect(d.chunks.length).toBeGreaterThan(1);
    const results = d.chunks.map((c) => (c.paths.includes("src/orders.ts") ? run("findings", [guardRemoved]) : run("no_findings")));
    const s = scripted([...results, run("findings", [guardRemoved])]);
    const r = await review({ diff: d, context, profile: triage }, deps(s.call));
    expect(s.calls()).toBe(d.chunks.length + 1);
    expect(r.confirmedMarkers).toHaveLength(1);
    expect(r.chunks).toBe(d.chunks.length);
  });
});
