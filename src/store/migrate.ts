import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** Applies every `NNNN_name.sql` not yet in schema_migrations, each in its own transaction. */
export function migrate(db: Database, dir = DIR): string[] {
  db.run("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set((db.query("SELECT version FROM schema_migrations").all() as { version: string }[]).map((r) => r.version));
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const ran: string[] = [];
  for (const file of files) {
    const version = file.slice(0, 4);
    if (applied.has(version)) continue;
    const sql = readFileSync(dir + file, "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, Date.now());
    })();
    ran.push(file);
  }
  return ran;
}
