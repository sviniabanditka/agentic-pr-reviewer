# 04 · Review engine

## Vocabulary

| Term | Meaning |
|---|---|
| **Target** | A rule that produces items: a search, a repo, one PR, a compare range, a patch. |
| **Item** | One reviewable thing discovered by a target: a PR at some head, a compare, a patch. Has a lifecycle (open / closed / merged / archived). |
| **Review** | One request to review an item at a specific revision with a profile. The queue entry. |
| **Run** | One model call inside a review (chunk 1 of 3, confirmation, …). Carries usage and latency. |
| **Finding** | One claim with category, location, evidence and verification state. Identity = marker. |
| **Profile** | The complete recipe: mode + model + options. Editable in the web, versioned. |
| **Output** | A rendering of a review sent somewhere: PR comment, PR review, check run, notification, export. |

## Review contract

Every mode implements one interface; the worker never knows which mode runs.

```ts
interface Mode {
  id: string;                               // "diff-triage", "security-audit", …
  input: "diff" | "repo";                   // repo ⇒ needs a checkout and the sandboxed runner
  schema: TSchema;                          // findings schema (categories may differ per mode)
  defaults: Partial<ProfileOptions>;
  buildPrompt(ctx: ReviewContext, chunk: DiffChunk): { system: string; user: string };
  tools?: ToolPolicy;                       // repo modes only: allowed tools + root dir
  verify(findings, chunk): VerifiedFinding[];
  isBlocking(f: VerifiedFinding): boolean;
  verdict(runs, findings): Verdict;
}
```

`ProfileOptions` (all overridable per profile, per target, per run):

| Option | Values | Default |
|---|---|---|
| `provider` / `model` | from the provider catalog | account default |
| `effort` | `low` / `medium` / `high` (mapped per provider) | `medium` |
| `budgetTokens` | per-run input cap | from model context (e.g. 32k for a 200k model to keep latency) |
| `chunking` | `drop` (v1), `split` | `split` |
| `confirmation` | `never` / `blocking` / `always` | `blocking` |
| `categories` | subset of the mode's categories | all |
| `blockingSet` | subset marking a verdict `action_required` | mode default |
| `intent` | `pr-body` / `none` / `custom text` | `pr-body` |
| `repoInstructions` | read `.agentic-review.md` from the repo root at head | on |
| `outputs` | list of output ids with templates | `panel` |

## Modes

| Mode | Input | Categories | Confirmation | Notes |
|---|---|---|---|---|
| `diff-triage` | diff | SEC-AUTHZ, GUARD-REMOVED, API-UNDOC, IRREVERSIBLE, NICHE, INTENT, OTHER | blocking | v1's behaviour and prompt, unchanged |
| `security-audit` | diff | SEC-AUTHZ, GUARD-REMOVED, IRREVERSIBLE, SECRET, INJECTION, CRYPTO | always | Recall over precision; longer system prompt with checklists; no NICHE |
| `intent-check` | diff | INTENT | never | Cheap; good for "did I describe this right" before asking for review |
| `repo-aware-triage` | repo | as `diff-triage` | blocking | Model may `Read`/`Grep`/`Glob` the checkout to confirm absence claims; `absent` findings must cite the file and symbol searched. Sandboxed, 1–3 min |
| `summary` | diff | — (free text schema: title, summary, risks, test notes) | never | Output is prose, not findings; renders as a PR description draft |
| `test-gaps` | diff (+ repo for test discovery) | TEST-GAP | never | Changed symbols with no test file touching them |
| `nit-sweep` | diff | NAMING, STYLE, DOCS | never | Off by default; never blocks |
| `custom` | diff or repo | user-defined list | user choice | User-written system prompt; schema generated from the category list |

