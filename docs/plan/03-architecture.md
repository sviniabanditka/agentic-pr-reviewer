# 03 · Target architecture

## Shape

Still one deployable: a Bun process serving the API, the built SPA and SSE, running
the scheduler and the review workers, with SQLite on a volume. A second, optional
container appears only for repo-aware reviews (the sandboxed runner).

```
                 ┌──────────────────────────── pr-reviewer pod ─────────────────────────────┐
 browser ──SPA──►│ web/dist (static)                                                        │
 browser ──API──►│ api/ (Hono): auth, accounts, targets, items, reviews, outputs, settings  │
 browser ◄─SSE───│ events/ : typed bus → SSE                                                │
                 │ scheduler/ : per-target polling, backoff, rate-limit aware              │──► GitHub REST/GraphQL
                 │ jobs/ : SQLite queue, per-account concurrency, stages, cancel           │
                 │ engine/ : modes, profiles, chunking, verification, verdict             │──► provider adapters
                 │ providers/ : claude-cli | anthropic-api | …                             │     (claude CLI, Messages API)
                 │ outputs/ : panel | pr-comment | pr-review | check-run | notify | export │──► GitHub, webhooks
                 │ store/ : migrations, repositories, encrypted secrets                   │──► SQLite (WAL) on PVC
                 └───────────────────────────────────────────────────────────────────────────┘
                                   │ repo-aware mode only
                                   ▼
                 ┌─ runner (k8s Job) ─────────────────────────────────────────┐
                 │ repo checkout at head sha, claude with Read/Grep/Glob      │──► Anthropic only (egress policy)
                 │ no tokens, no network except the model API, time-boxed    │
                 └────────────────────────────────────────────────────────────┘
```

## Module layout

```
src/
  main.ts                 boot: migrate, load settings, start api + scheduler + workers
  api/                    Hono app: routes/, middleware/ (auth, csrf, errors), dto/ (typebox)
  events/                 Bus<EventMap>, sse.ts
  store/                  db.ts, migrate.ts, migrations/NNNN_*.sql, repos/*.ts (one per table group), secrets.ts (AES-GCM)
  accounts/               github identity, credential validation, device flow
  providers/              Provider interface, claude-cli/, anthropic-api/, catalog.ts (models)
  github/                 client.ts (fetch, rate limits, pagination, GraphQL), search.ts, pulls.ts, diff.ts (parse)
  targets/                target types, discovery per type → items
  scheduler/              per-target timers, backoff, limits probes
  jobs/                   queue.ts, worker.ts (stages, cancel), publish.ts
  engine/                 modes/ (one folder each), profile.ts, chunk.ts, prepare.ts, verify.ts, verdict.ts, markers.ts, prompt/
  outputs/                renderers + senders
  settings/               typed settings with defaults, stored in `settings`
web/                      Vue app (Vite): src/{pages,components,api,stores,styles}
tests/                    unit/, api/ (server against temp DB), e2e/ (Playwright)
```

## Decisions

