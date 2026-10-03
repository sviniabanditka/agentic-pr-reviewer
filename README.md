# Agentic PR Reviewer

AI review of GitHub pull requests that looks for what should hold a merge — a missing
authorization check, a removed guard, a broken contract, an irreversible operation —
plus comment slop (NICHE) and gaps between what the author claims and what the diff
does (INTENT).

Reviews run **on demand** and stay private until you post them: a web panel lists your
open PRs (yours and the ones you are asked to review) across one or more GitHub
accounts, you pick a model and press **Review**, read the result in the panel, and only
**Post** puts it on the PR — as a single comment from that account, headed
`🤖 Agentic PR Reviewer`. Posting a later review edits the same comment.

```
             ┌──────────────────── pr-reviewer pod (Bun) ─────────────────────┐
 browser ───►│ panel + API (Basic auth, SSE live log)                          │
             │ poller: every 30 s, per account, gh search                     │──► GitHub (gh CLI,
             │   review-requested:@me / author:@me → "Open PRs" list           │     per-account token)
             │ worker: 1 job at a time                                         │
             │   gh pr diff → prepareDiff → claude -p (no tools) → verify      │──► Claude Code CLI
             │   → 2nd run if blocking → result kept in the panel              │     (your subscription)
             │ Post button: comment create/edit                                │
             │ SQLite on a PVC: jobs, events, PR state, verdict cache          │
             └─────────────────────────────────────────────────────────────────┘
```

Details live in [`docs/`](docs/README.md); the plan for turning this into a full review system is in [`docs/plan/`](docs/plan/README.md).

## Requirements

| What | Why |
|---|---|
| [Bun](https://bun.sh) 1.3+ | runtime, tests |
| [gh](https://cli.github.com) | all GitHub access |
| [Claude Code](https://code.claude.com) | the model; authenticated with your own Claude subscription |
| Docker with buildx | building the linux/amd64 image |
| A k3s/Kubernetes cluster | hosting (manifests in `k8s/` target k3s + Traefik + cert-manager) |

## Configuration

`config.json` lists the accounts; tokens never go in it:

```json
{
  "pollIntervalSec": 30,
  "models": ["sonnet", "opus", "haiku"],
  "accounts": [
    { "name": "personal", "login": "your-login", "model": "sonnet",
      "owners": ["your-login"], "triggers": ["review_requested", "author"] }
  ]
}
```

Per account, from the environment (in the cluster: the `pr-reviewer-secrets` Secret):

| Variable | Source |
|---|---|
| `GH_TOKEN_<NAME>` | `gh auth token --user <login>` |
| `CLAUDE_TOKEN_<NAME>` | `claude setup-token` |

Plus `MASTER_KEY` (`openssl rand -base64 32`, encrypts stored tokens). The first visit
to an empty instance asks you to create the admin login; `PANEL_PASSWORD` instead
creates it non-interactively. Full reference: [docs/configuration.md](docs/configuration.md).

## Run locally

```bash
bun install
GH_TOKEN_PERSONAL=$(gh auth token --user your-login) \
CLAUDE_TOKEN_PERSONAL=<token from claude setup-token> \
MASTER_KEY=$(openssl rand -base64 32) \
bun run dev                              # http://localhost:8080 → /setup on first visit
```

State goes to `./data` (`DATA_DIR`).

## Deploy

One-time: `cp .deploy.env.example .deploy.env` and `cp config.example.json config.json`,
fill both in, then create the namespace and the Secret.

```bash
source .deploy.env && ssh "$DEPLOY_SSH" "KUBECONFIG=$KUBECONFIG_REMOTE kubectl apply -f -" < k8s/namespace.yaml
openssl rand -base64 32 | ./scripts/set-secret.sh MASTER_KEY
gh auth token --user your-login | ./scripts/set-secret.sh GH_TOKEN_PERSONAL
./scripts/set-secret.sh CLAUDE_TOKEN_PERSONAL       # paste the claude setup-token output
```

Every release:

```bash
./scripts/deploy.sh    # tests → buildx linux/amd64 → push → apply → rollout
```

`set-secret.sh KEY --restart` updates one key later and restarts the pod. The Ingress
host comes from `PUBLIC_HOST` and needs a DNS record pointing at the cluster. See
[docs/operations.md](docs/operations.md).

## Tests

```bash
bun test
bun run check     # tsc --noEmit
```

## License

MIT, see [LICENSE](LICENSE).

## Layout

```
src/
  main.ts          boot: config, DB + migrations, admin bootstrap, server, poller, worker
  runtime.ts       shared state (db, event bus, account status, open PRs, stages)
  config.ts        config.json + tokens from env
  api/app.ts       Hono app: auth, CSRF, security headers, panel endpoints, SSE
  auth/            users (argon2id), sessions, login rate limit
  store/           SQLite, numbered migrations, AES-GCM secrets, row types
  events/          in-process event bus
  scheduler/       open-PR lists per account, Claude limits probe
  jobs/            queue (enqueue, cancel), worker (review pipeline), publish (the only GitHub write)
  github/          gh wrapper, git diff parser, comment renderer
  review/          diff budget, prompt, Claude call, two-run pipeline, evidence check
  verdict/         blocking rules, finding markers
  web/             panel, login and setup pages
k8s/               namespace, PVC + Deployment + Service, Ingress (host from .deploy.env)
scripts/           deploy.sh, set-secret.sh (read .deploy.env)
tests/             bun test: pipeline, API (temp DB), store
```
