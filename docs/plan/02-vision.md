# 02 · Vision and ideas

## One sentence

A self-hosted review desk: it watches the code you care about across your GitHub
identities, reviews it with the model, mode and depth you pick, shows you the result
first, and publishes only what you approve — under your name, with evidence.

## Principles

1. **Explicit by default.** Discovery is automatic; reviewing and publishing are
   actions a person takes. Automation exists, per target, opted in, and the strongest
   level ("auto-post") stays behind a deliberate switch with a warning.
2. **Private until posted.** Every result is visible in the system before anywhere
   else. Nothing leaves without a Post.
3. **Evidence or nothing.** A finding quotes the diff or names the absent thing; what
   cannot be verified against the code never blocks and is shown as low confidence.
4. **Every write to GitHub is auditable.** Who, which account, which review, which
   comment, when — in one table and one view.
5. **Your credentials, your bill.** Subscriptions and API keys are the owner's own;
   the system never intermediates sign-in and never stores anything it cannot decrypt
   only with the owner's master key.
6. **Fast path first.** A diff-only review in ~20 s stays the default; deeper modes
   are chosen, not imposed.
7. **One person first, colleagues later, never a SaaS.** v2 serves one owner with
   several identities. Later the same instance hosts colleagues, each with their own
   GitHub accounts and their own Claude subscription, isolated from one another; an
   admin invites them and sees load, not reviews. Ownership on every row from day
   one makes that a feature, not a migration.
8. **It looks like a terminal.** Dark only, monospace, prompts and brackets, glyphs
   over icons — the owner's `pms` aesthetic (see 06).

## Who it is for

- **Now:** one developer with a personal and a work GitHub account and one or two
  Claude subscriptions, reviewing their own PRs before asking for review, and PRs
  they are asked to review.
- **Later:** colleagues on the same instance, each bringing their own GitHub
  accounts and their own Claude subscription (corporate or personal), seeing only
  their own data; a repository owner who wants a review check on every PR (GitHub
  App).

## Feature ideas by area

### Accounts and providers
- Add a GitHub account from the web: paste a token, or "Connect" via the GitHub
  device flow (server shows a code, you enter it on github.com, no paste).
- Attach model providers to an account: Claude Code subscription token (paste from
  `claude setup-token`, validated by a probe), Anthropic API key, later others. Show
  limits and spend per provider.
- Per-account defaults: model, profile, output, display name shown in comments.
- Health: token validity, scopes, SSO authorization state, expiry warnings.

### Targets (what gets reviewed)
- **Search**: any GitHub search qualifier set (`review-requested:@me`,
  `author:@me`, `team-review-requested:org/team`, `mentions:@me`, `involves:@me`,
  `repo:`, `org:`, `label:`, `-label:`, `draft:false`, `created:>…`).
- **Repository**: every open PR in a repo (needs nothing but read access).
- **Pull request**: one PR by URL, added by hand, reviewed once or tracked.
- **Compare**: `owner/repo` + `base...head` — branches, tags or commits, no PR needed.
- **Patch**: a pasted or uploaded unified diff with a name — code that is not on
  GitHub at all.
- Later: **GitLab MR**, **Bitbucket PR**, **local diff** through a thin CLI that
  posts to the API (the old `triage` CLI, resurrected as a client).
- Filters on every target: drafts, bot authors, labels, size (files, lines), paths
  include/exclude, age, authors allow/deny.
- Automation level per target: `manual` (list only), `auto-review` (review on new
  commits, keep in panel), `auto-post` (also publish; off by default, warning on
  enable).

### Review modes
- **Diff triage** (today): merge-holding defects + comment slop + intent gaps.
- **Security audit**: only SEC-AUTHZ / GUARD-REMOVED / IRREVERSIBLE / secrets /
  injection classes, higher recall, always a confirmation run.
- **Intent check**: PR description vs diff only.
- **Repo-aware triage**: same categories, but the model can read the repository
  (checked out at the head sha) to verify a missing guard really is missing.
  Slower, sandboxed.
- **Summary**: a PR description or changelog entry from the diff.
- **Test gaps**: what changed without a test touching it.
- **Nit sweep**: style and naming — off by default, for people who want it.
- **Custom**: user-written prompt profile on top of the diff/repo input and the
  finding schema.
- Mode options: model, effort/thinking, confirmation policy (never / blocking only /
  always), budget, chunking, categories enabled, blocking set.

### Outputs
- Panel only (default), PR comment (today), PR review with inline comments, check
  run with status (needs a GitHub App), Slack/Telegram/webhook notification,
  Markdown/JSON export, copy-as-markdown.
- Templates: header text, which sections to include, collapse rules.

### Workflow
- Incremental review: on new commits review the delta, carry over unchanged findings,
  mark fixed/new/still open.
- Compare two reviews of the same PR (different model or mode).
- Dismiss or accept a finding with a note; dismissed findings do not come back.
- Queue with priorities and per-account concurrency; cancel a running review.
- Scheduled reviews ("every morning review everything new in repo X").

### Insights
- Cost and latency per model, mode, repo; findings per category over time; how often
  a confirmation run agrees; how many posted findings got fixed.
- Limits dashboard across accounts.

### Integrations (later)
- GitHub App for orgs: webhooks instead of polling, check runs, review from a bot
  identity where that is preferred.
- GitLab adapter.
- MCP server exposing "review this diff" to editors.

## Non-goals (for v2)

- Being a CI gate. Without a GitHub App there is no check run; even with one, the
  owner decides per repository.
- Auto-fixing code. The system reviews; it does not push commits.
- A public SaaS. Decided 2026-10-03: the model runs on each user's own subscription,
  which rules out serving strangers; a shared instance for people you know is the
  ceiling.
- Replacing GitHub's review UI. Inline comments are an output, not the workspace.
