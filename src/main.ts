import { loadConfig } from "./config.js";
import { openDb, prune } from "./db.js";
import { whoami } from "./github/gh.js";
import { initLog, log } from "./log.js";
import { accountStatus, initAccountStatus, startPoller } from "./poller.js";
import { startServer } from "./server.js";
import { kickWorker, startWorker } from "./worker.js";

const startedAt = Date.now();
const cfg = await loadConfig();
const db = openDb(cfg.dataDir);
initLog(db);
prune(db);
setInterval(() => prune(db), 6 * 60 * 60 * 1000);

startServer(cfg, db, startedAt, kickWorker);
log("info", `panel on :${cfg.port}${cfg.panelPassword === undefined ? " — WITHOUT a password (PANEL_PASSWORD unset)" : ""}`);

initAccountStatus(cfg);

// A token for the wrong account would comment under the wrong name: stop polling it.
for (const account of cfg.accounts) {
  try {
    const login = await whoami(account.githubToken);
    const status = accountStatus.get(account.name)!;
    status.verifiedLogin = login;
    if (login.toLowerCase() !== account.login.toLowerCase()) {
      log("error", `GH_TOKEN belongs to ${login}, config says ${account.login}; account disabled`, { account: account.name });
      delete account.claudeToken;
      status.claudeReady = false;
    } else {
      log("info", `GitHub token ok (${login}), model ${account.model}, triggers ${account.triggers.join("+")}`, { account: account.name });
    }
  } catch (error) {
    log("error", `GitHub token check failed: ${error instanceof Error ? error.message : error}`, { account: account.name });
  }
}

startPoller(cfg, db);

process.on("SIGTERM", () => {
  log("info", "SIGTERM, exiting; a running job is re-queued on start");
  process.exit(0);
});

await startWorker(cfg, db);
