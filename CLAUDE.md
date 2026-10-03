# Agentic PR Reviewer

On-demand AI review of GitHub PRs: a Bun server (Hono + SQLite) with a Vue SPA in
`web/`, deployed to k3s. Accounts, Claude credentials and targets live in the
database (tokens AES-GCM-encrypted with `MASTER_KEY`). Targets only list PRs; a
review runs on a press (or on new commits for an `auto-review` target) via
`claude -p` (no tools); the result stays in the app until Post puts it on the PR as
one comment per account.

## Run and test

```
bun test
bun run check        # tsc + vue-tsc
bun run build:web    # before running the server locally
bun run build:cli    # dist/apr, the command-line client
```

## Deploy

`./scripts/deploy.sh` — tests, buildx `linux/amd64`, push, apply `k8s/` over ssh,
rollout; all hosts and keys come from `.deploy.env` (git-ignored). Back up the
database before deploying a new migration:
`kubectl -n pr-reviewer exec deploy/pr-reviewer -- cat /data/reviewer.sqlite > backup.sqlite`
(stop writes first or accept a WAL-consistent copy via `sqlite3 .backup` if available).
Secrets only through `./scripts/set-secret.sh KEY [--restart]`; never put tokens in
`config.json`, manifests or command lines.

## Rules that are easy to break

- Nothing reaches GitHub without an explicit Post press, except for targets the user
  set to `auto-post` (confirmed by typing the account login, audited).
  `publishJob` is the only writer; every write goes to the `audit` table. The scheduler
  enqueues only for targets set to `auto-review` or `auto-post`.
- Admins see load (counts, tokens, time), never another user's repositories, titles,
  findings or tokens. Admin routes refuse API tokens.
- API tokens (`apr_…`, CLI) skip CSRF because browsers never send them on their own;
  they cannot create more tokens.
- Every owner-scoped query filters by `user_id`; API tests check cross-user access.
- `claude` runs with `--tools ""` and a from-scratch env; GitHub tokens must never
  reach it.
- Changing the prompt or the finding schema requires bumping `PROMPT_VERSION`
  (`src/review/cache_key.ts`).
- The comment is found by marker + author login; never edit "the user's last comment".
