import { describe, expect, it } from "bun:test";
import { parseDiffOutput } from "../../src/github/parse_diff.js";

// The shape `gh pr diff` prints.
const raw = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-old",
  "+new",
  " same",
  "diff --git a/img.png b/img.png",
  "new file mode 100644",
  "index 000..333",
  "Binary files /dev/null and b/img.png differ",
  "diff --git a/old.ts b/new.ts",
  "similarity index 90%",
  "rename from old.ts",
  "rename to new.ts",
  "",
].join("\n");

describe("parseDiffOutput", () => {
  it("splits files and reads status, counts and patch", () => {
    const [a, img, renamed] = parseDiffOutput(raw);
    expect(a).toMatchObject({ path: "src/a.ts", status: "modified", additions: 1, deletions: 1 });
    expect(a!.patch?.startsWith("@@ -1,2 +1,2 @@")).toBe(true);
    expect(img).toMatchObject({ path: "img.png", status: "added" });
    expect(img!.patch).toBeUndefined();
    expect(renamed).toMatchObject({ path: "new.ts", oldPath: "old.ts", status: "renamed" });
  });

  it("empty output is no files", () => {
    expect(parseDiffOutput("")).toEqual([]);
  });
});
