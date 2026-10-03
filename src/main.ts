import { loadConfig } from "./config.js";
import { openDb, prune } from "./store/db.js";
import { SecretBox } from "./store/secrets.js";
import { bootstrapAdmin } from "./auth/auth.js";
import { whoami } from "./github/gh.js";
import { Runtime } from "./runtime.js";
import { createApp } from "./api/app.js";
import { initAccountStatus, startPoller } from "./scheduler/poller.js";
import { startWorker } from "./jobs/worker.js";

const cfg = await loadConfig();
const db = openDb(cfg.dataDir);
const box = process.env.MASTER_KEY ? new SecretBox(process.env.MASTER_KEY) : undefined;
const rt = new Runtime(cfg, db, box);
prune(db);
setInterval(() => prune(db), 6 * 60 * 60 * 1000);

if (box === undefined) rt.log("warn", "MASTER_KEY is not set: secrets cannot be stored (openssl rand -base64 32)");
const admin = await bootstrapAdmin(db, process.env);
if (admin !== null) rt.log("info", `admin ${admin.login} created from PANEL_PASSWORD; the variable can be removed`);

const app = createApp(rt);
Bun.serve({ port: cfg.port, idleTimeout: 60, fetch: app.fetch });
rt.log("info", `listening on :${cfg.port}`);

initAccountStatus(rt);

// A token for the wrong account would comment under the wrong name: stop using it.
for (const account of cfg.accounts) {
  try {
    const login = await whoami(account.githubToken);
    const status = rt.accountStatus.get(account.name)!;
    status.verifiedLogin = login;
    if (login.toLowerCase() !== account.login.toLowerCase()) {
      rt.log("error", `GH_TOKEN belongs to ${login}, config says ${account.login}; account disabled`, { account: account.name });
      delete account.claudeToken;
      status.claudeReady = false;
    } else {
      rt.log("info", `GitHub token ok (${login}), model ${account.model}, triggers ${account.triggers.join("+")}`, { account: account.name });
    }
  } catch (error) {
    rt.log("error", `GitHub token check failed: ${error instanceof Error ? error.message : error}`, { account: account.name });
  }
}

startPoller(rt);

process.on("SIGTERM", () => {
  rt.log("info", "SIGTERM, exiting; a running job is re-queued on start");
  process.exit(0);
});

await startWorker(rt);
