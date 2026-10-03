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

Plus `PANEL_PASSWORD` (required outside local dev) and optionally `PANEL_USER` (default
`admin`). Full reference: [docs/configuration.md](docs/configuration.md).

## Run locally

```bash
bun install
GH_TOKEN_PERSONAL=$(gh auth token --user your-login) \
CLAUDE_TOKEN_PERSONAL=<token from claude setup-token> \
PANEL_PASSWORD=dev bun run dev          # http://localhost:8080, user admin
```

State goes to `./data` (`DATA_DIR`).

## Deploy

One-time: create the namespace and the Secret.

```bash
ssh root@<node> "KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl apply -f -" < k8s/namespace.yaml
gh auth token --user your-login | ./scripts/set-secret.sh GH_TOKEN_PERSONAL
./scripts/set-secret.sh CLAUDE_TOKEN_PERSONAL       # paste the claude setup-token output
./scripts/set-secret.sh PANEL_PASSWORD
```

Every release:

```bash
./scripts/deploy.sh    # tests → buildx linux/amd64 → push → apply → rollout
```

`set-secret.sh KEY --restart` updates one key later and restarts the pod. The scripts
default to this project's cluster (`ssh.sviniabanditka.com`, key `~/.ssh/tracker_ci`,
registry `registry.sviniabanditka.com`); change them for another one. The Ingress host
(`k8s/ingress.yaml`) needs a DNS record pointing at the cluster. See
[docs/operations.md](docs/operations.md).

## Tests

```bash
bun test
bun run check     # tsc --noEmit
```

## Layout

```
src/
  main.ts          entry point: config, DB, token checks, server, poller, worker
  config.ts        config.json + tokens from env
  db.ts            SQLite schema (bun:sqlite)
  log.ts           event log: persisted, broadcast to open panels
  poller.ts        open-PR lists per account, enqueueing from the panel
  worker.ts        job loop: diff → review → stored result; publishJob posts on request
  server.ts        panel, JSON API, SSE stream, Basic auth
  panel.html       the web panel (no build step)
  github/          gh wrapper, git diff parser, comment renderer
  review/          diff budget, prompt, Claude call, two-run pipeline, evidence check
  verdict/         blocking rules, finding markers
k8s/               namespace, PVC + Deployment + Service, Ingress
scripts/           deploy.sh, set-secret.sh
tests/             bun test
```
