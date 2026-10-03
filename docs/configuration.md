# Configuration

## `config.json`

Read from `CONFIG_PATH` (default `./config.json`; `/config/config.json` in the image,
mounted from the `pr-reviewer-config` ConfigMap that `scripts/deploy.sh` generates).
`config.json` is git-ignored; start from `config.example.json`.
Validated on start; an invalid file stops the process with the failing path.

```json
{
  "pollIntervalSec": 30,
  "models": ["sonnet", "opus", "haiku"],
  "accounts": [
    { "name": "personal", "login": "sviniabanditka", "model": "sonnet",
      "owners": ["sviniabanditka"], "triggers": ["review_requested", "author"] }
  ]
}
```

| Key | Default | Meaning |
|---|---|---|
| `pollIntervalSec` | `30` | How often the open-PR lists refresh (min 10). Two search calls per account per poll; GitHub allows 30 per minute per token. |
| `models` | `["sonnet","opus","haiku"]` | What the panel's model picker offers; anything `claude --model` accepts, aliases or full ids. |
| `accounts[].name` | — | Short id (`[a-z0-9_-]`); picks the token variables. |
| `accounts[].login` | — | The GitHub login the token must belong to; checked on start. |
| `accounts[].model` | first of `models` | Preselected in the picker. Must be in `models`. |
| `accounts[].owners` | any | Repo owners where **your own** PRs are listed. Keeps authored PRs in upstream projects out. Review requests are listed wherever they come from. |
| `accounts[].triggers` | — | `review_requested`, `author`, or both: which PRs are listed. |

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `GH_TOKEN_<NAME>` | — | GitHub token of account `<NAME>` (upper-cased, non-alphanumerics → `_`). Required. `gh auth token --user <login>` prints the token `gh` holds (scopes `repo`, `read:org`, `gist`). |
| `CLAUDE_TOKEN_<NAME>` | — | Output of `claude setup-token` for the Claude subscription that pays for this account's reviews. Without it the account's PRs are listed but cannot be reviewed. |
| `MASTER_KEY` | — | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts tokens stored in the database. Losing it means re-entering every stored token. |
| `PANEL_PASSWORD` / `PANEL_USER` | — / `admin` | Only read on an instance with no users: creates the first admin with this login and password (how v1 deployments migrate). Without it the first visit shows a setup page. Can be removed afterwards. |
| `DATA_DIR` | `data` (`/data` in the image) | SQLite file and per-account Claude config dirs. |
| `CONFIG_PATH` | `config.json` | See above. |
| `PORT` | `8080` | HTTP port. |

## Constants in code

| What | Value | Where |
|---|---|---|
| Diff budget | 32,000 tokens; thresholds 1,500 / 1,000 | `src/review/diff.ts` |
| Token estimate | 3.5 characters per token | `src/review/diff.ts` |
| Claude call timeout | 300 s | `src/review/claude.ts` |
| Retries of an inconclusive run | 2, after 10 s and 30 s | `src/review/run.ts` |
| `gh` call timeout | 60 s | `src/github/gh.ts` |
| Prompt version (cache key) | `v7` | `src/review/cache_key.ts` |
| Verdict cache | 24 h | `src/db.ts` |
| Event retention | 14 days | `src/db.ts` |
| Comment size cap | 60,000 characters | `src/github/comment.ts` |
| Concurrent reviews | 1 | `src/worker.ts` |
| Claude limits check | on start, then every 30 min (a Haiku "ok") | `src/poller.ts` |
