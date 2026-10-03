import { openDb, prune } from "./store/db.js";
import { rotateSecrets, SecretBox } from "./store/secrets.js";
import { bootstrapAdmin } from "./auth/auth.js";
import { importV1 } from "./store/import_v1.js";
import { allAccounts } from "./store/repos.js";
import { checkAccount } from "./accounts/service.js";
import { Runtime } from "./runtime.js";
import { createApp } from "./api/app.js";
import { startScheduler } from "./scheduler/targets.js";
import { startWorker } from "./jobs/worker.js";

const env = process.env;
const dataDir = env.DATA_DIR ?? "data";
const port = Number(env.PORT ?? 8080);
const db = openDb(dataDir);
const box = env.MASTER_KEY ? new SecretBox(env.MASTER_KEY) : undefined;
const rt = new Runtime({ db, box, dataDir });
if (box !== undefined && env.MASTER_KEY_OLD) {
  const moved = rotateSecrets(db, box, new SecretBox(env.MASTER_KEY_OLD));
  rt.log("info", `re-encrypted ${moved} secret(s) with the new MASTER_KEY; MASTER_KEY_OLD can be removed`);
}
prune(db);
setInterval(() => prune(db), 6 * 60 * 60 * 1000);

if (box === undefined) rt.log("warn", "MASTER_KEY is not set: tokens cannot be stored or used (openssl rand -base64 32)");
const admin = await bootstrapAdmin(db, env);
if (admin !== null) rt.log("info", `admin ${admin.login} created from PANEL_PASSWORD; the variable can be removed`);
await importV1(rt, env);

Bun.serve({ port, idleTimeout: 60, fetch: createApp(rt, env).fetch });
rt.log("info", `listening on :${port}`);

if (box !== undefined) {
  // Fills the GitHub quota meters and flags tokens that stopped working while we were down.
  for (const account of allAccounts(db)) await checkAccount(rt, account).catch(() => {});
  startScheduler(rt);
}

process.on("SIGTERM", () => {
  rt.log("info", "SIGTERM, exiting; a running job is re-queued on start");
  process.exit(0);
});

if (box !== undefined) await startWorker(rt);
