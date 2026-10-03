# 05 · Data model and API

## Schema (SQLite, migrations in `src/store/migrations/`)

All ids are text ULIDs except where noted; timestamps are epoch ms integers.
`user_id` exists on owner-scoped tables from day one so multi-user needs no
migration later; v2 has one user.

```
users              id, login, password_hash, role ('admin'|'member'), disabled, totp_secret_id?, created_at
invites            id, token_hash, created_by, role, expires_at, used_by?, used_at
sessions           id, user_id, created_at, expires_at, ip, user_agent
secrets            id, key_id, iv, ciphertext, aad, created_at            -- encrypted blobs, referenced by id
accounts           id, user_id, kind ('github'|'gitlab'), login, display_name, token_secret_id,
                   scopes, status ('ok'|'invalid'|'sso_required'|'rate_limited'), checked_at, created_at
credentials        id, user_id, provider ('claude-cli'|'anthropic-api'|…), label, secret_id,
                   status, limits_json, checked_at, created_at
account_defaults   account_id PK, credential_id, profile_id, output_ids_json
profiles           id, user_id, name, mode, options_json, version, is_default, created_at, updated_at
targets            id, user_id, account_id, type ('search'|'repo'|'pr'|'compare'|'patch'),
                   params_json, filters_json, automation ('manual'|'auto-review'|'auto-post'),
                   profile_id?, poll_sec, enabled, last_polled_at, last_error, created_at
items              id, target_id, account_id, kind ('pr'|'compare'|'patch'), repo, number?, title, url,
                   author, author_is_bot, role, head_sha, base_sha, updated_at, state ('open'|'closed'|'merged'|'archived'),
                   data_json (labels, draft, size…), first_seen_at, last_seen_at
reviews            id, item_id, account_id, credential_id, profile_id, profile_version, mode,
                   head_sha, base_sha, kind ('full'|'incremental'), parent_review_id?,
                   status ('queued'|'running'|'done'|'error'|'cancelled'), stage, priority,
                   created_at, started_at, finished_at, error,
                   verdict_json, counts_json, usage_json, result_json
runs               id, review_id, purpose ('review'|'confirm'|'chunk'), chunk_index, model, started_at, finished_at,
                   outcome, usage_json, cost_usd, error
findings           id, review_id, marker, category, file, line_start, line_end, evidence_kind,
                   evidence, claim, detail, evidence_check, blocking, confirmed, state ('new'|'still_open'|'fixed'|'dismissed')
dismissals         item_id, marker, note, user_id, created_at                 -- PK (item_id, marker)
outputs            id, review_id, type, status ('pending'|'sent'|'failed'), external_id, external_url,
                   payload_json, error, created_at, sent_at
audit              id, user_id, account_id?, action ('post_comment'|'post_review'|'token_added'|…),
                   subject, details_json, created_at
events             id, ts, level, review_id?, account_id?, msg            -- as today, 14-day retention
settings           user_id, key, value_json, updated_at                     -- PK (user_id, key); user_id '' = instance
cache              key PK, result_json, created_at                         -- verdict cache, 24 h
schema_migrations  version PK, applied_at
```

Indexes: `items(target_id, state)`, `items(repo, number)`, `reviews(status, priority, id)`,
`reviews(item_id, id)`, `findings(review_id)`, `findings(marker)`, `events(review_id)`,
`audit(created_at)`.

Why `findings` as rows and not only JSON: dismissals, incremental carry-over, insights
and "all SEC-AUTHZ findings this month" all need them queryable. `result_json` keeps
the full stored result for rendering, as today.

## API v1

Base `/api/v1`. JSON in and out, cookie session, `X-Requested-With: fetch` required on
mutations, same-origin check as today. Errors: `{ error: { code, message, details? } }`.
Lists: `?limit=&cursor=` with `nextCursor` in the body.

### Auth and setup
```
GET  /setup                         → { needsSetup }            (empty DB)
POST /setup                         { login, password }         (only while needsSetup)
POST /auth/login                    { login, password }         → session cookie
POST /auth/logout
GET  /auth/me
POST /auth/invites/:token/accept  { password }                   → session cookie (invite flow)

GET/POST   /admin/users              (admin) list, disable/enable, change role
GET/POST   /admin/invites            (admin) create → { url, expiresAt }; list; DELETE /admin/invites/:id
GET        /admin/load               (admin) queue length, running reviews, limits per user (no values)
```

### Accounts and credentials
```
GET    /accounts
POST   /accounts                    { kind, token }             → validates, stores encrypted, returns account
POST   /accounts/github/device      → { userCode, verificationUri, pollToken }   (device flow start)
GET    /accounts/github/device/:pollToken  → { status: 'pending'|'done'|'expired', account? }
PATCH  /accounts/:id                { displayName?, defaults? }
POST   /accounts/:id/check          → status, scopes, rate limit
DELETE /accounts/:id

GET    /credentials
POST   /credentials                 { provider, label, secret }  → probe, store, return health
POST   /credentials/:id/check
DELETE /credentials/:id
GET    /providers                   → catalog per provider (models, options)
```

### Profiles
```
GET/POST   /profiles
GET/PATCH/DELETE /profiles/:id      (PATCH bumps version)
GET    /modes                        → mode descriptors (id, input, categories, option schema)
POST   /profiles/:id/preview         { itemId } → the exact prompt that would be sent
```

### Targets and items
```
GET/POST   /targets
GET/PATCH/DELETE /targets/:id
POST   /targets/:id/poll             → runs discovery now
GET    /items?targetId=&state=&q=&role=&accountId=
GET    /items/:id                    → item + reviews summary + dismissals
POST   /items                        { type: 'pr', url } | { type: 'compare', repo, base, head } | { type: 'patch', name, diff }
POST   /items/:id/archive
```

### Reviews
```
POST   /reviews                      { itemId, profileId?, overrides?, kind?: 'full'|'incremental' } → 202 { id }
GET    /reviews?itemId=&status=&accountId=&q=
GET    /reviews/:id                  → review + runs + findings + events
POST   /reviews/:id/cancel           (queued: drop; running: abort the provider call)
POST   /reviews/:id/outputs          { type, templateOverrides? } → 202 { outputId }   (the only GitHub write)
GET    /reviews/:id/export.md | .json
POST   /items/:id/dismiss            { marker, note }
DELETE /items/:id/dismiss/:marker
GET    /reviews/:id/diff/:otherId    → finding-level comparison
```

### System
All list and detail endpoints return only rows whose `user_id` is the session's user;
admins get the `/admin/*` routes above and nothing else extra.
```
GET    /state                        → accounts health, limits, queue summary, running stages, totals  (SPA bootstrap)
GET    /events                       SSE
GET    /audit?limit=
GET    /insights/summary?range=24h|7d|30d
GET/PATCH /settings
GET    /healthz                      (no auth)
```

### SSE events

| Event | Payload |
|---|---|
| `review` | review summary row on every status/stage change |
| `run` | run row when a model call starts/ends (progress for chunks) |
| `item` | item row when discovered, updated (new head), closed |
| `account` | account/credential health and limits |
| `output` | output row on sent/failed |
| `log` | event row |
| `hello` | server start time and schema version, sent on connect (client reloads state if it changed) |

## Compatibility with v1 clients

None needed: the only client is the panel, which ships with the server. The v1
endpoints are removed once the SPA replaces `panel.html` (phase 1).
