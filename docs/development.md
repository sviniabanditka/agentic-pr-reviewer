# Development

## Commands

| Command | Does |
|---|---|
| `bun run dev` | server with `--watch` on :8080 (needs `MASTER_KEY`) |
| `bun run dev:web` | Vite on :5173 with `/api` proxied to :8080 |
| `bun run build:web` | builds the SPA into `web/dist` (the server serves it) |
| `bun test` | all tests |
| `bun run check` | `tsc` (server) and `vue-tsc` (SPA) |
| `./scripts/deploy.sh` | test, build, push, roll out |

## Tests

| Area | Files |
|---|---|
| Engine | `tests/review/*`, `tests/verdict/*`, `tests/github/{comment,parse_diff}.test.ts` |
| GitHub client | `tests/github/client.test.ts` against `tests/fakes/github.ts` |
| Store | `tests/store/*`: migrations (incl. adopting a v1 database), secrets, no token literals in the repo |
| API | `tests/api/*`: auth, CSRF, accounts, credentials, targets and filters, add by URL, the full review → publish cycle, auto-review, isolation between users, v1 import |

`tests/api/harness.ts` builds a `Runtime` on an in-memory database with a fake GitHub
server and a scripted Claude, and a cookie-keeping client. Nothing in the suite talks
to GitHub or Claude.

## Frontend

`web/` is a Vue 3 + Vite + Tailwind v4 app. Design tokens (Tokyo Night, JetBrains
Mono) are in `web/src/styles.css`; component classes go in `@layer components` so
utilities still win. Shared state is `web/src/store.ts` (one SSE connection);
terminal components are in `web/src/components/T*.vue`.

## After a change

| Changed | Also do |
|---|---|
| `SYSTEM_PROMPT`, `buildUserMessage`, the finding schema | bump `PROMPT_VERSION` in `src/review/cache_key.ts` |
| `findingMarker` | bump `v2` in the marker |
| the schema | add `src/store/migrations/NNNN_name.sql`; never edit an applied one; back up before deploying |
| an API route | update [api.md](api.md) and `web/src/types.ts` |
