import { newId } from "../store/db.js";
import { getSecret, putSecret } from "../store/secrets.js";
import type { Runtime } from "../runtime.js";

export type ChannelType = "webhook" | "slack" | "telegram";
export type NotifyEvent = "done" | "blocking" | "failed" | "posted";
export const NOTIFY_EVENTS: NotifyEvent[] = ["done", "blocking", "failed", "posted"];

export interface ChannelRow {
  id: string;
  user_id: string;
  type: ChannelType;
  label: string;
  secret_id: string;
  chat_id: string | null;
  events_json: string;
  enabled: number;
  last_error: string | null;
  created_at: number;
}

export interface Notice {
  event: NotifyEvent;
  title: string;
  repo: string;
  number: number;
  verdict: string;
  url: string;
  reviewUrl?: string;
  commentUrl?: string | null;
}

export function listChannels(rt: Runtime, userId: string): ChannelRow[] {
  return rt.db.query("SELECT * FROM channels WHERE user_id = ? ORDER BY created_at").all(userId) as ChannelRow[];
}

/** The URL (webhook, Slack) or bot token (Telegram) is stored encrypted like any token. */
export function addChannel(rt: Runtime, userId: string, input: { type: ChannelType; label: string; secret: string; chatId?: string; events: NotifyEvent[] }): ChannelRow {
  if (input.type !== "telegram" && !/^https:\/\//.test(input.secret)) throw new Error("the webhook URL must start with https://");
  if (input.type === "telegram" && !input.chatId) throw new Error("a Telegram channel needs a chat id");
  const id = newId();
  const secretId = putSecret(rt.db, rt.requireBox(), userId, `channel-${input.type}`, input.secret.trim());
  rt.db
    .query("INSERT INTO channels (id, user_id, type, label, secret_id, chat_id, events_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, input.type, input.label, secretId, input.chatId ?? null, JSON.stringify(input.events), Date.now());
  return rt.db.query("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow;
}

export function publicChannel(c: ChannelRow) {
  return { id: c.id, type: c.type, label: c.label, chatId: c.chat_id, events: JSON.parse(c.events_json) as NotifyEvent[], enabled: c.enabled === 1, lastError: c.last_error };
}

function text(n: Notice): string {
  const head = { done: "review finished", blocking: "blocking findings", failed: "review failed", posted: "posted to the pull request" }[n.event];
  return `🤖 Agentic PR Reviewer — ${head}\n${n.repo} #${n.number}: ${n.title}\n${n.verdict}${n.commentUrl ? `\n${n.commentUrl}` : n.reviewUrl ? `\n${n.reviewUrl}` : `\n${n.url}`}`;
}

async function send(rt: Runtime, c: ChannelRow, n: Notice): Promise<void> {
  const secret = getSecret(rt.db, rt.requireBox(), c.secret_id);
  let res: Response;
  if (c.type === "telegram") {
    res = await fetch(`https://api.telegram.org/bot${secret}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: c.chat_id, text: text(n), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
  } else {
    const body = c.type === "slack" ? { text: text(n) } : { source: "agentic-pr-reviewer", ...n };
    res = await fetch(secret, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  }
  if (!res.ok) throw new Error(`${c.type} answered ${res.status}`);
}

/** Fans a notice out to the user's channels subscribed to its event. Never throws. */
export async function notify(rt: Runtime, userId: string, n: Notice, only?: string): Promise<void> {
  for (const c of listChannels(rt, userId)) {
    if (only ? c.id !== only : !c.enabled || !(JSON.parse(c.events_json) as string[]).includes(n.event)) continue;
    try {
      await send(rt, c, n);
      rt.db.query("UPDATE channels SET last_error = NULL WHERE id = ?").run(c.id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      rt.db.query("UPDATE channels SET last_error = ? WHERE id = ?").run(msg.slice(0, 300), c.id);
      rt.log("warn", `notification "${c.label}" failed: ${msg}`, { userId });
      if (only) throw error;
    }
  }
}
