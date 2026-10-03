# Agentic PR Reviewer

A self-hosted review desk for GitHub pull requests. It watches the PRs you care about
across one or more GitHub accounts, reviews a PR's diff with Claude when you press
**review**, shows you the result first, and posts a single comment headed
`🤖 Agentic PR Reviewer` only when you press **post**.

The review looks for what should hold a merge — a missing authorization check, a
removed guard, a broken contract, an irreversible operation — plus comment slop
(NICHE) and gaps between what the author claims and what the diff does (INTENT).
Every finding quotes the diff, and the quote is checked against the diff before it is
shown; blocking findings need a second, independent run to agree.

```
 browser ── Vue SPA (terminal style) ──► Hono API + SSE ─┬─► scheduler: targets → items (GitHub REST)
                                                        ├─► worker: diff → claude -p (no tools) → verify → verdict
                                                        ├─► publish: one marked PR comment (only on request)
                                                        └─► SQLite on a volume: users, encrypted tokens, targets, items, reviews
```

Everything is configured from the web: GitHub accounts (paste a token), Claude
credentials (paste `claude setup-token` output), targets (GitHub searches,
repositories, single PRs) with filters, and which credential and model each account
uses. Tokens are stored AES-256-GCM-encrypted with a key that lives only in the
server's environment.

Details live in [`docs/`](docs/README.md); where this is going is in
[`docs/plan/`](docs/plan/README.md).

## Requirements

| What | Why |
|---|---|
| [Bun](https://bun.sh) 1.3+ | runtime, tests, builds |
| [Claude Code](https://code.claude.com) | the model, on your own Claude subscription |
| Docker with buildx | building the linux/amd64 image |
| A Kubernetes cluster | hosting (manifests in `k8s/` target k3s + Traefik + cert-manager) |

## Run locally

```bash
bun install
bun run build:web
MASTER_KEY=$(openssl rand -base64 32) bun run dev      # http://localhost:8080 → create the admin
```

For frontend work run `bun run dev:web` alongside (Vite on :5173, proxying `/api`).
State goes to `./data` (`DATA_DIR`). Keep the `MASTER_KEY` you used: tokens stored
with one key cannot be read with another.

## Deploy

One-time: `cp .deploy.env.example .deploy.env` and fill it in (ssh target, registry,
public host), create the namespace and the master key:

```bash
source .deploy.env && ssh "$DEPLOY_SSH" "KUBECONFIG=$KUBECONFIG_REMOTE kubectl apply -f -" < k8s/namespace.yaml
openssl rand -base64 32 | tee ~/.config/pr-reviewer/master-key | ./scripts/set-secret.sh MASTER_KEY
```

Every release:

```bash
./scripts/deploy.sh    # tests → buildx linux/amd64 (builds the SPA inside) → push → apply → rollout
```

Then open the public host, create the admin login, add accounts, credentials and
targets. A v1 deployment (`config.json` + `GH_TOKEN_*` / `CLAUDE_TOKEN_*` env) is
imported automatically on first start. See [docs/operations.md](docs/operations.md).

## Tests

```bash
bun test          # pipeline, API against an in-memory DB with fake GitHub and Claude
bun run check     # tsc for the server, vue-tsc for the SPA
```

## Layout

```
src/
  main.ts          boot: DB + migrations, admin bootstrap, v1 import, server, scheduler, worker
  runtime.ts       shared state and injectable deps (GitHub base URL, Claude calls)
  api/             Hono app (auth, CSRF, headers, SSE, SPA), API v1 routes
  auth/            users (argon2id), sessions, invites, TOTP, API tokens, login rate limit
  cli/             apr: review a local diff through the API (bun run build:cli)
  providers/       claude-cli (subscription) and anthropic-api (API key) transports
  outputs/         notification channels (Slack, Telegram, webhook)
  accounts/        GitHub accounts and Claude credentials: validate, store encrypted, check
  scheduler/       target polling → items, filters, roles, auto-review, limits probe
  jobs/            queue, worker (review pipeline), publish (the only GitHub write)
  github/          REST client, diff parser, comment renderer
  review/          diff budget, prompt, Claude call, two-run pipeline, evidence check
  verdict/         blocking rules, finding markers
  store/           SQLite, migrations, repositories, AES-GCM secrets, v1 import
web/               Vue 3 + Vite + Tailwind v4 SPA (terminal style, dark only)
k8s/  scripts/     manifests; deploy.sh and set-secret.sh (read .deploy.env)
tests/             bun test; tests/fakes has a fake GitHub server
```

## License

MIT, see [LICENSE](LICENSE).
