# 07 · Security

v2 stores tokens that can write to every repository the owner can reach, and one mode
lets a model read code written by strangers. Both raise the stakes compared to v1.

## Assets

1. GitHub tokens (repo write on personal and employer repositories).
2. Claude subscription tokens and API keys (billable; the subscription token is tied
   to a personal or corporate account).
3. Private source code passing through the system and its SQLite file.
4. The owner's GitHub reputation: everything posted appears under their name.

## Adversaries and controls

### A hostile pull request author (prompt injection)

Text in the PR body, commit messages, comments and code reaches the model.

- Diff modes: the model has no tools and no network beyond the provider; the worst
  case is a misleading finding. Controls: verbatim evidence check, low-confidence
  bucket, the "PR text is data" prompt section, and a human reading the result
  before Post. Keep.
- Repo-aware mode: the model can read files. Controls required before shipping:
  - runs in a separate container (k8s Job) with the worktree mounted read-only at
    one path and `--add-dir` limited to it; `--allowedTools "Read,Grep,Glob"`, all
    else disallowed, `--disallowedTools "Bash,Edit,Write,WebFetch,WebSearch,mcp__*"`,
    `--strict-mcp-config` with an empty config;
  - no secrets in the runner's environment except the provider credential, which
    is scoped to that one run where the provider allows it; GitHub tokens never
    enter the runner;
  - NetworkPolicy: egress only to the model API hosts; no cluster DNS beyond that;
  - CPU/memory/time limits; the daemon kills the Job at the time box;
  - the runner writes its result to a file the daemon parses with the same schema
    check; nothing else from the runner is trusted;
  - `.agentic-review.md` from the repo is injected as author-controlled data with a
    size cap and the same "data, not instructions" framing.
- Posting is still a human action. `auto-post` targets are the one exception; the
  UI makes enabling it deliberate and the audit log records every post.

### Someone reaching the panel

- Login with argon2id-hashed password, session cookie `HttpOnly; Secure;
  SameSite=Strict`, absolute and idle expiry, login rate limiting (per IP and per
  login), optional TOTP.
- CSRF: Origin/Referer check on every mutation plus a required custom header; the
  SPA sends both; forms from other origins cannot.
- Secrets are write-only in the API: a token is never returned after it is stored;
  the UI shows a fingerprint (last 4) and the validation result.
- No tokens in URLs or query strings; no tokens in logs (the `gh`/`fetch` wrappers
  redact `Authorization`).
- Security headers: CSP (`default-src 'self'`, fonts allowed from Google Fonts or
  self-hosted — prefer self-hosting the two Plex families), `frame-ancestors 'none'`,
  `Referrer-Policy: same-origin`.

### A stolen database, backup or volume

- `secrets` rows are AES-256-GCM ciphertext with the key only in `MASTER_KEY`
  (k8s Secret). The SQLite file alone yields no tokens.
- `MASTER_KEY` rotation: `bun run rotate-key --new <key>` re-encrypts every row under
  a new `key_id`; both keys present during the run; the old one removed after.
- Backups of the volume are therefore safe to keep encrypted-at-rest by the storage
  only; the plan still recommends not shipping them off-host unencrypted.
- The result JSON contains code excerpts; retention settings let the owner purge
  reviews older than N days.

### The owner's own mistakes

- `auto-post` requires typing the account login to enable and shows a persistent
  badge on the target.
- Posting from a work account to a repository outside the configured owners asks
  for an extra confirmation.
- Every GitHub write is one row in `audit` with the account, item, review, output
  id and external URL; the Activity page lists them first.
- Token scope guidance in the UI: fine-grained tokens with `pull_requests: write`,
  `contents: read`, `metadata: read` where the owner controls the repos; classic
  `repo` only when needed (org SSO), with the warning that it is full write.

### Colleagues on the same instance

- Every owner-scoped table carries `user_id`; repository functions take the user and
  filter by it — there is no "list all" without a user. API tests include a
  cross-user access check for every resource (user B requests user A's id → 404).
- Admin role: manage users and invites, see instance load (queue, per-user limit
  percentages). Admins never see other users' accounts, tokens, items, reviews or
  audit rows; there is no impersonation.
- Credentials are per user and never shared across users; a review runs with the
  requesting user's credential only.
- Invite tokens are random, stored hashed, single-use, expire in 7 days.
- Policy: each colleague adds their own `claude setup-token`; see the note in 09 about
  confirming this with the corporate plan admin.

## Token handling rules (enforced in code review)

1. Only `store/secrets.ts` decrypts; it returns a value scoped to one call and never
   stores plaintext on long-lived objects.
2. Provider processes get exactly one credential in their environment.
3. GitHub clients are constructed per request from a decrypted token and dropped.
4. Logs, events and errors pass through a redactor before storage.
5. Tests include a grep-style check that no `ghp_`, `github_pat_`, `sk-ant` or
   `oauth` literal appears in fixtures or snapshots.
