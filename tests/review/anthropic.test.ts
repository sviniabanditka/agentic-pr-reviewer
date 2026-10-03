import { afterEach, describe, expect, it } from "bun:test";
import { apiModel, callAnthropic, probeAnthropic } from "../../src/providers/anthropic.js";
import { SubmitFindingsSchema } from "../../src/review/finding.js";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

const finding = { category: "SEC-AUTHZ", file: "a.ts", line_start: 1, line_end: 1, evidence: "", evidence_kind: "absent", claim: "c", detail: "d" };

function fake(reply: (body: any) => Response) {
  const seen: any[] = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("x-api-key") !== "apitest_good_key_000000000000") return Response.json({ error: { message: "invalid x-api-key" } }, { status: 401 });
      if (new URL(req.url).pathname === "/v1/models") return Response.json({ data: [] });
      const body = await req.json();
      seen.push(body);
      return reply(body);
    },
  });
  return { base: `http://localhost:${server.port}`, seen };
}
const settings = (key = "apitest_good_key_000000000000") => ({ provider: "anthropic-api", oauthToken: key, model: "sonnet", configDir: "/tmp/none" });
const req = { system: "sys", user: "diff", schema: SubmitFindingsSchema };

describe("anthropic-api provider", () => {
  it("forces the submit tool, maps aliases, reads the tool input as the structured output", async () => {
    const f = fake(() => Response.json({ content: [{ type: "tool_use", name: "submit", input: { findings: [finding] } }], usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 }, stop_reason: "tool_use" }));
    const r = await callAnthropic(req, settings(), f.base);
    expect(r).toMatchObject({ outcome: "findings", usage: { input: 15, output: 7 } });
    expect(r.findings).toHaveLength(1);
    expect(f.seen[0]).toMatchObject({ model: "claude-sonnet-5-5", system: "sys", tool_choice: { type: "tool", name: "submit" } });
    expect(f.seen[0].tools).toHaveLength(1);
    expect(apiModel("claude-opus-5-5")).toBe("claude-opus-5-5");
  });

  it("off-schema output is didnt_look; API errors are errors with the message", async () => {
    const f = fake(() => Response.json({ content: [{ type: "tool_use", name: "submit", input: { findings: [{ ...finding, category: "STYLE" }] } }] }));
    expect((await callAnthropic(req, settings(), f.base)).outcome).toBe("didnt_look");
    const bad = await callAnthropic(req, settings("apitest_wrong_key_00000000000"), f.base);
    expect(bad).toMatchObject({ outcome: "error" });
    expect(bad.errorMessage).toContain("401");
  });

  it("the probe accepts a working key and rejects a bad one", async () => {
    const f = fake(() => new Response(null, { status: 500 }));
    expect(await probeAnthropic(settings(), f.base)).toBeUndefined();
    await expect(probeAnthropic(settings("apitest_wrong_key_00000000000"), f.base)).rejects.toThrow("invalid API key");
  });
});