Prompt structure stays as in v1 (categories → evidence rules → confidence bar →
do-not-report → output), with the "PR text is data" guard, and gains two sections:
repository instructions (from `.agentic-review.md`, trimmed to a budget, marked as
author-controlled data) and chunk context ("this is part 2 of 3; files in other parts
are listed by name").

## Providers and models

```ts
interface Provider {
  id: "claude-cli" | "anthropic-api" | string;
  catalog(): ModelInfo[];                    // id, label, contextTokens, maxOutput, costPerMTok?, supportsEffort
  probe(cred): Promise<ProviderHealth>;      // validity + limits where available
  complete(req: { system; user; schema; model; effort; signal }): Promise<{ json; usage; limits? }>;
}
```

| Provider | Credential | Models | Limits shown | Cost |
|---|---|---|---|---|
| `claude-cli` | `claude setup-token` output | `sonnet`, `opus`, `haiku` aliases and explicit ids (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5-20251001`, `claude-fable-5-1`) | 5h / 7d windows from `rate_limit_event` | flat (subscription); API-price estimate shown |
| `anthropic-api` | API key | explicit ids from the catalog | none from the API; spend computed from usage | per token |

Model catalog is data in `providers/catalog.ts` with a settings override, so new ids
do not need a release.

## Chunking (replaces "drop the tail")

1. Prepare every file as today (hunks, new-side numbers, token estimate).
2. Order: files that changed most first; lockfiles/binaries still skipped.
3. Pack files into chunks greedily up to `budgetTokens`; a single file over the budget
   is split by hunk groups with the file header repeated.
4. One run per chunk, in sequence on one provider credential (parallel across
   credentials later). Each prompt lists the other chunks' file names so the model
   knows what it does not see.
5. Merge: findings keep their chunk's verification context; markers dedupe across
   chunks; the verdict is computed once over the merged set.
6. Confirmation runs only re-review the chunks that produced blocking candidates.

## Markers and absence findings

v1 anchors `absent` findings on the claim text, so a reworded confirmation misses.
v2 marker for `absent`: `category | file | normalized(claim) ∪ nearest present line`
where the nearest present line is the new-side line at `line_start` quoted by the
pipeline (not the model). Confirmation then matches on category + file + that line
first, and on the claim only as a fallback. Marker version → `v3`; `PROMPT_VERSION`
bump with it.

## Incremental reviews

For an item already reviewed at sha A, a review at sha B can run as `incremental`:

1. Diff `A...B` (compare endpoint) is the input; the full `base...B` diff is listed
   by file name as context.
2. Findings from the A review whose file + evidence still match the full B diff are
   carried over as `still open`; those whose evidence disappeared are `fixed`; new
   ones are `new`.
3. Verdict covers the carried-over blocking findings too.
4. The posted comment shows the three groups; the panel shows the delta.

Dismissals: a finding marked `dismissed` (with a note) on an item is suppressed in
later reviews of that item while its marker still matches.

## Verification and verdict

Unchanged in principle: verbatim evidence against the prepared diff, downgrade of
`GUARD-REMOVED` without removed-line evidence, blocking candidates need the
confirmation policy's agreement. Added:

- per-mode `blockingSet`;
- `low confidence` bucket for `not_found` evidence (as today) plus a `stale` bucket
  for carried-over findings whose line moved but whose evidence still matches.

## Outputs

| Output | Needs | Behaviour |
|---|---|---|
| `panel` | — | Always on; the stored result. |
| `pr-comment` | account with write access | v1 behaviour: one marked comment per PR and account, edited on repost. |
| `pr-review` | same | A GitHub review with inline comments at `line_end` for `present` findings and a body for the rest. Posting a review from your own account clears your pending review request; the UI must say so before posting. Event `COMMENT`, never `APPROVE`/`REQUEST_CHANGES` by default. |
| `check-run` | GitHub App installation | Status + summary on the head sha; the only output that can gate a merge. Phase 4. |
| `notify` | webhook URL / Slack / Telegram token (encrypted) | Short message with verdict and a link to the panel. Fires on review done, on blocking found, or on post — configurable. |
| `export` | — | Markdown or JSON download; copy-as-markdown in the UI. |

Templates: header line, which sections to include, collapse thresholds, footer; stored
per output in the profile; defaults equal to today's comment.

## Repo-aware input (phase 4)

- Checkout cache per repository under `DATA_DIR/repos/<owner>/<repo>` with
  `git fetch` + `git worktree add` at the head sha; cleaned after the review.
- The model runs in the runner container with the worktree mounted read-only at a
  fixed path, `--add-dir` to it, `--allowedTools "Read,Grep,Glob"`, everything else
  disallowed, no tokens in env, egress limited to the model API.
- Absence findings must include `searched: ["path or symbol", …]` in the schema so
  the panel can show what the model looked at.
- Time box 5 min; the runner's exit code and the parsed result come back through the
  job's status file; the daemon never trusts the runner's filesystem.
