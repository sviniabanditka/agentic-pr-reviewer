import { describe, expect, it } from "bun:test";
import { parseClaudeStream } from "../../src/review/claude.js";

const finding = {
  category: "SEC-AUTHZ",
  file: "a.ts",
  line_start: 1,
  line_end: 2,
  evidence: "",
  evidence_kind: "absent",
  claim: "claim",
  detail: "detail",
};

const rateLimit = JSON.stringify({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    unifiedWindows: { five_hour: { utilization: 0.07, resetsAt: 1790784000 }, seven_day: { utilization: 0.09, resetsAt: 1791277200 } },
  },
});

function stream(result: Record<string, unknown>, extra: string[] = []): string {
  const final = JSON.stringify({
    type: "result",
    is_error: false,
    usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
    total_cost_usd: 0.01,
    ...result,
  });
  return [JSON.stringify({ type: "system", subtype: "init" }), ...extra, final, ""].join("\n");
}

describe("parseClaudeStream", () => {
  it("reads findings from the result event and sums input tokens with cache reads", () => {
    const r = parseClaudeStream(stream({ structured_output: { findings: [finding] } }));
    expect(r.outcome).toBe("findings");
    expect(r.findings).toHaveLength(1);
    expect(r.usage).toEqual({ input: 100, output: 5 });
    expect(r.costUsd).toBe(0.01);
  });

  it("picks up the subscription windows from the rate-limit event, resets in ms", () => {
    const r = parseClaudeStream(stream({ structured_output: { findings: [] } }, [rateLimit]));
    expect(r.limits?.fiveHour).toEqual({ utilization: 0.07, resetsAt: 1790784000_000 });
    expect(r.limits?.sevenDay?.utilization).toBe(0.09);
    expect(r.limits?.status).toBe("allowed");
  });

  it("an empty findings array is no_findings", () => {
    expect(parseClaudeStream(stream({ structured_output: { findings: [] } })).outcome).toBe("no_findings");
  });

  it("output that fails the schema is didnt_look, not an empty review", () => {
    const r = parseClaudeStream(stream({ structured_output: { findings: [{ ...finding, category: "STYLE" }] } }));
    expect(r.outcome).toBe("didnt_look");
  });

  it("is_error carries the CLI's message, e.g. an expired login", () => {
    const r = parseClaudeStream(stream({ is_error: true, result: "Not logged in · Please run /login" }));
    expect(r.outcome).toBe("error");
    expect(r.errorMessage).toContain("Not logged in");
  });

  it("a stream without a result event is an error", () => {
    expect(parseClaudeStream("boom\n").outcome).toBe("error");
  });
});
