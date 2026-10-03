# Operations

## Where it runs

A Kubernetes namespace (default `pr-reviewer`):

| Object | Notes |
|---|---|
| Deployment `pr-reviewer` | 1 replica, `Recreate` (one SQLite writer, RWO volume), uid 1000, keeps 2 old ReplicaSets |
| PVC `pr-reviewer-data` | 1 Gi, mounted at `/data` |
| Secret `pr-reviewer-secrets` | `MASTER_KEY` (and v1 leftovers until removed); filled by `set-secret.sh` |
| ConfigMap `pr-reviewer-config` | only for the v1 import; generated from `config.json` if present |
| Ingress `pr-reviewer` | host `PUBLIC_HOST`, TLS from cert-manager `letsencrypt-prod` |

The image is built from `Dockerfile` in two stages: the SPA is built with Vite, then
copied next to the server on `oven/bun:1-debian` with Claude Code installed by its
native installer.

## Deploying

Settings live in `.deploy.env` (git-ignored; copy `.deploy.env.example`).

```bash
./scripts/deploy.sh
```

Runs the tests, builds `linux/amd64`, pushes, applies the namespace, ConfigMap (if
`config.json` exists) and manifests, waits for the rollout.

**Back up before a deploy that adds a migration** (`src/store/migrations/`):

```bash
source .deploy.env
ssh -i "$DEPLOY_SSH_KEY" "$DEPLOY_SSH" "KUBECONFIG=$KUBECONFIG_REMOTE kubectl -n $NAMESPACE exec deploy/pr-reviewer -- \
  tar -C /data -cf - reviewer.sqlite reviewer.sqlite-wal reviewer.sqlite-shm" > backup-$(date +%F).tar
```

## Secrets

```bash
./scripts/set-secret.sh KEY [--restart]
```

Reads the value hidden from the terminal or from stdin and sends it over ssh stdin.
Since v2 the only required key is `MASTER_KEY`; GitHub and Claude tokens are added in
the web app. Keep a copy of the master key (the deployed one is in
`~/.config/pr-reviewer/master-key`).

## Migrating from v1

On the first start with a v2 image, if `config.json` is mounted and `GH_TOKEN_<NAME>` /
`CLAUDE_TOKEN_<NAME>` are in the environment, the importer:

1. creates the first admin from `PANEL_PASSWORD` (login `PANEL_USER`, default `admin`)
   if there is no user yet;
2. for every v1 account with a GitHub token: an account (label = v1 name), a Claude
   credential from its `CLAUDE_TOKEN_*`, and one search target per trigger
   (`review-requested:@me`, `author:@me` with the v1 `owners` as a filter);
3. links the old reviews to the new accounts and copies the model list;
4. records that it ran, so it never runs again.

Afterwards the v1 variables can be removed from the Secret and `config.json` deleted.

## The web app

| Page | For |
|---|---|
| overview | Account cards (Claude 5h/7d and GitHub quota as ASCII bars), the running review with its stage strip, the queue, recent reviews, 24 h totals |
| inbox | Every open PR from your targets; filter by role, needs review / unposted, state, account; `/` to search; model picker, **review**, **post** per row; add a PR by URL |
| PR page | Header, labels, size, all reviews of the PR, review / post / archive |
| review drawer (`?review=<id>` on any page) | Verdict, facts, findings with links to the lines, what happened; **post to pr** (two clicks), cancel, review again, open/copy the comment |
| targets | List with last poll and errors; editor with presets, filters, automation and a live preview |
| accounts | GitHub accounts (token, label, credential, default model, check, replace, remove) and Claude credentials (limits, check, remove) |
| activity | Live log with level filter, grep and follow |
| settings | Models list (admin) |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "MASTER_KEY is not set" in the log | the Secret lacks `MASTER_KEY`, or the pod was not restarted after setting it |
| "secret sealed with key X, MASTER_KEY is Y" | the master key changed; restore the old one or re-enter the tokens |
| Account `invalid`, "token now belongs to @…" | the token was replaced with another user's |
| Credential `error` / `invalid` with 401 | the `claude setup-token` token expired or was revoked: add a new credential |
| Target shows "GitHub 403 … rate limit" | search quota (30/min per token) exhausted; the target waits for the reset; raise poll intervals |
| Target error mentioning SAML/SSO | the organization requires authorizing the token for SSO |
| Review "no Claude credential attached" | attach a credential to the account on the accounts page |
