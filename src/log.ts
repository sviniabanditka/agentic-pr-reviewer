import type { Database } from "bun:sqlite";
import type { EventRow } from "./db.js";

export type LiveEvent = { type: "log" | "job" | "status" | "prs" | "stage"; data: unknown };
type Listener = (event: LiveEvent) => void;

const listeners = new Set<Listener>();
let db: Database | undefined;

export function initLog(database: Database): void {
  db = database;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function broadcast(event: LiveEvent): void {
  for (const listener of listeners) listener(event);
}

/** Persists a line for the panel's history and pushes it to every open panel. */
export function log(
  level: "info" | "warn" | "error",
  msg: string,
  ctx: { account?: string; jobId?: number } = {},
): void {
  const row: Omit<EventRow, "id"> = { ts: Date.now(), level, account: ctx.account ?? null, job_id: ctx.jobId ?? null, msg };
  const inserted = db
    ?.query("INSERT INTO events (ts, level, account, job_id, msg) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .get(row.ts, row.level, row.account, row.job_id, row.msg) as { id: number } | undefined;
  const prefix = [ctx.account, ctx.jobId !== undefined ? `#${ctx.jobId}` : undefined].filter(Boolean).join(" ");
  (level === "error" ? console.error : console.log)(`${level.toUpperCase()} ${prefix ? `[${prefix}] ` : ""}${msg}`);
  broadcast({ type: "log", data: { id: inserted?.id ?? 0, ...row } });
}
