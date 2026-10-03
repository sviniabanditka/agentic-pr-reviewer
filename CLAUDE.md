# Agentic PR Reviewer

On-demand AI review of GitHub PRs: a Bun daemon in k3s with a web panel. The poller
only lists open PRs; a review runs when someone presses Review in the panel, via
`claude -p` (no tools) and `gh`; the result stays in the panel until Post puts it on the
PR as one comment per account.

## Run and test

```
bun test
bun run check
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

- Nothing reaches GitHub without an explicit Post press: the poller never enqueues,
  the worker never comments, `publishJob` (`POST /api/jobs/:id/publish`) is the only
  writer.
- `claude` runs with `--tools ""` and a from-scratch env; GitHub tokens must never
  reach it.
- Changing the prompt or the finding schema requires bumping `PROMPT_VERSION`
  (`src/review/cache_key.ts`).
- The comment is found by marker + author login; never edit "the user's last comment".
