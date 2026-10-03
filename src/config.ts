import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { join } from "node:path";

const ConfigFileSchema = Type.Object({
  pollIntervalSec: Type.Optional(Type.Number({ minimum: 10 })),
  /** Models the panel offers per review; anything `claude --model` accepts. */
  models: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  accounts: Type.Array(
    Type.Object({
      /** Short id; tokens come from GH_TOKEN_<NAME> and CLAUDE_TOKEN_<NAME>. */
      name: Type.String({ pattern: "^[a-z0-9_-]+$" }),
      login: Type.String({ minLength: 1 }),
      model: Type.Optional(Type.String()),
      /** Repo owners where PRs you authored are reviewed; absent = any. Review requests are always reviewed. */
      owners: Type.Optional(Type.Array(Type.String())),
      triggers: Type.Array(Type.Union([Type.Literal("review_requested"), Type.Literal("author")]), { minItems: 1 }),
    }),
    { minItems: 1 },
  ),
});

type AccountFile = Static<typeof ConfigFileSchema>["accounts"][number];

export interface Account extends AccountFile {
  model: string;
  githubToken: string;
  /** Absent until `claude setup-token` output is put in the secret; the account is then not polled. */
  claudeToken?: string;
}

export interface Config {
  pollIntervalSec: number;
  models: string[];
  dataDir: string;
  port: number;
  accounts: Account[];
}

/** How Claude Code runs for an account: its token and its own state dir. */
export function claudeSettingsFor(cfg: Config, account: Account, model: string): { oauthToken: string; model: string; configDir: string } {
  return { oauthToken: account.claudeToken ?? "", model, configDir: join(cfg.dataDir, "claude", account.name) };
}

function envName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export async function loadConfig(env: Record<string, string | undefined> = process.env): Promise<Config> {
  const path = env.CONFIG_PATH ?? "config.json";
  const raw: unknown = await Bun.file(path).json();
  if (!Value.Check(ConfigFileSchema, raw)) {
    const first = [...Value.Errors(ConfigFileSchema, raw)][0];
    throw new Error(`${path}: invalid config${first ? ` at ${first.instancePath}: ${first.message}` : ""}`);
  }

  const models = raw.models ?? ["sonnet", "opus", "haiku"];
  const accounts = raw.accounts.map((a): Account => {
    const githubToken = env[`GH_TOKEN_${envName(a.name)}`];
    if (!githubToken) throw new Error(`account ${a.name}: GH_TOKEN_${envName(a.name)} is not set`);
    const model = a.model ?? models[0]!;
    if (!models.includes(model)) throw new Error(`account ${a.name}: model ${model} is not in "models"`);
    const claudeToken = env[`CLAUDE_TOKEN_${envName(a.name)}`];
    return { ...a, model, githubToken, ...(claudeToken ? { claudeToken } : {}) };
  });

  return {
    pollIntervalSec: raw.pollIntervalSec ?? 30,
    models,
    dataDir: env.DATA_DIR ?? "data",
    port: Number(env.PORT ?? 8080),
    accounts,
  };
}
