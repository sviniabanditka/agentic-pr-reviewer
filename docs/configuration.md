# Configuration

Accounts, credentials, targets and models are configured in the web app. The server
itself reads only a few environment variables.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `MASTER_KEY` | — | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts stored tokens. Without it the server runs but cannot store or use tokens. Losing it means re-entering every token. |
| `DATA_DIR` | `data` (`/data` in the image) | SQLite file and per-credential Claude state dirs |
| `PORT` | `8080` | HTTP port |
| `PANEL_PASSWORD` / `PANEL_USER` | — / `admin` | Only on an instance with no users: creates the first admin non-interactively (how v1 deployments migrate). Otherwise the first visit shows a setup page. |
| `CONFIG_PATH`, `GH_TOKEN_<NAME>`, `CLAUDE_TOKEN_<NAME>` | — | v1 only: read once by the importer on first start, then ignored (see [operations.md](operations.md#migrating-from-v1)) |
| `GITHUB_API_URL` | `https://api.github.com` | For tests or GitHub Enterprise |

## Settings (stored in the database)

| Setting | Where | Default |
|---|---|---|
| Models offered in pickers | settings page (admin) | `sonnet`, `opus`, `haiku` |
| Per account: Claude credential, default model, label | accounts page | none / first model / login |
| Per target: query or repo, filters, role, automation, model, poll interval | targets page | manual, 60 s |

## Constants in code

| What | Value | Where |
|---|---|---|
| Diff budget | 32,000 tokens; thresholds 1,500 / 1,000 | `src/review/diff.ts` |
| Claude call timeout | 300 s | `src/review/claude.ts` |
| Retries of an inconclusive run | 2, after 10 s and 30 s | `src/review/run.ts` |
| Scheduler tick | 5 s; backoff on errors up to 15 min; waits for the GitHub reset on 403/429 | `src/scheduler/targets.ts` |
| Claude limits probe | every 30 min per credential (a Haiku "ok") | `src/scheduler/targets.ts` |
| Minimum poll interval | 30 s | `src/api/routes.ts` |
| Session lifetime | 30 days absolute, 7 days idle | `src/auth/auth.ts` |
| Login rate limit | 10 failures per IP or login per 15 min | `src/auth/auth.ts` |
| Prompt version (cache key) | `v7` | `src/review/cache_key.ts` |
| Verdict cache / event retention | 24 h / 14 days | `src/store/db.ts` |
| Concurrent reviews | 1 | `src/jobs/worker.ts` |
