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
