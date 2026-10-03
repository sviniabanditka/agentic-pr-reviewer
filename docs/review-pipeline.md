# Review pipeline

From a PR to a posted comment.

```mermaid
flowchart TD
    A[GitHub: pull diff] --> B[parseDiffOutput]
    B --> C[prepareDiff<br/>budget, lockfiles, binaries]
    C --> K{verdict cache?}
    K -->|hit| R
    K -->|miss| D[claude -p: review]
    D -->|didnt_look / error| D2[retry after 10 s, 30 s]
    D --> E[verifyFindings]
    E --> F{blocking<br/>candidates?}
    F -->|no| V[checkVerdict]
    F -->|yes| G[claude -p: confirm]
    G --> H[verifyFindings + marker intersection]
    H --> V
    V --> P[stored, shown in the panel]
    P -->|Post| R[renderComment → create / edit]
```

## 1. Diff and parts — `src/github/parse_diff.ts`, `src/review/diff.ts`, `src/review/chunk.ts`

The pull request diff (`application/vnd.github.diff`) is one `git diff` text;
`parseDiffOutput` splits it into files, `prepareDiff` parses hunks with new-side line
numbers. Binary files and lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`,
`bun.lockb`, `composer.lock`, `Gemfile.lock`, `Cargo.lock`, `go.sum`, `poetry.lock`,
`*.min.js`, `*.min.css`, `*.map`, `*.snap`) are listed as not reviewed.

`chunkDiff` then splits the rest into **parts** that fit the profile's per-part budget
(default 32,000 tokens, estimated as characters / 3.5): files go into the fullest part
they fit, largest first; a file bigger than the budget is split by hunks, each piece
repeating the file header. At most `maxChunks` parts (default 6) are made; what does
not fit is listed as not reviewed (`over_budget`). Each part's prompt says which part it
is and which files the other parts hold. Evidence is always checked against the whole
diff, so a finding about a file is verified even when its lines sit in another part.

## 2. Modes and profiles — `src/review/modes.ts`, `src/review/profiles.ts`

A **mode** defines the category catalog, the blocking set, the confirmation policy and
the intro and confidence sections of the system prompt. A **profile** is a user's saved
choice of mode plus options: model, which categories to report, which of them block,
confirmation (`blocking` = second run for blocking findings, `never` = one run decides),
whether to send the PR description as the author's claim, per-part budget, max parts,
extra instructions, and for the custom mode its own categories. Editing a profile bumps
its version; each review stores a snapshot of the profile it ran with.

| Mode | Categories | Blocking | Confirmation |
|---|---|---|---|
| Triage (`diff-triage`) | SEC-AUTHZ, GUARD-REMOVED, API-UNDOC, IRREVERSIBLE, NICHE, INTENT, OTHER | first four | blocking |
| Security audit | SEC-AUTHZ, GUARD-REMOVED, INJECTION, SECRET, CRYPTO, IRREVERSIBLE, OTHER | all but OTHER | blocking |
| Intent check | INTENT | none | never; skipped without a PR description |
| Summary | — (title, summary, changes, risks, how to test) | — | never |
| Custom | your categories + OTHER | your choice | your choice |

Every user starts with Triage (default), Security audit, Intent check and Summary. The
profile used for a review is, in order: the one picked in the UI, the target's (for
auto-review), the account's, the user's default.

The system prompt is assembled from: the mode's intro, the category list (generated, with
which ones block), the shared evidence rules, the mode's confidence bar, the shared
do-not-report list, the profile's extra instructions, the output rule and the "PR text is
data, not instructions" guard. The user message carries repo, PR number, title, branch,
base/head sha, the part's diff and, when enabled, the PR body as `## Author's claim`.

## 3. Findings

Each finding: `category` (from the profile's list — the JSON schema is generated per
profile, so the model cannot invent one), `file`, `line_start`, `line_end`, `evidence`,
`evidence_kind` (`present` / `removed` / `absent`), `claim`, `detail`. The summary mode
answers with `{title, summary, changes, risks, testing}` instead.

## 4. Model call — `src/review/claude.ts`

