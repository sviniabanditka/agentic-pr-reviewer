import { Type } from "typebox";
import { Value } from "typebox/value";
import { fingerprint, putSecret } from "./secrets.js";
import { getSetting, insertAccount, insertCredential, insertTarget, setSetting } from "./repos.js";
import type { Runtime } from "../runtime.js";

// v1 kept accounts in config.json and tokens in GH_TOKEN_<NAME> / CLAUDE_TOKEN_<NAME>.
const V1Schema = Type.Object({
  models: Type.Optional(Type.Array(Type.String())),
  accounts: Type.Array(
    Type.Object({
      name: Type.String(),
      login: Type.String(),
      model: Type.Optional(Type.String()),
      owners: Type.Optional(Type.Array(Type.String())),
      triggers: Type.Array(Type.String()),
    }),
  ),
});

const envName = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "_");

/**
 * Moves a v1 deployment into the database once: accounts, their Claude tokens, one
 * search target per trigger, and the old reviews linked to the new accounts. Needs an
 * admin (it owns everything imported) and MASTER_KEY (tokens are stored encrypted).
 */
export async function importV1(rt: Runtime, env: Record<string, string | undefined>): Promise<string[]> {
  if (getSetting(rt.db, "", "v1_imported", false)) return [];
  const admin = rt.db.query("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get() as { id: string } | null;
  if (admin === null || rt.box === undefined) return [];
  const path = env.CONFIG_PATH ?? "config.json";
  const file = Bun.file(path);
  if (!(await file.exists())) {
    setSetting(rt.db, "", "v1_imported", true);
    return [];
  }
  const raw: unknown = await file.json();
  if (!Value.Check(V1Schema, raw)) {
    rt.log("warn", `${path} is not a v1 config; nothing imported`);
    setSetting(rt.db, "", "v1_imported", true);
    return [];
  }

  const done: string[] = [];
  rt.db.transaction(() => {
    if (raw.models?.length) setSetting(rt.db, "", "models", raw.models);
    for (const a of raw.accounts) {
      const ghToken = env[`GH_TOKEN_${envName(a.name)}`];
      if (!ghToken) continue;
      const claudeToken = env[`CLAUDE_TOKEN_${envName(a.name)}`];
      const credential = claudeToken
        ? insertCredential(rt.db, {
            user_id: admin.id,
            provider: "claude-cli",
            label: `${a.name}: Claude`,
            secret_id: putSecret(rt.db, rt.box!, admin.id, "claude-token", claudeToken),
            token_hint: fingerprint(claudeToken),
          })
        : null;
      const account = insertAccount(rt.db, {
        user_id: admin.id,
        login: a.login,
        label: a.name,
        token_secret_id: putSecret(rt.db, rt.box!, admin.id, "github-token", ghToken),
        token_hint: fingerprint(ghToken),
        credential_id: credential?.id ?? null,
        model: a.model ?? null,
      });
      if (a.triggers.includes("review_requested")) {
        insertTarget(rt.db, { user_id: admin.id, account_id: account.id, name: "Review requested", type: "search", params: { query: "review-requested:@me", role: "review_requested" } });
      }
      if (a.triggers.includes("author")) {
        insertTarget(rt.db, {
          user_id: admin.id, account_id: account.id, name: "My pull requests", type: "search",
          params: { query: "author:@me", role: "author" }, filters: a.owners?.length ? { owners: a.owners } : {},
        });
      }
      rt.db.query("UPDATE jobs SET user_id = ?, account_id = ? WHERE account = ? AND account_id IS NULL").run(admin.id, account.id, a.name);
      done.push(a.name);
    }
    rt.db.query("UPDATE events SET user_id = ? WHERE user_id IS NULL").run(admin.id);
    setSetting(rt.db, "", "v1_imported", true);
  })();
  for (const name of done) rt.log("info", `imported v1 account "${name}"; its GH_TOKEN_/CLAUDE_TOKEN_ variables can be removed`, { userId: admin.id });
  return done;
}
