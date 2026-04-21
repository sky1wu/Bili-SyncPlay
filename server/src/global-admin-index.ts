import { loadRuntimeConfig } from "./config/runtime-config.js";
import { createGlobalAdminServer } from "./global-admin-app.js";

const {
  globalAdminPort: port,
  metricsPort,
  logLevel,
  securityConfig,
  persistenceConfig,
  adminConfig,
  adminUiConfig,
} = await loadRuntimeConfig();

const { httpServer, metricsHttpServer } = await createGlobalAdminServer(
  securityConfig,
  persistenceConfig,
  {
    adminConfig,
    adminUiConfig: {
      ...adminUiConfig,
      enabled: true,
    },
    logLevel,
    metricsPort,
  },
);
httpServer.listen(port, () => {
  console.log(
    `Bili-SyncPlay global admin listening on http://localhost:${port}`,
  );
});
if (metricsHttpServer && metricsPort !== undefined) {
  metricsHttpServer.listen(metricsPort, () => {
    console.log(
      `Bili-SyncPlay global admin metrics listening on http://localhost:${metricsPort}/metrics`,
    );
  });
}