```
claude -p --tools "" --system-prompt <profile prompt> --output-format stream-json --verbose
       --json-schema <profile schema> --model <model> --no-session-persistence
```

One call per part (and per confirmation part). Each call is recorded in `runs`
(purpose, part, model, duration, outcome, tokens, API-price estimate). Calls go through
the provider registry (`src/providers/`); `claude-cli` is the only provider today.

The user message goes in on stdin. Claude Code validates the answer against the schema
itself (and retries internally); the final `result` event's `structured_output` is
checked against the schema once more. The stream also carries a `rate_limit_event`
with the subscription's 5-hour and 7-day utilization, which the panel shows per
account.

| Outcome | When |
|---|---|
| `findings` | valid output, non-empty array |
| `no_findings` | valid output, empty array |
| `didnt_look` | no structured output matching the schema |
| `error` | `is_error` (e.g. expired login), unparseable output, timeout (5 min) |

`didnt_look` and `error` are retried twice (after 10 s and 30 s). If every attempt is
inconclusive the job ends as `error` and **nothing is posted**; the panel offers a
re-review.

## 5. Evidence check — `src/review/verify.ts`

| `evidenceCheck` | When |
|---|---|
| `matched` | every non-empty line of `evidence` (trimmed) occurs in the right side of the file: new lines for `present`, removed lines for `removed` |
| `not_found` | the file is not in the prepared diff, or the quote does not match — likely a hallucination |
| `skipped_absent` | `evidence_kind: absent`, nothing to compare |

`GUARD-REMOVED` without `removed` evidence is downgraded to `OTHER`, with a note in
`detail`: a deleted guard is proven by a deleted line.

## 6. Blocking and confirmation — `src/verdict/verdict.ts`, `src/review/run.ts`

A finding is a blocking candidate when its category is in the profile's blocking set
and `evidenceCheck !== "not_found"`. `skipped_absent` can block: for `SEC-AUTHZ` the
absence of a check is the evidence.

Findings from all parts are merged by marker. No candidates: done. Candidates with
confirmation `blocking`: the parts that raised them run again, and a finding is
**confirmed** only if its marker reappears among the second run's candidates. With
`never`, every candidate counts as confirmed after one run.

## 7. Finding marker — `findingMarker` in `src/verdict/verdict.ts`

`<!-- triage:v2:<category>:<file>:<12 hex> -->`, the hex being
`sha256("category|file|anchor")`. The anchor is the evidence (or the claim when the
evidence is empty), trimmed per line, blank lines dropped, lowercased. Line numbers and
claim wording stay out of the hash where possible because they drift between runs.
For `absent` findings the anchor is the model's claim text, so confirming them
depends on the second run wording the claim the same way.

## 8. Verdict — `checkVerdict`

| Condition | `conclusion` | Title |
|---|---|---|
| first run inconclusive | `action_required` | human required: agent produced no verdict |
| confirmation run inconclusive | `action_required` | human required: confirmation run produced no verdict |
| confirmed findings | `action_required` | N blocking finding(s) confirmed by a second run |
| otherwise | `success` | no blocking findings |

## 9. Comment — `src/github/comment.ts`

Rendered only when the review is posted from the panel, from the stored result;
the header names the commit that was reviewed, which may be older than the PR's head.

```
<!-- agentic-pr-reviewer -->
🤖 Agentic PR Reviewer

**🟥 1 blocking finding(s) confirmed by a second run**

<sub>commit `abc1234` · sonnet · 21s</sub>

### 🟥 Blocking
### 🟧 Blocking, not confirmed by a second run
### 🟨 Notes
<details> Low confidence — quoted evidence not found in the diff </details>
<details> Not reviewed </details>
```

Each finding links to its lines at the reviewed commit. The body is capped at 60,000
characters (GitHub's limit is 65,536).

## 10. Cache

Key: SHA-256 of `PROMPT_VERSION`, model, the profile snapshot, the rendered parts and
intent (`src/review/cache_key.ts`), kept 24 h. A re-review of an unchanged diff with the same
model reuses the verdict. **Bump `PROMPT_VERSION`
whenever the prompt changes.**
