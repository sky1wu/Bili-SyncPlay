import { loadAdminConfig, loadAdminUiConfig } from "./config/admin-config.js";
import { parseIntegerEnv } from "./config/env.js";
import { loadPersistenceConfig } from "./config/persistence-config.js";
import { loadSecurityConfig } from "./config/security-config.js";
import { createGlobalAdminServer } from "./global-admin-app.js";

const port = parseIntegerEnv(
  process.env,
  "GLOBAL_ADMIN_PORT",
  parseIntegerEnv(process.env, "PORT", 8788),
);
const securityConfig = loadSecurityConfig();
const persistenceConfig = loadPersistenceConfig();
const adminConfig = loadAdminConfig();
const adminUiConfig = loadAdminUiConfig();

const { httpServer } = await createGlobalAdminServer(
  securityConfig,
  persistenceConfig,
  {
    adminConfig,
    adminUiConfig: {
      ...adminUiConfig,
      enabled: true,
    },
  },
);
httpServer.listen(port, () => {
  console.log(
    `Bili-SyncPlay global admin listening on http://localhost:${port}`,
  );
});
