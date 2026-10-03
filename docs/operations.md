# Operations

## Where it runs

Single-node k3s at `ssh.sviniabanditka.com`, namespace `pr-reviewer`:

| Object | Notes |
|---|---|
| Deployment `pr-reviewer` | 1 replica, `Recreate` (one SQLite writer on an RWO volume), runs as uid 1000 |
| PVC `pr-reviewer-data` | 1 Gi `local-path`, mounted at `/data` |
| ConfigMap `pr-reviewer-config` | generated from `config.json` by `deploy.sh`; its hash is a pod annotation, so a config change rolls the pod |
| Secret `pr-reviewer-secrets` | tokens and panel password; not in the repo, filled by `set-secret.sh` |
| Ingress `pr-reviewer` | `review.sviniabanditka.com`, Traefik, TLS from cert-manager `letsencrypt-prod` |

Image: `registry.sviniabanditka.com/agentic-pr-reviewer:<yyyymmdd-hhmmss>`, built from
`oven/bun:1-debian` plus `gh` (apt) and Claude Code (native installer).

## Deploying

Settings live in `.deploy.env` (git-ignored; copy `.deploy.env.example`): ssh target
and key, kubeconfig path, namespace, registry, image name, public host.

```bash
./scripts/deploy.sh
```

Runs the tests, builds for `linux/amd64` with buildx, pushes, re-applies the namespace,
ConfigMap and manifests over ssh, and waits for the rollout. `SSH_KEY` overrides
`~/.ssh/tracker_ci`; `TAG` overrides the timestamp tag. Docker must be logged in to
the registry.

## Secrets

```bash
./scripts/set-secret.sh KEY [--restart]
```

The value is read hidden from the terminal or from stdin and goes over ssh stdin,
never on a command line. `--restart` rolls the pod so it picks the value up.

| Key | How to get it |
|---|---|
| `GH_TOKEN_<NAME>` | `gh auth token --user <login> \| ./scripts/set-secret.sh GH_TOKEN_<NAME>` |
| `CLAUDE_TOKEN_<NAME>` | run `claude setup-token` with the right Claude account (e.g. `claude-p` / `claude-c`), then paste into `set-secret.sh` |
| `MASTER_KEY` | `openssl rand -base64 32`; keep a copy (the deployed one is in `~/.config/pr-reviewer/master-key`) |
| `PANEL_PASSWORD` | only used to create the first admin on an empty instance (login `PANEL_USER`, default `admin`) |

Removing a key:

```bash
ssh -i ~/.ssh/tracker_ci root@ssh.sviniabanditka.com \
  'KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n pr-reviewer patch secret pr-reviewer-secrets \
   --type=json -p "[{\"op\":\"remove\",\"path\":\"/data/KEY\"}]"'
```

## Adding or removing an account

1. Edit `accounts` in `config.json`.
2. Set (or remove) `GH_TOKEN_<NAME>` and `CLAUDE_TOKEN_<NAME>`.
3. `./scripts/deploy.sh`.

A token whose login differs from `login` disables the account at start (logged as an
error).

## The panel

The configured public host — sign in with the admin login (on a migrated v1 instance:
`admin` with the old panel password).

- **Accounts**: Claude 5-hour and 7-day usage with reset times, GitHub API quota, last
  sync, open-PR count, and what is wrong when something is. **Check limits** re-reads
  the Claude windows.
- **Current review**: the running job's progress (fetch diff → review → confirm → post
  comment), a timer, its latest log lines, and the queue with a cancel button per job.
- **Open pull requests**: filter by All / To review / Mine and by account; each row
  shows the last review (with **New commits** when the head moved, and whether it is
  **Posted**), a model picker remembered per PR, **Review / Re-review**, and **Post**
  for a finished review that is not on the PR yet.
- **History / Log** tabs: reviews with a status filter; the live log with a level
  filter and follow/pause.
- **Details** slide in from the right for any review: verdict, findings with links to
  the lines, usage, and everything that happened. **Post comment to PR** (or **Replace
  the PR comment** when an earlier review is there) asks for a second click naming the
  GitHub account, then posts. Close with Esc, the × or a click
  outside; the URL (`#job/<id>`) opens it directly.
- The search box (`/`) filters PRs, history and log at once. Light and dark themes
  follow the system, with a toggle. The bell turns on browser notifications when a
  review finishes while the tab is in the background.

## Logs and debugging

```bash
K="KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n pr-reviewer"
ssh -i ~/.ssh/tracker_ci root@ssh.sviniabanditka.com "$K logs deploy/pr-reviewer -f"
ssh -i ~/.ssh/tracker_ci root@ssh.sviniabanditka.com "$K exec deploy/pr-reviewer -- claude --version"
```

The same lines are in the panel and in the `events` table.

| Symptom | Likely cause |
|---|---|
| Account shows "no Claude token" | `CLAUDE_TOKEN_<NAME>` missing, or the pod was not restarted after setting it |
| Job error `Not logged in` / `401 Invalid bearer token` | Claude token expired or revoked: new `claude setup-token`, `set-secret.sh … --restart` |
| Account disabled at start, "belongs to X" | `GH_TOKEN_<NAME>` is another account's token |
| Poll error mentioning SAML/SSO | the org requires authorizing the GitHub CLI token for SSO |
| `could not start: PR is not in the open list` | the PR was closed, or the list is stale: press refresh |
| Large PR, many "Not reviewed" files | over the 32k-token diff budget |

## Known limits

- One review at a time; a second request waits in the queue.
- Each run spends the Claude subscription's usage; a PR with blocking candidates costs
  two runs.
- `owners` only filters PRs you authored.
- The panel has a single user; no per-account access control.
