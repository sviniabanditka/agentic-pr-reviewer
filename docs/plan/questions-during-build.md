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
