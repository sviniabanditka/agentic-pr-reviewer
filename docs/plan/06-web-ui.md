# 06 · Web UI

## Look: a terminal, dark only

Decided 2026-10-03, reference: the owner's `pms` project (terminal redesign of a
Nuxt UI app). The v1 panel's IBM Plex / indigo / light+dark look is retired with the
SPA; nothing is restyled twice.

Tokens (Tailwind v4 theme variables, Tokyo Night):

| Token | Value | Use |
|---|---|---|
| `base` | `#0b0c12` | page, rail, topbar |
| `surface` | `#0f1117` | content panels, every floating surface (menus, dialogs) |
| `elevated` | `#16171f` | cards, inputs |
| `hover` / `active` | `#1b1d27` / `#232634` | row hover, selected row |
| `subtle` | `#20222e` | hairline borders |
| `bright` / text / `secondary` / `tertiary` | `#eef0fa` / `#c5cae0` / `#aab0c7` / `#8b91a8` | headings and values / body / secondary / muted |
| `accent` | `#7aa2f7` | blue: links, focus, running |
| `accent2` | `#bb9af7` | purple: identifiers (`#73`, model ids, markers) |
| `ok` | `#9ece6a` | green: clean, prompts (`$`, `#`), caret |
| `info` | `#7dcfff` | cyan: informational tags |
| `warn` | `#ff9e64` | orange: failed, unconfirmed, new commits |
| `danger` | `#f7768e` | red: blocking |

Type: **JetBrains Mono everywhere**, 14px base, self-hosted woff2 (Regular, Medium,
Bold; ~250 KB). No second family. Radius 6/8/12px, no pills except where a chip is a
tag; square avatars.

Terminal vocabulary (what makes it read as a terminal without pretending to be a TUI):

- Buttons are `[ review ]`, `[ post ]`, `[ cancel ]` — brackets in `tertiary`, label
  in `secondary`, primary action label in `accent`, danger in `danger`; flat, no
  fill. Disabled: brackets and label `tertiary/50`.
- Section headers are prompts: `# open pull requests`, `# accounts`; command contexts
  (search, pickers, dialogs) use `$`. Lowercase titles.
- Progress and limits are ASCII bars: `[████░░░░░░] 42%`; the Claude 5h/7d windows
  and GitHub quota render with it, coloured by level (`ok` → `warn` ≥70 → `danger`
  ≥90).
- Status glyphs instead of icons: review `○` queued `◐` running `●` done `⊘` failed /
  cancelled; verdict `✓` clean, `✗` blocking; chevrons `▸` / `▾`; breadcrumbs with `/`.
- Pipeline strip for the running review: `fetch diff ▸ review ▸ confirm` with the
  current step in `accent` and a blinking block cursor `█` after it.
- Empty states and hints are comments: `// nothing running — pick a pull request and
  press [ review ]`.
- Timestamps `HH:MM:SS` in `tertiary`; identifiers (`hm-server #73`, `opus`,
  `172d13e`) in `accent2`.
- Scanline overlay (`body::after`, 1px every 3px at 1.2% white, pointer-events none),
  thin dark scrollbars, green caret where the browser honours `caret-color`, custom
  block mouse cursor optional (`public/cursor.svg`).
- Checkboxes `[x]` / `[ ]`, toggles `[on]` / `[off]`.
- Logs and findings are the native habitat: monospace blocks, evidence lines
  prefixed with the new-side line number as in the prompt (`42 +  await db…`).
- Lessons from `pms`: never use a blanket `a { color: inherit }`; `white-space:
  nowrap` on flag-like tokens so `--flags` do not break at the hyphen; block caret
  overlays do not work cross-browser — keep the plain green caret.

Motion: one blink (the cursor), the shimmer skeleton, nothing else automatic.
Reduced-motion disables both.

## Stack

- Vue 3 (`<script setup lang="ts">`), Vite, TypeScript strict.
- Tailwind v4 with the tokens above as `@theme` variables; no `dark:` variants (one
  theme). `prefers-color-scheme` is ignored on purpose.
- `vue-router`, history mode; the server serves `web/dist/index.html` for unknown
  paths.
- Headless primitives from `reka-ui` (dialog/drawer, popover, select, tabs, tooltip)
  styled with the tokens; icons are glyphs, `lucide-vue-next` only where a glyph
  cannot say it (external link, copy).
- Terminal components: `TBtn` (`[ label ]`), `TBar` (ASCII bar), `TCheck`, `TToggle`,
  `TPrompt` (section header), `TGlyph` (status), `TCursor` (blinking block).
