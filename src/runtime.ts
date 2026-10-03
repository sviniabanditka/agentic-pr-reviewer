import type { Database } from "bun:sqlite";
import { Bus } from "./events/bus.js";
import { callClaude, probeLimits, type ClaudeLimits, type ClaudeSettings, type RunResult } from "./review/claude.js";
import { getSetting } from "./store/repos.js";
import type { SecretBox } from "./store/secrets.js";
import type { RateWindow } from "./github/client.js";
import type { Stage } from "./jobs/worker.js";
import type { EventRow } from "./store/types.js";

export const DEFAULT_MODELS = ["sonnet", "opus", "haiku"];

/** Outside services, swappable in tests. */
export interface Deps {
  githubBase: string | undefined;
  callClaude: (userMessage: string, settings: ClaudeSettings) => Promise<RunResult>;
  probeLimits: (settings: ClaudeSettings) => Promise<ClaudeLimits | undefined>;
}

export interface RuntimeOptions {
  db: Database;
  box: SecretBox | undefined;
  dataDir: string;
  quiet?: boolean;
  deps?: Partial<Deps>;
}

/**
 * Everything the process shares, in one object: tests build their own instead of
 * reaching for module-level singletons.
 */
export class Runtime {
  readonly db: Database;
  readonly box: SecretBox | undefined;
  readonly dataDir: string;
  readonly deps: Deps;
  readonly bus = new Bus();
  readonly stages = new Map<number, Stage>();
  /** Last GitHub quota seen per account id. */
  readonly githubRate = new Map<string, { core?: RateWindow; search?: RateWindow }>();
  readonly startedAt = Date.now();
  private readonly quiet: boolean;
  private wake: (() => void) | undefined;
  private pollNow: (targetId?: string) => Promise<void> = async () => {};

  constructor(opts: RuntimeOptions) {
    this.db = opts.db;
    this.box = opts.box;
    this.dataDir = opts.dataDir;
    this.quiet = opts.quiet ?? false;
    this.deps = { githubBase: undefined, callClaude, probeLimits, ...opts.deps };
  }

  /** Models offered in pickers; instance-wide setting. */
  models(): string[] {
    return getSetting(this.db, "", "models", DEFAULT_MODELS);
  }

  /** The secret box, or an error a person can act on. */
  requireBox(): SecretBox {
    if (this.box === undefined) throw new Error("MASTER_KEY is not set on the server, so tokens cannot be stored");
    return this.box;
  }

  /** Persists a line for the history and pushes it to the owner's open panels (or everyone's). */
  log(level: "info" | "warn" | "error", msg: string, ctx: { account?: string; jobId?: number; userId?: string } = {}): void {
    const row: Omit<EventRow, "id"> & { user_id: string | null } = {
      ts: Date.now(), level, account: ctx.account ?? null, job_id: ctx.jobId ?? null, msg, user_id: ctx.userId ?? null,
    };
    const inserted = this.db
      .query("INSERT INTO events (ts, level, account, job_id, msg, user_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
      .get(row.ts, row.level, row.account, row.job_id, row.msg, row.user_id) as { id: number };
    if (!this.quiet) {
      const prefix = [ctx.account, ctx.jobId !== undefined ? `#${ctx.jobId}` : undefined].filter(Boolean).join(" ");
      (level === "error" ? console.error : console.log)(`${level.toUpperCase()} ${prefix ? `[${prefix}] ` : ""}${msg}`);
    }
    this.bus.emit({ type: "log", data: { id: inserted.id, ...row }, ...(ctx.userId ? { userId: ctx.userId } : {}) });
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

  setPollHandler(fn: (targetId?: string) => Promise<void>): void {
    this.pollNow = fn;
  }

  requestPoll(targetId?: string): Promise<void> {
    return this.pollNow(targetId);
  }
}