| Topic | Decision | Why, and what would change it |
|---|---|---|
| Runtime | **Bun** stays | `bun:sqlite`, `Bun.spawn`, `Bun.password`, single binary image. Nothing pushes toward Node. |
| HTTP framework | **Hono** | `Bun.serve` with hand-written `if` routing is already 160 lines for 8 routes; v2 has ~40. Hono is small, Bun-native, has middleware and typed validators (`@hono/typebox-validator` keeps typebox, already a dependency). |
| Realtime | **SSE stays; no WebSockets** | Everything the UI needs is server→client (events, job progress, limits). Actions are plain `POST`s. SSE reconnects for free, works through Traefik, needs no auth upgrade dance. Adopt WebSockets only if a feature needs client→server streaming (live-editing a prompt against a running model, collaborative cursors). Token-by-token streaming of model output, if ever shown, is still server→client — SSE. |
| Database | **SQLite + WAL stays**, with migrations | One writer process; reads are small; tens of thousands of reviews fit. Postgres only when the process is split across nodes. |
| Frontend | **Vue 3 + TypeScript + Vite + Tailwind v4 + vue-router** | The owner's choice and a good one: the panel is already past what string templates can carry. Pinia is not needed at first — module-level `reactive()` stores in `web/src/stores` cover a one-user SPA; add Pinia if devtools/time-travel are wanted. Headless primitives from `reka-ui` (dialog, popover, select, tabs) so the design stays ours; icons `lucide-vue-next`. |
| Design system | **Terminal, dark only** (decided 2026-10-03) | Tokyo Night palette, JetBrains Mono self-hosted, bracket buttons, prompts, ASCII bars, glyphs, scanlines — after the owner's `pms`. One theme means no `dark:` variants and a clean CSP. Spec in 06; the v1 look is retired with `panel.html`. |
| GitHub access | **REST + GraphQL via `fetch`**, `gh` only for dev | Per-account clients with their own token, rate-limit headers read on every response (feeds the quota meters), conditional requests where supported, GraphQL for "PR with review requests, labels, files, checks" in one call. The unified diff comes from `GET /repos/{o}/{r}/pulls/{n}` with `Accept: application/vnd.github.diff` (and `/compare/{base}...{head}` for compare targets), so `parse_diff.ts` is unchanged. Removes the `gh` binary from the image. |
| Model providers | **Adapter interface**, two built in | `claude-cli` (subscription token, what runs today) and `anthropic-api` (API key, direct Messages API with a tool-use schema; gives explicit model ids, effort, per-token cost). Interface: `review(input, options) → {findings, usage, limits?}` plus `probe()` and `catalog()`. Others (OpenRouter, Bedrock, Vertex) are adapters someone can add; none are planned. |
| Secrets at rest | **AES-256-GCM with a master key from env** | Tokens become rows, so the DB (and its backups) must not leak them. One secret stays outside the DB: `MASTER_KEY` (32 bytes, base64). Each secret row: `key_id`, `iv`, `ciphertext`, `aad` = row purpose. Rotation = new key id, re-encrypt in a migration command. |
| Panel auth | **Login + session cookie, invite-only users** | `users` with `role` (admin/member), password hashed with `Bun.password` (argon2id), session id in an HttpOnly, Secure, SameSite=Strict cookie; CSRF by Origin check (already) plus a required `X-Requested-With` header on mutations; login rate limit. New users only through admin invites (phase 4); TOTP optional later. Basic auth is gone once this ships. |
| Jobs | **SQLite queue, in-process workers** | `reviews` rows are the queue (`queued → running → done|error|cancelled`). Concurrency: 1 per provider credential (the subscription window is the bottleneck), N global. Cancellation of a running review kills the provider process via `AbortSignal`. Restart recovery as today. |
| Scheduler | **Per-target timers** | Interval per target (default 60 s for searches, 30 s for a single PR being watched), exponential backoff on 403/429, GitHub `X-RateLimit-*` headers respected, Claude limits probed every 30 min as today. |
| Repo-aware runner | **Separate container, k8s Job per review** | The only mode where the model reads files, so the only place prompt injection can reach a filesystem. Requirements in 07. Phase 4. |
| Configuration | **Everything in the DB except bootstrap, per user** | Env: `MASTER_KEY`, `DATA_DIR`, `PORT`, `PUBLIC_URL`. Settings are rows keyed by user (instance-wide ones under the empty user). First boot with an empty DB shows a setup page (admin password); an importer takes v1's `config.json` + env tokens so the current deployment migrates in place. |
| Tests | **Three layers** | `bun test` unit (engine, renderers); API tests boot the Hono app with a temp DB and fake provider/GitHub clients; Playwright against a seeded instance for the main flows. |

## Boundaries worth keeping sharp

- `engine/` knows nothing about GitHub or HTTP: input is a `ReviewInput` (diff text or
  repo path, context, profile), output is a `ReviewResult`. This is what keeps
  compare/patch/GitLab targets cheap.
- `providers/` know nothing about findings semantics: they take a prompt + schema and
  return parsed JSON + usage.
- `outputs/` take a stored `ReviewResult` + item + account and render/send. The only
  module allowed to write to GitHub besides `accounts/` (token validation).
- `web/` talks only to `api/` over typed DTOs generated from the typebox schemas.

## Migration from v1

1. Phase 0 ships the migration runner with `0001_v1_baseline.sql` reproducing the
   current tables, so the existing volume is adopted as-is.
2. Phase 1's first boot imports `config.json` and `GH_TOKEN_*` / `CLAUDE_TOKEN_*` from
   env into `accounts` / `credentials` (encrypted) when those tables are empty, then
   logs that the env variables can be removed.
3. `jobs` rows become `reviews`; `prs` rows become `items` under two auto-created
   `search` targets per account (the current qualifiers), so history survives.