- State: `web/src/stores/*.ts` as `reactive()` singletons fed by one SSE connection
  and a typed API client generated from the typebox DTOs (`bun run gen:api`). Pinia
  only if the stores outgrow this.
- Tests: Vitest for composables/formatters, Playwright for the main flows.

Dev: `bun run dev` starts the API on 8080 and Vite on 5173 with a proxy for `/api`.
Build: `vite build` → `web/dist`, copied into the image, served with immutable
caching for hashed assets. CSP `default-src 'self'` holds because fonts are local.

## Pages

| Route | Page | Contents |
|---|---|---|
| `/setup` | First run | Create the admin login. Only while `needsSetup`. |
| `/login` | Login | `$ login` form; invite links land here with the token prefilled to set a password. |
| `/` | Overview | Account cards (health, Claude 5h/7d and GitHub quota as ASCII bars), current review with the pipeline strip and `tail -f`-style last lines, queue, today's totals, recent reviews. |
| `/inbox` | Inbox | Items across targets: filters (target, account, role, state, needs review, new commits, unposted review), `/` search, bulk `[ review selected ]` with a profile. The working view. |
| `/items/:id` | Item | PR header, head/base, labels; reviews timeline (full/incremental, model, verdict, posted?); findings of the latest review with `[ dismiss ]`; `[ review ]` with profile and overrides; `[ post ]` with output picker and preview. |
| `/reviews/:id` | Review | Verdict, facts, runs (chunks, confirmation) with usage, findings grouped, timeline, export, compare. Also a drawer from lists (`#review/:id`). |
| `/targets` | Targets | Type, account, automation level, last poll, counts; add/edit per type with live preview; filters editor. |
| `/accounts` | Accounts | GitHub accounts (paste token → check → scopes, SSO notices, defaults; later `[ connect with github ]`); model credentials (paste → probe → limits), assignment to accounts. |
| `/profiles` | Profiles | Mode, options form from the mode's option schema, prompt preview against an item, outputs and templates, default, versions. |
| `/activity` | Activity | Audit log (every GitHub write) first, event log with level filter and follow, insights. |
| `/settings` | Settings | Polling defaults, retention (default: metadata forever, code excerpts 90 days), notification endpoints, password/TOTP; admin: users and invites. |

Per-user scoping (decided 2026-10-03): a user sees only their own accounts,
credentials, targets, items, reviews and audit rows. The admin additionally sees
`/settings/users` (invite, disable, role) and instance-wide load (queue length,
limits per user without values), never other users' reviews.

## Flows

**Invite a colleague.** Settings → users → `[ invite ]` → link with a one-time token
(expires in 7 days) → colleague opens it, sets a password → lands on `/accounts` with a
`// add a github account and a claude token to start` hint.

**Add a GitHub account.** Accounts → `[ add account ]` → paste token → `[ check ]`
shows login, scopes, SSO status → defaults → `[ save ]`. (Device flow `[ connect with
github ]` when an OAuth App exists.)

**Add a model credential.** Accounts → `[ add credential ]` → provider → paste
`claude setup-token` output → `[ validate ]` runs the probe and shows the 5h/7d bars →
`[ save ]` → attach to accounts.

**Add a target.** Targets → `[ new target ]` → type → params (search: qualifier chips
plus free text) → preview of the first 20 matches → filters → automation (`manual`
default; `auto-post` requires typing the account login) → `[ save ]`.

**Review.** Inbox or Item → `[ review ]` → profile (default preselected), model and
confirmation overrides → `[ start ]` → pipeline strip live → `✓`/`✗` toast → findings.

**Post.** Item or Review → `[ post ]` → output (comment default; review with inline
comments shows the "clears your review request" warning) → rendered preview →
`[ post as @login ]` second-step confirm → audit row + link.

**Incremental.** Item with new commits → `[ review ]` → `[x] since last review` (on by
default when a previous review exists) → fixed / still open / new.

## Conventions

- Every outward or destructive action is a two-step `TBtn` whose second label names
  the account and destination: `[ post as @ksivenkov96 → hm-server #73 ]`.
- Lists never re-render on the ticker; relative times update in place.
- Keyboard: `/` search, `Esc` closes drawers, `j`/`k` move in the inbox, `r` review,
  `p` post (confirm step still required), `?` shows the key list.
- Focus returns to the trigger after a drawer closes; focus ring is `accent`, 2px,
  keyboard only; inputs never get the blue ring (terminal: border stays `subtle`).
- Errors are sentences with a next step, prefixed `!` in `danger`; never codes alone.
