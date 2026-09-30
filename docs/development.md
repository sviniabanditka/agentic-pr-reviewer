# Development

## Commands

| Command | Does |
|---|---|
| `bun run dev` | daemon with `--watch` (needs `config.json` and tokens in env) |
| `bun test` | all tests |
| `bun run check` | `tsc --noEmit` |
| `./scripts/deploy.sh` | test, build, push, roll out |

## Tests

| File | Covers |
|---|---|
| `tests/review/diff.test.ts` | hunk numbering, budget, lockfile/binary skipping |
| `tests/review/verify.test.ts` | evidence matching, GUARD-REMOVED downgrade |
| `tests/review/claude.test.ts` | parsing `claude -p --output-format json` output |
| `tests/review/run.test.ts` | confirmation run, retries, giving up |
| `tests/review/cache_key.test.ts` | cache key inputs |
| `tests/verdict/*.test.ts` | blocking rules, markers |
| `tests/github/comment.test.ts` | comment header, sections, links, size cap |
| `tests/github/parse_diff.test.ts` | `gh pr diff` parsing |

The pipeline is tested with a scripted `call` in place of Claude; nothing in the
test suite talks to GitHub or Claude.

## After a change

| Changed | Also do |
|---|---|
| `SYSTEM_PROMPT`, `buildUserMessage`, the finding schema | bump `PROMPT_VERSION` in `src/review/cache_key.ts` |
| `findingMarker` | bump `v2` in the marker, or confirmation matching mixes old and new |
| SQLite schema | tables are `CREATE … IF NOT EXISTS`: a new column needs an explicit `ALTER TABLE` in `openDb` for existing volumes |
| `config.json` | `./scripts/deploy.sh` (the ConfigMap hash rolls the pod) |
| the panel's API | update [api.md](api.md) |

## Trying the pipeline by hand

Locally, `claude` authenticates from the keychain, which the daemon's clean env does
not pass through; run the daemon with `CLAUDE_TOKEN_<NAME>` from `claude setup-token`,
or call `review()` from a scratch script with your own `call`.
