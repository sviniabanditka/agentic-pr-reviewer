export function dur(ms: number | null | undefined): string {
  if (ms == null || ms < 0 || Number.isNaN(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${String(m % 60).padStart(2, "0")}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

export function rel(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const d = now - ts;
  if (d < 0) {
    const m = Math.round(-d / 60000);
    return m < 60 ? `in ${m}m` : m < 2880 ? `in ${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `in ${Math.round(m / 1440)}d`;
  }
  if (d < 10000) return "just now";
  if (d < 60000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.round(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.round(d / 3600000)}h ago`;
  return `${Math.round(d / 86400000)}d ago`;
}

export const clock = (ts: number) => new Date(ts).toLocaleTimeString("en-GB");
export const stamp = (ts: number | null | undefined) =>
  ts ? new Date(ts).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
export const short = (repo: string) => repo.split("/")[1] ?? repo;
export const sha7 = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "");

export const roleLabel = (r: string) =>
  r === "author" ? "yours" : r === "review_requested" ? "review requested" : r === "author+reviewer" ? "yours + requested" : "watching";

export const BLOCKING = ["SEC-AUTHZ", "GUARD-REMOVED", "API-UNDOC", "IRREVERSIBLE"];

export function verdictWord(r: { status: string; conclusion: string | null; confirmed: number | null; findings: number | null; error: string | null }): string {
  if (r.status === "done") return r.conclusion === "success" ? `clean${r.findings ? `, ${r.findings} note${r.findings > 1 ? "s" : ""}` : ""}` : `${r.confirmed} blocking`;
  if (r.status === "error") return "failed";
  if (r.status === "skipped") return r.error === "cancelled" ? "cancelled" : "skipped";
  return r.status === "running" ? "reviewing" : "queued";
}
