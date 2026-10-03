# 08 · Roadmap

Sizes: **S** = one session (a few hours), **M** = 2–3 sessions, **L** = a week of
sessions. Each phase ends deployable; v1 keeps working until phase 1 replaces the
panel. Versions: today is v1.x; phase 1 ships v2.0.

```
phase 0  foundations ──► phase 1  web-managed accounts & targets ──► phase 2  modes, profiles, providers
                                                                  └─► phase 3  outputs & workflow ──► phase 4  repo-aware, App, team
```

## Phase 0 · Foundations (M)

Goal: the code can grow without rewrites; nothing user-visible changes.

Deliverables
- Migration runner + `0001_v1_baseline.sql`; existing volume adopted unchanged.
- Hono app replacing the hand-written router; same endpoints, same panel.
- `store/secrets.ts` (AES-GCM, `MASTER_KEY`), `settings` table, typed settings.
- Login + sessions replacing Basic auth; setup page on an empty `users` table; the
  current `PANEL_PASSWORD` imported as the first user's password on first boot.
- Module layout from 03 applied to the existing code; `Runtime` object instead of
  module-level maps; `cancelJob` moved to `jobs/`.
- API integration test harness (temp DB, fake provider, fake GitHub).
- Multi-user discipline from the start: `users.role`, `user_id` on every new table,
  repository functions take a user; one admin user for now.
- Open-source prep from 09: `config.example.json`, deploy scripts parametrised,
  LICENSE, neutral README, secret scan.
- Debt list from 01 closed.

Acceptance: `bun test` green with the new harness; login works; `deploy.sh` rolls it
out; the panel behaves exactly as before.

Implements: 03 (decisions on Hono, secrets, auth, migrations, tests).

## Phase 1 · Web-managed accounts and targets (L) → v2.0

Goal: no more `config.json`, no more `kubectl` for tokens; targets beyond the two
qualifiers; the Vue panel.

Deliverables
- `accounts`, `credentials`, `targets`, `items` tables; importer from v1 config/env.
- GitHub client over `fetch` (REST + GraphQL, rate-limit headers, pagination);
  `gh` removed from the image.
- Accounts page: add by token, validate, scopes, defaults; credentials: paste +
  probe (`claude-cli` provider only in this phase).
- Target types `search`, `repo`, `pr` (by URL) with filters and `manual` /
  `auto-review` automation (`auto-post` lands in phase 3 with the audit log).
- Scheduler per target with backoff; items persisted with lifecycle.
- Vue SPA in the terminal style (06): Overview, Inbox, Item, Review drawer, Targets,
  Accounts, Login, Setup; self-hosted JetBrains Mono; terminal components. Feature
  parity with the v1 panel plus the new pages; `panel.html` deleted.
- Playwright smoke: login → add account (fake) → add target → review (fake
  provider) → post (fake GitHub).

Acceptance: a fresh deployment is configured entirely from the browser; the
current two accounts migrate without re-entering tokens; the old panel's flows all
exist in the SPA.

Implements: 05 (accounts/credentials/targets/items, auth), 06 (pages marked), 03
(GitHub client, Vue stack).

## Phase 2 · Modes, profiles, providers (L)

Goal: the engine becomes a registry; several ways to review; more models.

Deliverables
- `Mode` interface; `diff-triage` ported; `security-audit`, `intent-check`,
  `summary`, `custom` added.
- Profiles (table, versioning, options form generated from mode option schemas,
  prompt preview).
- Chunking with merge; budget per model; `runs` table.
- Provider interface with `claude-cli` as the only adapter; model catalog with
  settings override; effort mapping; API-price estimate per run. (`anthropic-api`
  adapter deferred to "by demand", see 09.)
- Marker v3 for absence findings; `PROMPT_VERSION` bump.
- Profiles page; model/profile pickers everywhere a review starts.
- Insights v1: cost, latency, categories (Activity page).

Acceptance: a 60-file PR is reviewed in chunks with no "Not reviewed" tail due to
budget; the same PR reviewed with `security-audit` and `diff-triage` produces two
comparable reviews; a review with an explicit model id (`claude-opus-5-5`) runs and
shows its API-price estimate.

Implements: 04 (modes, providers, chunking, markers), 05 (profiles, runs).

## Phase 3 · Outputs and workflow (M–L)

Goal: more than one way to publish; reviews that build on each other.

Deliverables
- `outputs` and `audit` tables; `pr-review` output (inline comments) with the
  "this clears your review request" notice; `notify` output (webhook, Slack,
  Telegram); export.
- Templates per output.
- Incremental reviews (since last sha; fixed / still open / new), dismissals.
- `compare` and `patch` targets; `auto-post` automation with its safeguards.
- Device-flow `[ connect with github ]` (once the OAuth App exists).
- Retention job: code excerpts purged after 90 days (per-user setting).
- Review comparison view; queue priorities; cancel a running review.
- Activity page with the audit log first.

Acceptance: every GitHub write appears in the audit log with a link; an incremental
review of a PR with one fix shows that finding as fixed and posts a comment with the
three groups; a pasted patch gets a review without any GitHub access.

Implements: 04 (incremental, outputs), 05 (outputs, audit, dismissals), 07 (audit,
auto-post safeguards).

## Phase 4 · Repo-aware reviews, GitHub App, team (L+)

Goal: depth and reach. Each item here is independent; order by demand.

- Repo-aware runner: checkout cache, k8s Job runner image, NetworkPolicy, time box,
  `repo-aware-triage` and `test-gaps` modes. Needs the controls in 07 first.
- GitHub App: installation flow, webhooks replacing polling for installed repos,
  `check-run` output, optional bot identity for posting.
- Colleagues (first in this phase): invites, `/admin/users`, admin load view,
  cross-user access tests, onboarding hints; everything else already per-user.
- `anthropic-api` provider adapter, when a second model path is wanted.
- GitLab adapter (accounts, MR items, note output).
- Thin CLI client for local diffs (`patch` target over the API).
- TOTP; master key rotation command; retention jobs.

## What is deliberately not scheduled

- WebSockets (no feature needs them; see 03).
- Postgres (single node).
- Auto-fix / pushing commits.
- A public SaaS (decided 2026-10-03).

## Working agreements

- Each phase starts by re-reading its spec sections and updating them where the
  code disagrees; the spec is the contract, the code is the truth, and they are
  reconciled at phase end.
- `docs/` (outside `plan/`) is rewritten per phase to describe what runs.
- The owner's two rules stay in `CLAUDE.md` for every phase: nothing reviews without
  a press unless a target explicitly opted in; nothing posts without a press unless
  a target explicitly opted into `auto-post`.
