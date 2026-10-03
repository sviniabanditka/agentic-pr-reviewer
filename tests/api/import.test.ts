import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { harness } from "./harness.js";
import { importV1 } from "../../src/store/import_v1.js";
import { createUser } from "../../src/auth/auth.js";

let h: ReturnType<typeof harness>;
afterEach(() => h?.stop());

describe("importV1", () => {
  it("moves config.json accounts and env tokens into the database once", async () => {
    h = harness();
    const dir = mkdtempSync(join(tmpdir(), "apr-import-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({
      models: ["sonnet", "opus"],
      accounts: [{ name: "work", login: "octo", model: "opus", owners: ["o"], triggers: ["review_requested", "author"] }],
    }));
    h.rt.db.query(`INSERT INTO jobs (account, repo, number, title, url, role, head_sha, status, created_at) VALUES ('work','o/r',1,'t','u','author','abc','done',1)`).run();
    expect(await importV1(h.rt, { CONFIG_PATH: path, GH_TOKEN_WORK: "x" })).toEqual([]); // no admin yet
    const admin = await createUser(h.rt.db, "admin", "a long password", "admin");
    expect(await importV1(h.rt, { CONFIG_PATH: path, GH_TOKEN_WORK: "ghtest_value_000000000000", CLAUDE_TOKEN_WORK: "claudetest_value_000000000" })).toEqual(["work"]);
    const account = h.rt.db.query("SELECT * FROM accounts").get() as { login: string; credential_id: string; model: string; user_id: string };
    expect(account).toMatchObject({ login: "octo", model: "opus", user_id: admin.id });
    expect(account.credential_id).not.toBeNull();
    const targets = h.rt.db.query("SELECT name, filters_json FROM targets ORDER BY name").all();
    expect(targets).toEqual([
      { name: "My pull requests", filters_json: '{"owners":["o"]}' },
      { name: "Review requested", filters_json: "{}" },
    ]);
    expect(h.rt.db.query("SELECT user_id FROM jobs").get()).toEqual({ user_id: admin.id });
    expect(h.rt.models()).toEqual(["sonnet", "opus"]);
    expect(await importV1(h.rt, { CONFIG_PATH: path, GH_TOKEN_WORK: "y" })).toEqual([]);
  });
});
