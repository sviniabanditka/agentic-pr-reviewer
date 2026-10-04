# Changelog

Newest first.

---

# 2026-10-04 — new panel design (Graphite)

- Dark-only redesign: icon rail, Geist type, violet accent; the terminal look is gone.
- The inbox is the home page: list with status chips and filters, the review opens on the
  right; the separate overview and PR pages are gone (old links redirect).
- ⌘K palette for pages, pull requests and actions; buttons for everything it does.
- Post as a split button (comment or inline review); Review again, Export and History
  menus; dismiss per finding; first-run checklist; Add dialog for PR / compare / patch.

---

# 2026-10-03 — v2 phase 4 (part 1): colleagues, CLI, API keys

- Colleagues: admin invite links (7 days, one use), admin page with per-user load
  (no repositories, titles or findings), disable / role / reset two-factor.
- Two-factor sign-in (TOTP), password change (ends other sessions).
- Personal API tokens and `apr`, a command-line client that reviews a local diff.
- `anthropic-api` credentials: reviews over the Messages API with an API key.
- Master key rotation via `MASTER_KEY_OLD`.
- Migration 0006.

---

# 2026-10-03 — v2 phase 3: outputs, incremental reviews, compare and patch

- Post a review as the marked comment or as a GitHub review with inline comments
  (always `COMMENT`); export as Markdown or JSON. Every GitHub write and credential
  change lands in an audit log (Activity → audit).
- Incremental reviews: only the commits since the last review go to the model; earlier
  findings are re-checked against the whole PR and shown as still open or fixed.
  Automatic reviews of an already reviewed PR are incremental.
- Compare ranges and pasted patches as items; reviewed and exported, never posted.
- Dismiss a finding: it stops blocking and leaves the comment, for later reviews too.
- Cancel a running review; manual reviews jump ahead of automatic ones.
- `auto-post` target automation, turned on by typing the account login.
- Notifications to Slack, Telegram or a webhook; per-user retention of findings
  (default 90 days); GitHub device login when an admin sets an OAuth client id.
- Migration 0005.

---

# 2026-09-30 — reviews stay private until posted

- A finished review is only stored and shown in the panel; nothing is written to the
  PR until **Post** is pressed (and confirmed with a second click).
- `POST /api/jobs/:id/publish` posts or edits the PR comment; earlier reviews of that PR
  lose their `comment_url`. The pipeline strip drops its "post comment" step.
- Panel: **Post** in the PR list, **Posted / Not posted** tags, a notice in details
  when the PR has moved past the reviewed commit.

---

# 2026-09-30 — panel redesign

- New panel: light/dark themes (IBM Plex), account cards with Claude 5-hour and 7-day
  usage and GitHub API quota, a live progress strip for the running review, a queue
  with cancel, filters (All / To review / Mine, account, status, text search with `/`),
  review details in a slide-over (Esc, ×, click outside, `#job/<id>` links), toasts,
  optional browser notifications, per-PR model choice remembered.
- `claude` runs with `--output-format stream-json` to read `rate_limit_event`; limits
  are also checked on start, every 30 minutes and on demand (`POST /api/limits`).
- `POST /api/jobs/:id/cancel`, `stage` SSE events, GitHub `rate_limit` per poll.

---

# 2026-09-30 — self-hosted, on-demand reviewer

Replaces the Cloudflare Worker + local CLI with a Bun daemon in k3s.

- **Model**: Claude Code CLI (`claude -p --tools "" --json-schema`) on your own Claude
  subscription instead of OpenRouter. Structured output replaces the
  `submit_findings` tool call; `PROMPT_VERSION` → `v6`; the prompt now states that PR
  text is data, not instructions.
- **GitHub**: the `gh` CLI with a per-account token (`GH_TOKEN_<NAME>`); several
  accounts at once (e.g. personal + work).
- **On demand**: the poller lists open PRs (review requested, authored) every 30 s;
  a review runs only from the panel's Review button, with a model picked per PR.
- **Output**: one PR comment per account, headed `🤖 Agentic PR Reviewer` with commit,
  model and time, edited on re-review. Inconclusive runs post nothing.
- **Panel**: open PRs, queue, review history with findings, live log over SSE, Basic
  auth, same-origin JSON POSTs.
- **State**: SQLite on a PVC (jobs, events, PR state, 24 h verdict cache) instead of
  Workflows, Durable Objects, KV and D1.
- **Removed**: session delta and `/ack` (no merge gate from a personal account), the
  local `triage` CLI.
- Deploy: `scripts/deploy.sh`, `scripts/set-secret.sh`, `k8s/`; panel at
  `review.sviniabanditka.com`.

---

# feat(review): INTENT — checking the author's claim against the diff

touches: review request, finding, review prompt, verdict cache, local diff, review command, review output

> ⚠️ **Contract** `ReviewRequestSchema`: `{files, context, sessionKey?}` → `+intent?: string` — optional, older clients keep working
> ⚠️ **Contract** `FindingSchema.category` / `CATEGORIES`: six categories → `+INTENT`, not in `BLOCKING_CATEGORIES`
> ⚠️ **Contract** CLI: `triage [range] [--staged] [--session <key>]` → `+[--intent <path>]`

The worker receives the author's claim (commit bodies or an `--intent` file) and, in the
same run as the bug hunt, reports gaps between the claim and the diff as `INTENT`
findings. They are visible but never hold a merge and never trigger the confirmation
run. The verdict cache key now includes the intent; prompt version v5, so older
verdicts are not reused.

Tests: `tests/api/verdict_cache.test.ts` (new), `tests/verdict/verdict.test.ts` (new),
`tests/cli/diff/local_diff.test.ts`.

**Assumptions:**
- The `--intent` file fits the model context together with the diff; there is no size limit on intent.
- Under a strict JSON schema the model returns `INTENT` from the extended union as reliably as NICHE; accuracy on prose about intent was not measured.
