import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "./migrate.js";

export function openDb(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "reviewer.sqlite"), { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

/** For tests: a fresh migrated database in memory. */
export function memoryDb(): Database {
  const db = new Database(":memory:", { strict: true });
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Events, the verdict cache and dead sessions are working data, not history. */
export function prune(db: Database): void {
  db.query("DELETE FROM events WHERE ts < ?").run(Date.now() - 14 * DAY_MS);
  db.query("DELETE FROM cache WHERE created_at < ?").run(Date.now() - DAY_MS);
  db.query("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}

export function newId(): string {
  // Time-ordered and unguessable: 48-bit ms timestamp + 80 random bits, base32 (ULID layout).
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let ts = Date.now();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = alphabet[ts % 32] + time;
    ts = Math.floor(ts / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(16));
  let tail = "";
  for (let i = 0; i < 16; i++) tail += alphabet[rand[i]! % 32];
  return time + tail;
}
