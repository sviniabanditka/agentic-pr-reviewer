# Questions raised during the build

Collected while implementing the roadmap without stopping to ask. Each entry: phase,
what was decided for now, and what the owner should confirm.

## Phase 0

1. **License holder.** `LICENSE` is MIT with "Kostiantyn Sivenkov" as the copyright
   holder (the git author name). Confirm the license and the name before opening the
   repository.
2. **Logins and the employer's org name in git history.** `config.json` is now
   untracked and replaced by `config.example.json`, and the deploy scripts read
   `.deploy.env`; but commits `7d73a5d` and `c2e7c71` still contain `config.json`
   (logins `sviniabanditka`, `ksivenkov96`, org `HealthMotivate-Digital`) and the
   cluster/registry hostnames. A history scan found no tokens. Rewrite history before
   opening, or accept these as public.
3. **Admin login after migration.** The deployed instance creates the first admin from
   `PANEL_PASSWORD` with login `admin` (no `PANEL_USER` was ever set). Change it in
   phase 4's user settings, or tell me another login to use.

## Phase 1

4. **Device flow deferred.** Adding a GitHub account is paste-a-token only, as decided;
   the device flow waits for an OAuth App (phase 3).
5. **No `reka-ui`.** The drawer and dialogs are small hand-written components
   (`Drawer.vue`, inline forms) styled with the terminal tokens; a headless library
   was not needed for a dark-only app with a handful of overlays. Say if you want it.
6. **Search role defaults.** A search target's role is taken from the query
   (`review-requested:@me` → review requested, `author:@me` → mine, anything else →
   watching) unless set explicitly in the editor.
7. **Items found by no target** become `unmatched` (still open on GitHub, but out of
   every target's scope) and leave the default inbox view; they stay reachable under
   state "closed / merged / unmatched".
8. **v1 environment variables.** After the import the `GH_TOKEN_*`, `CLAUDE_TOKEN_*`
   and `PANEL_PASSWORD` keys in the cluster Secret are unused. I left them in place so a
   rollback to the v1 image keeps working; remove them once v2 is trusted.

## Phase 2

9. **No effort/thinking setting.** The plan listed an effort option; I could not
   confirm a `claude -p` flag for it on the pinned CLI, so profiles do not offer one.
   The model choice (haiku / sonnet / opus / explicit ids) is the speed–depth knob for
   now. Confirm whether you want me to probe the CLI for a reasoning flag.
10. **Confirmation "always" dropped.** Profiles offer `blocking` (second run only for
    blocking candidates) and `never`. A second run when nothing is blocking has nothing
    to confirm, so "always" would only double the cost.
11. **`src/review` not renamed to `src/engine`.** The plan's module name; the rename
    is churn without behaviour, so the engine stays in `src/review`.
12. **Built-in profiles are per-user rows**, created on first use, editable and
    deletable (except the default). There are no global read-only presets; say if
    you want locked templates.
13. **Summary mode posting.** A summary review posts its PR-description draft as the
    usual marked comment. It does not edit the PR description itself; that would need
    write access to the PR body and is easy to add as an output in phase 3.

## Phase 3

14. **Auto-post posts the comment, not a review.** Unattended posts always use the
    editable marked comment; a GitHub review cannot be edited, so each push would add
    a new one. Inline reviews stay a manual choice.
15. **Automatic reviews are incremental** once a PR has a finished review. A force-push
    that makes the old head unreachable falls back to a full review. Manual reviews are
    full unless "review new commits" is pressed.
16. **Compare items store the head as given** (branch or sha). Reviewing a compare on a
    branch name again reviews wherever the branch is now; the cache key still changes
    with the diff text.
17. **Device login needs your OAuth app.** Settings → sign in with github takes the
    client id of an OAuth app with device flow enabled; I did not create one. Pending
    logins live in memory (a restart drops them).
18. **Retention removes the stored findings and pasted patches only**; verdict, counts,
    costs, events and the audit log stay. Events are still pruned after 14 days.
19. **Summary mode does not edit the PR description** (question 13): still a comment.
20. **No visual browser check this round**: the in-browser agent was not available;
    types, build, 132 tests and an API smoke run on a copy of the prod DB passed.
21. **No per-output templates yet.** The comment, review and notification texts are
    fixed in code (`src/github/comment.ts`, `src/outputs/notify.ts`). Editable templates
    are cheap to add once you know what you would change; tell me what.
22. **Activity opens on the audit tab** ("audit log first" in the roadmap); the live log
    is one click away.
