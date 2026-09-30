import { describe, expect, it } from "bun:test";
import { cacheKey } from "../../src/review/cache_key.js";

describe("cacheKey", () => {
  it("differs when intent differs", () => {
    expect(cacheKey("diff", "sonnet", "fixes auth")).not.toBe(cacheKey("diff", "sonnet", "adds endpoint"));
  });

  it("differs when the model differs", () => {
    expect(cacheKey("diff", "sonnet")).not.toBe(cacheKey("diff", "opus"));
  });

  it("is stable for the same inputs", () => {
    expect(cacheKey("diff", "sonnet", "x")).toBe(cacheKey("diff", "sonnet", "x"));
  });
});
