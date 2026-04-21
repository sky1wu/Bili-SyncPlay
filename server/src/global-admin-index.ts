import { loadRuntimeConfig } from "./config/runtime-config.js";
import { createGlobalAdminServer } from "./global-admin-app.js";

const {
  globalAdminPort: port,
  logLevel,
  securityConfig,
  persistenceConfig,
  adminConfig,
  adminUiConfig,
} = await loadRuntimeConfig();

const { httpServer } = await createGlobalAdminServer(
  securityConfig,
  persistenceConfig,
  {
    adminConfig,
    adminUiConfig: {
      ...adminUiConfig,
      enabled: true,
    },
    logLevel,
  },
);
httpServer.listen(port, () => {
  console.log(
    `Bili-SyncPlay global admin listening on http://localhost:${port}`,
  );
});
