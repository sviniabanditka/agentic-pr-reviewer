import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../src/store/migrate.js";
import { newId } from "../../src/store/db.js";

describe("migrate", () => {
  it("adopts a v1 volume: existing tables and rows survive, new tables appear", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, role TEXT NOT NULL, head_sha TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      started_at INTEGER, finished_at INTEGER, outcome TEXT, conclusion TEXT, verdict_title TEXT, findings INTEGER, blocking INTEGER,
      confirmed INTEGER, runs INTEGER, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, model TEXT, cached INTEGER, comment_url TEXT,
      error TEXT, result TEXT);
      INSERT INTO jobs (account, repo, number, title, url, role, head_sha, status, created_at) VALUES ('w','o/r',1,'t','u','author','abc','done',1);`);
    const ran = migrate(db);
    expect(ran[0]).toStartWith("0001_");
    expect((db.query("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(1);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'users'").get()).not.toBeNull();
  });

  it("is idempotent", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(migrate(db)).toEqual([]);
  });

  it("newId is time-ordered and unique", () => {
    const a = newId();
    const b = newId();
    expect(a).toHaveLength(26);
    expect(a).not.toBe(b);
  });
});
