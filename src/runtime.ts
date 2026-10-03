import type { Database } from "bun:sqlite";
import { Bus } from "./events/bus.js";
import type { Config } from "./config.js";
import type { SecretBox } from "./store/secrets.js";
import type { AccountStatus, OpenPr } from "./scheduler/poller.js";
import type { Stage } from "./jobs/worker.js";
import type { EventRow } from "./store/types.js";

/**
 * Everything the process shares, in one object: tests build their own instead of
 * reaching for module-level singletons.
 */
export class Runtime {
  readonly bus = new Bus();
  readonly accountStatus = new Map<string, AccountStatus>();
  readonly openPrs = new Map<string, OpenPr[]>();
  readonly stages = new Map<number, Stage>();
  readonly startedAt = Date.now();
  private wake: (() => void) | undefined;
  private pollNow: () => Promise<void> = async () => {};

  constructor(
    readonly cfg: Config,
    readonly db: Database,
    readonly box: SecretBox | undefined,
    private readonly quiet = false,
  ) {}

  /** Persists a line for the panel's history and pushes it to every open panel. */
  log(level: "info" | "warn" | "error", msg: string, ctx: { account?: string; jobId?: number } = {}): void {
    const row: Omit<EventRow, "id"> = { ts: Date.now(), level, account: ctx.account ?? null, job_id: ctx.jobId ?? null, msg };
    const inserted = this.db
      .query("INSERT INTO events (ts, level, account, job_id, msg) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .get(row.ts, row.level, row.account, row.job_id, row.msg) as { id: number };
    if (!this.quiet) {
      const prefix = [ctx.account, ctx.jobId !== undefined ? `#${ctx.jobId}` : undefined].filter(Boolean).join(" ");
      (level === "error" ? console.error : console.log)(`${level.toUpperCase()} ${prefix ? `[${prefix}] ` : ""}${msg}`);
    }
    this.bus.emit({ type: "log", data: { id: inserted.id, ...row } });
  }

  /** The worker parks here when the queue is empty. */
  waitForWork(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      setTimeout(resolve, ms);
    });
  }

  kickWorker(): void {
    this.wake?.();
  }

  setPollHandler(fn: () => Promise<void>): void {
    this.pollNow = fn;
  }

  requestPoll(): Promise<void> {
    return this.pollNow();
  }
}
