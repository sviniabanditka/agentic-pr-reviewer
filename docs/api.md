# Panel HTTP API

Served by `src/server.ts` on `PORT` (8080). Everything except `/healthz` requires HTTP
Basic auth (`PANEL_USER` / `PANEL_PASSWORD`). When `PANEL_PASSWORD` is unset the panel
is open — local development only.

POST requests must send `content-type: application/json`, and a request with an
`Origin` header from another host is refused with `403`. This keeps other sites from
triggering reviews through the browser's saved Basic credentials.

## `GET /healthz`

`200 ok`, no auth. Used by the Kubernetes probes.

## `GET /`

The panel (`src/panel.html`).

## `GET /api/state`

Everything the panel needs to render:

```jsonc
{
  "startedAt": 1790769919263,
  "models": ["sonnet", "opus", "haiku"],
  "accounts": [
    { "name": "work", "login": "ksivenkov96", "verifiedLogin": "ksivenkov96",
      "claudeReady": true, "model": "sonnet",
      "lastPollAt": 1790769924020, "lastPollMs": 4757, "openPrs": 4,
      "claude": { "fiveHour": { "utilization": 0.07, "resetsAt": 1790784000000 },
                  "sevenDay": { "utilization": 0.09, "resetsAt": 1791277200000 },
                  "status": "allowed", "checkedAt": 1790770000000 },
      "github": { "core": { "limit": 5000, "remaining": 4970, "reset": 1790772000000 },
                  "search": { "limit": 30, "remaining": 28, "reset": 1790770060000 } } }
  ],
  "prs": [
    { "account": "work", "repo": "owner/repo", "number": 10, "title": "…",
      "url": "https://github.com/…", "author": "someone", "role": "author",
      "updatedAt": "2026-09-30T10:00:00Z", "headSha": "5497500…" }
  ],
  "stages": { "12": "review" },
  "jobs": [ /* last 200 job rows, newest first, without the result JSON */ ],
  "events": [ /* last 300 log lines, oldest first */ ],
  "totals": { "reviews": 3, "runs": 4, "tokens_in": 120000, "tokens_out": 6000, "cost_usd": 0.52 }
}
```

`role` is `author`, `review_requested` or `author+reviewer`. `claude` is the Claude
subscription's usage windows (utilization 0..1) from the latest run or limits check;
`claudeError` is set when that check failed. `github` is the token's REST and search
quota. `stages` maps a running job id to `diff`, `review`, `confirm` or `comment`. `totals` covers finished
reviews of the last 24 h; `cost_usd` is what the runs would cost at API prices
(informational on a subscription).

## `GET /api/jobs/:id`

One job with its parsed `result` (verdict, findings, skipped files, usage) and every
log line tied to it (`events`).

## `GET /api/stream`

Server-sent events. A `: connected` comment is sent at once and a `: ping` every
20 s.

| Event | Data |
|---|---|
| `log` | an event row: `{id, ts, level, account, job_id, msg}` |
| `job` | a job row, whenever a job is queued or changes status |
| `status` | an account status, after each poll |
| `prs` | `{account, prs}` — that account's fresh open-PR list |
| `stage` | `{jobId, stage}` — a running job moved on; `stage: null` when it ended |

## `POST /api/review`

```json
{ "account": "work", "repo": "owner/repo", "number": 10, "model": "opus" }
```

`model` is optional (the account's default) and must be in the config's `models`.

| Code | Body |
|---|---|
| `202` | `{jobId}` — queued |
| `400` | malformed body |
| `409` | `{error}` — unknown account, no Claude token, model not allowed, PR not in the latest open list, or a review of it already queued/running |

## `POST /api/jobs/:id/publish`

Posts a finished review as the PR comment of that account, or edits the one already
there, and returns `{url}`. Earlier reviews of the same PR lose their `comment_url`.
`409` with `{error}` when the review is not `done`, the account is gone, the same
review is already being posted, or GitHub refuses. This is the only endpoint that
writes to GitHub.

## `POST /api/jobs/:id/cancel`

Cancels a queued review (status `skipped`, error `cancelled`). `409` when the job is not
queued: a running review has already spent its model run and is left to finish.

## `POST /api/limits`

```json
{ "account": "work" }
```

Reads the Claude subscription's usage windows by sending a tiny Haiku request for that
account (or every account when `account` is omitted), then returns `{ok: true}`. The
daemon also does this on start and every 30 minutes; every review refreshes them too.

## `POST /api/poll`

Runs a poll of every account now (joins one already running) and returns `{ok: true}`
when it finishes.
