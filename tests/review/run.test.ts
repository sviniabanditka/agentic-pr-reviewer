import { describe, expect, it } from "bun:test";
import { review } from "../../src/review/run.js";
import { prepareDiff } from "../../src/review/diff.js";
import type { RunResult } from "../../src/review/claude.js";
import type { Finding } from "../../src/review/finding.js";

const diff = prepareDiff([
  {
    path: "src/orders.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "@@ -1,2 +1,2 @@\n-router.get(\"/o/:id\", requireAuth, handler);\n+router.get(\"/o/:id\", handler);\n export default router;",
  },
]);
const context = { repo: "o/r", number: 1, title: "t", headSha: "h", baseSha: "b", branch: "x" };

const guardRemoved: Finding = {
  category: "GUARD-REMOVED",
  file: "src/orders.ts",
  line_start: 1,
  line_end: 1,
  evidence: 'router.get("/o/:id", requireAuth, handler);',
  evidence_kind: "removed",
  claim: "requireAuth removed",
  detail: "d",
};
const niche: Finding = { ...guardRemoved, category: "NICHE", evidence: "export default router;", evidence_kind: "present" };

function run(outcome: RunResult["outcome"], findings: Finding[] = []): RunResult {
  return { outcome, findings, latencyMs: 1, usage: { input: 10, output: 1 } };
}

function scripted(results: RunResult[]): { call: () => Promise<RunResult>; calls: () => number } {
  let i = 0;
  return { call: async () => results[i++] ?? run("error"), calls: () => i };
}

const deps = (call: () => Promise<RunResult>) => ({ call, log: () => {}, retryDelaysMs: [0, 0] });

describe("review", () => {
  it("non-blocking findings need one run", async () => {
    const s = scripted([run("findings", [niche])]);
    const r = await review({ diff, context }, deps(s.call));
    expect(s.calls()).toBe(1);
    expect(r.verdict.conclusion).toBe("success");
  });

  it("a blocking finding reproduced by the second run is confirmed", async () => {
    const s = scripted([run("findings", [guardRemoved]), run("findings", [guardRemoved])]);
    const r = await review({ diff, context }, deps(s.call));
    expect(s.calls()).toBe(2);
    expect(r.confirmedMarkers).toHaveLength(1);
    expect(r.verdict.conclusion).toBe("action_required");
    expect(r.usage.runs).toBe(2);
  });

  it("a blocking finding the second run does not reproduce stays unconfirmed", async () => {
    const s = scripted([run("findings", [guardRemoved]), run("no_findings")]);
    const r = await review({ diff, context }, deps(s.call));
    expect(r.confirmedMarkers).toHaveLength(0);
    expect(r.verdict.conclusion).toBe("success");
  });

  it("retries an inconclusive run and uses the first conclusive one", async () => {
    const s = scripted([run("error"), run("didnt_look"), run("no_findings")]);
    const r = await review({ diff, context }, deps(s.call));
    expect(s.calls()).toBe(3);
    expect(r.outcome).toBe("no_findings");
  });

  it("gives up after the retries and reports no verdict", async () => {
    const s = scripted([run("error"), run("error"), run("error")]);
    const r = await review({ diff, context }, deps(s.call));
    expect(s.calls()).toBe(3);
    expect(r.outcome).toBe("error");
    expect(r.verdict.conclusion).toBe("action_required");
  });
});
