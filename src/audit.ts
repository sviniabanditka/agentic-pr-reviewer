import type { Runtime } from "./runtime.js";

export type AuditAction =
  | "post_comment"
  | "post_review"
  | "auto_post"
  | "account_added"
  | "account_removed"
  | "token_replaced"
  | "credential_added"
  | "credential_removed"
  | "target_auto_post_enabled"
  | "channel_added"
  | "channel_removed";

/** One row per GitHub write and per change to stored credentials; never contains a token. */
export function audit(rt: Runtime, userId: string, action: AuditAction, subject: string, details: Record<string, unknown> = {}, accountId?: string): void {
  rt.db
    .query("INSERT INTO audit (user_id, account_id, action, subject, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userId, accountId ?? null, action, subject, JSON.stringify(details), Date.now());
}
