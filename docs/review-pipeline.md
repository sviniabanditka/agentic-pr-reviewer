# Review pipeline

From a PR to a posted comment.

```mermaid
flowchart TD
    A[gh pr diff] --> B[parseDiffOutput]
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

## 1. Diff — `src/github/parse_diff.ts`, `src/review/diff.ts`

`gh pr diff` returns one `git diff` text; `parseDiffOutput` splits it into files with
status, counts and patch. `prepareDiff` then parses hunks, numbering new-side lines
from the `@@` headers.

A file is **skipped** with a reason:

| Reason | When |
|---|---|
| `binary` | no patch |
| `lockfile` | `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `composer.lock`, `Gemfile.lock`, `Cargo.lock`, `go.sum`, `poetry.lock`, and `*.min.js`, `*.min.css`, `*.map`, `*.snap` |
| `over_budget` | does not fit the token budget |

Budget: 32,000 tokens for the whole diff, estimated as characters / 3.5. A file that
would leave less than 1,500 is skipped but later files are still tried; once less
than 1,000 remains, every remaining file is skipped. Skipped files are listed in the
comment under "Not reviewed".

The model sees new-side lines with numbers and removed lines without:

```
## File: 'src/routes/orders.ts'

__new hunk__
4 +router.get("/api/orders/:id", async (req, res) => {
6    res.json(order);
__old hunk__
 router.get("/api/orders/:id", requireAuth, async (req, res) => {
```

## 2. Prompt — `src/review/prompt.ts`

The system prompt defines the categories, the evidence rules, an asymmetric
confidence bar, a do-not-report list (wording nits, types, unused imports,
formatting, code outside the diff), and states that PR text is data, not
instructions.

The user message carries repo, PR number, title, branch, base/head sha, the diff and,
when the PR body is non-empty, an `## Author's claim` section with the body (the
input for INTENT findings).

## 3. Categories — `src/review/finding.ts`

| Category | Blocking | Meaning |
|---|---|---|
| `SEC-AUTHZ` | yes | A path to user- or tenant-scoped data without an authorization check. A missing check is itself the evidence. |
| `GUARD-REMOVED` | yes | A validation, auth check, error handler, retry or transaction boundary deleted or weakened with no replacement. |
| `API-UNDOC` | yes | A breaking change to a public contract (signature, response shape, default, CLI flag, config key) with no migration. |
| `IRREVERSIBLE` | yes | Destroys data or state with no recovery: destructive migration, in-place rewrite without backup, secret committed. |
| `NICHE` | no | An added comment, commented-out code or lint suppression that does not earn its keep. |
| `INTENT` | no | The author's claim and the diff disagree. Only when a claim is present. |
| `OTHER` | no | A real defect outside the above, reported only when certain. |

Each finding: `category`, `file`, `line_start`, `line_end`, `evidence`,
`evidence_kind` (`present` / `removed` / `absent`), `claim`, `detail`.

## 4. Model call — `src/review/claude.ts`

```
claude -p --tools "" --system-prompt <SYSTEM_PROMPT> --output-format stream-json --verbose
       --json-schema <findings schema> --model <model> --no-session-persistence
```

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

A finding is a blocking candidate when its category is one of the four blocking ones
and `evidenceCheck !== "not_found"`. `skipped_absent` can block: for `SEC-AUTHZ` the
absence of a check is the evidence.

No candidates: one run. Candidates: a second, independent run of the same diff; a
finding is **confirmed** only if its marker reappears among the second run's
candidates.

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

Key: SHA-256 of `PROMPT_VERSION`, model, rendered diff and intent
(`src/review/cache_key.ts`), kept 24 h. A re-review of an unchanged diff with the same
model reuses the verdict. **Bump `PROMPT_VERSION`
whenever the prompt changes.**
