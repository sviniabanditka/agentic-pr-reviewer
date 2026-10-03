# 01 · Assessment of v1

## What exists

About 2,600 lines of TypeScript and one 970-line HTML panel, running as one Bun
process in k3s with SQLite on a volume.

| Area | Today | Where |
|---|---|---|
| Accounts | Two, from `config.json`; tokens from env (`GH_TOKEN_*`, `CLAUDE_TOKEN_*`) set with `kubectl` through `scripts/set-secret.sh` | `src/config.ts` |
| Targets | Two GitHub search qualifiers per account: `review-requested:@me`, `author:@me`, filtered by `owners` | `src/poller.ts` |
| Discovery | Poll every 30 s, lists kept in memory, head sha cached in `prs` | `src/poller.ts` |
| Review | One mode: diff-only, `claude -p --tools ""`, strict JSON schema, evidence check, second run for blocking findings, 24 h verdict cache | `src/review/*`, `src/worker.ts` |
| Models | Aliases from `config.models`, picked per PR in the panel | `src/config.ts`, panel |
| Output | One PR comment per account, created or edited only on Post | `src/worker.ts#publishJob`, `src/github/comment.ts` |
| Panel | Vanilla JS, string templates, SSE, Basic auth | `src/panel.html`, `src/server.ts` |
| Limits | Claude 5h/7d from `rate_limit_event`, GitHub quota per poll | `src/review/claude.ts`, `src/poller.ts` |
| State | 4 tables (`prs`, `jobs`, `events`, `cache`), `CREATE TABLE IF NOT EXISTS` | `src/db.ts` |
| Tests | 58 unit tests on the pipeline and renderers; nothing on HTTP or UI | `tests/` |

## What holds up

Keep these as they are; they are the product's core and are already tested.

- **The review pipeline's shape.** Diff budget → rendered hunks with new-side line
  numbers → model with a strict schema → verbatim evidence check → confirmation run
  for anything blocking → verdict. Every later mode should plug into this shape, not
  replace it.
- **Explicit over automatic.** Nothing is reviewed without a press, nothing reaches
  GitHub without a second press. This was learned the hard way (five unwanted
  comments in work PRs on 2026-09-30) and must survive every redesign as a default.
- **Model isolation.** `--tools ""`, a from-scratch environment, no GitHub token near
  the model process. Repo-aware modes relax the first point and therefore need a
  sandbox (see 07).
- **One comment per PR and account**, found by marker, edited in place.
- **Markers as finding identity**, hashed from quoted code rather than prose.

## What has to change

| Area | Problem | Direction |
|---|---|---|
| Configuration | Adding an account means editing a file, running two scripts and a rollout. Tokens live in a k8s Secret the web cannot touch. | Accounts, credentials and targets become rows in SQLite; secrets encrypted at rest with one master key from the environment. The web is the only editor. |
| Accounts | Hard-wired to "one GitHub login + one Claude token". | Account = GitHub identity; credentials for model providers attached separately; several providers per account. |
| Targets | Two hardcoded qualifiers. No way to watch a repo, add a PR by URL, review a branch or a pasted patch. | Target objects with a type (`search`, `repo`, `pr`, `compare`, `patch`, later `gitlab-mr`), filters, polling settings and an opt-in automation level. |
| Discovery | Lists are in memory; a restart empties the panel until the next poll; nothing remembers a PR after it closes. | `items` table with lifecycle (open → closed/merged), per target. |
| Worker | `runJob` is one 100-line function. Modes, outputs and providers have nowhere to plug in. | Mode registry with a declared contract (input kind, prompt, schema, tools, budget, confirmation policy); worker only orchestrates stages. |
| Diff budget | Files past 32k tokens are dropped silently ("Not reviewed" list). | Chunking into several runs with finding merge; budget per model. |
| Models | Three aliases, one provider (Claude Code CLI on a subscription). | Provider adapters (`claude-cli`, `anthropic-api`, pluggable), model catalog with context sizes and cost, effort/thinking settings. |
| Output | PR comment only. | Output renderers: PR comment, PR review with inline comments, check run (needs a GitHub App), panel-only, notifications, markdown export. |
| Workflow | Each review is independent; no delta between reviews of one PR. | Incremental review (since last reviewed sha), fixed/new/still-open tracking per item. |
| Panel | One HTML file, string templates, global state; already at the limit of what is pleasant to change. | Vue 3 SPA with Vite, Tailwind, typed API client. |
| Auth | Basic auth, one password, credentials sent on every request. | Login page, sessions, argon2id hash, CSRF protection; later TOTP. |
| Realtime | SSE, one direction. | Keep SSE. No WebSockets until something needs client→server streaming (see 03). |
| Schema | `IF NOT EXISTS`; no way to add a column safely. | Numbered migrations, `schema_migrations` table, run on start. |
| GitHub access | Shelling out to `gh` per call. Works, but hides rate-limit headers, needs the binary in the image, and makes GraphQL awkward. | REST/GraphQL via `fetch` with a per-account client. `gh` stays a dev convenience only. |
| Tests | Pipeline only. | API integration tests against a temp DB; Playwright smoke for the UI. |
| Observability | Event log in SQLite, shown in the panel. | Keep; add an audit log of every GitHub write, and per-review cost/latency series. |

## Debt to settle before building on top

Small items, each under an hour, best done in phase 0:

1. `cancelJob` is in `poller.ts`; move to a jobs module.
2. `accountStatus`, `openPrs`, `stages` are module-level maps; wrap in a `Runtime` object so tests can construct one.
3. Marker anchor for `absent` findings is the model's claim text; confirmation of absence findings is fragile (see 04 for the fix).
4. `config.models` validation lives in `loadConfig`; it belongs to the provider catalog.
5. `renderComment` hardcodes the header; outputs need templates.
