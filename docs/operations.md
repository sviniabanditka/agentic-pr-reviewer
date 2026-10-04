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

**Rotating the master key:** generate a new one, set it with
`set-secret.sh MASTER_KEY`, set the previous one as `MASTER_KEY_OLD`, restart; the log
says how many secrets were re-encrypted. Then remove `MASTER_KEY_OLD` and restart again.

## Colleagues

An admin creates an invite link on the admin page (7 days, one use) and sends it
privately. The colleague picks a login and password, then adds their own GitHub
accounts and Claude subscription; nothing is shared between users. The admin page shows
load per user (reviews, tokens, model time, queue), never their repositories or
findings. Disabling a user signs them out, drops their queued reviews and turns their
targets off. Before inviting colleagues on a corporate Claude plan, see the policy note
in `docs/plan/09-open-questions.md`.

## Command-line client

`bun run build:cli` builds `dist/apr`. With a token from settings → api tokens:

```bash
export APR_URL=https://review.example.com APR_TOKEN=apr_…
apr review main          # reviews git diff main...HEAD as a pasted patch
```

Exit code 3 means blocking findings, so it can gate a pre-push hook.

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

The rail on the left: Inbox, Targets, Profiles, Accounts, Activity, Admin (admins), Settings.
⌘K (Ctrl+K) opens a palette with pages, pull requests and actions; every action also has a button.

| Page | For |
|---|---|
| inbox | Pull requests from your targets with status chips (Needs me / Running / Done / All / History — every review, newest first, closed PRs included) and filters; the selected one opens on the right: its review (findings, runs, log, compare), **Post to PR** with a choice of comment or inline review (two clicks), review again, export, history, archive. **+ Add** takes a PR link, a compare range or a pasted patch |
| targets | List with on/off switches; editor with presets, filters, what to do on a new commit (list / review / review and post) and a preview of matches |
| profiles | Review recipes: mode, model, categories and which block, confirmation, budget, instructions; prompt preview on a real PR |
| accounts | GitHub accounts (token or GitHub sign-in, Claude credential, default model and profile, quota) and Claude credentials (5-hour and 7-day usage) |
| activity | Audit log, live log, insights (by model, profile, day, category) |
| settings | Two-factor and password, notifications, API tokens, retention, models and GitHub sign-in (admin) |
| admin | People with their load, invites |

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
