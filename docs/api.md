# HTTP API v1

Base path `/api/v1`, JSON in and out. Everything except `GET/POST /setup` and
`POST /auth/login` needs the session cookie (`apr_session`). Every non-GET request
must send `x-requested-with: fetch`; a foreign `Origin` gets `403`. Errors are
`{ "error": "sentence" }` with 400 (bad input), 401, 403, 404 or 409 (refused).

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/setup` | — | `{needsSetup}` |
| POST | `/setup` | `{login, password}` | Only while no user exists; creates the admin, signs in, runs the v1 import |
| POST | `/auth/login` | `{login, password}` | 10 failures per IP or login in 15 min → 429 |
| POST | `/auth/logout` | — | |
| GET | `/auth/me` | — | `{user: {id, login, role}}` |

## Overview

`GET /state` → `{user, startedAt, models, providers, accounts, credentials, targets, profiles, modes, categoryText, catalog, stages, totals}`
— the SPA's bootstrap. `stages` maps running review ids to `diff`/`review`/`confirm`;
`totals` covers the user's finished reviews of the last 24 h.

## Accounts and credentials

| Method | Path | Body |
|---|---|---|
| GET | `/accounts` | |
| POST | `/accounts` | `{token, label?}` — checked with `GET /user`, stored encrypted |
| PATCH | `/accounts/:id` | `{label?, credentialId?, model?, profileId?}` |
| PUT | `/accounts/:id/token` | `{token}` |
| POST | `/accounts/:id/check` | re-checks login, scopes, quota |
| DELETE | `/accounts/:id` | also removes its targets and items |
| GET | `/credentials` | |
| POST | `/credentials` | `{provider: "claude-cli", token, label?}` — probed; refused tokens are not kept |
| PATCH | `/credentials/:id` | `{label}` |
| POST | `/credentials/:id/check` | refreshes the 5-hour and 7-day usage |
| DELETE | `/credentials/:id` | |

An account: `{id, login, label, tokenHint, scopes, credentialId, model, status, statusDetail, checkedAt, github: {core, search}}`.
A credential: `{id, provider, label, tokenHint, status, statusDetail, limits: {fiveHour, sevenDay, checkedAt}, checkedAt}`.

## Targets

| Method | Path | Body |
|---|---|---|
| GET | `/targets` | |
| POST | `/targets/preview` | a target body → `{items: [first 20 matches]}`, nothing stored |
| POST | `/targets` | `{accountId, name, type, params, filters?, automation?, model?, profileId?, pollSec?, enabled?}` |
| PATCH | `/targets/:id` | any subset |
| POST | `/targets/:id/poll` | polls now |
| DELETE | `/targets/:id` | |
| POST | `/poll` | polls every enabled target of the user |

`type` and `params`: `search` → `{query, role?}` (qualifiers after `is:pr is:open archived:false`);
`repo` → `{repo: "owner/name"}`; `pr` → `{repo, number}`. `role` is `author`,
`review_requested` or `watching` (derived from the query when omitted).
`filters`: `drafts`, `bots` (include them; default no), `labelsInclude`, `labelsExclude`,
`authorsInclude`, `authorsExclude`, `owners` (never hides review requests),
`maxChangedFiles`. `automation`: `manual` or `auto-review` (review each new head sha; results stay private).

## Items

| Method | Path | Notes |
|---|---|---|
| GET | `/items?state=open\|closed\|all&accountId=&targetId=` | each with `lastReview` |
| GET | `/items/:id` | `{item, reviews}` |
| POST | `/items` | `{accountId, url}` — adds a PR by URL or `owner/repo#n` (a `pr` target is created) |
| POST | `/items/:id/archive`, `/items/:id/unarchive` | |

## Reviews

| Method | Path | Notes |
|---|---|---|
| GET | `/reviews?status=&itemId=&limit=` | summaries, newest first |
| GET | `/reviews/:id` | `{review, result, events, runs, stage}` |
| POST | `/reviews` | `{itemId, model?, profileId?}` → 202 `{id}`; 409 when the item or profile is unknown, the account has no credential, the model is not allowed, or a review is already queued/running |
| POST | `/reviews/:id/cancel` | queued only |
| POST | `/reviews/:id/publish` | `{url}`; the only endpoint that writes to GitHub |

## Profiles

| Method | Path | Body / notes |
|---|---|---|
| GET | `/profiles` | built-ins are created on first access |
| POST | `/profiles` | `{name, mode, options}` |
| PATCH | `/profiles/:id` | any subset; bumps `version` |
| POST | `/profiles/:id/default` | |
| DELETE | `/profiles/:id` | not the default; accounts and targets using it fall back to the default |
| POST | `/profiles/:id/preview` | `{itemId}` → `{system, user, chunks, tokens, skipped}` — the exact prompt for the first part |

`options`: `model`, `confirmation` (`blocking`/`never`), `categories`, `blocking`,
`budgetTokens` (4,000–150,000), `maxChunks` (1–20), `intent` (`pr-body`/`none`),
`instructions`, `customCategories` (`[{id, description}]`, custom mode).

## Insights

`GET /insights?days=7|30|90` → `{byModel, byProfile, byDay, categories, posted, confirmation}`
for the user's finished reviews.

## Logs and settings

`GET /logs?level=info|warn|error&limit=` · `GET /settings` → `{models}` ·
`PATCH /settings` `{models}` (admin).

## SSE: `GET /events`

| Event | Data |
|---|---|
| `hello` | `{startedAt}` — first message; a changed value means the server restarted |
| `log` | an event row |
| `job` | a review summary on every change |
| `stage` | `{jobId, stage}`; `null` when the review ended |
| `prs` | `{item}` — an item row was created or changed |
| `status` | `{credential}` or `{target}` after a check or poll |

Events carry a user id server-side; each stream only receives its own user's events.
