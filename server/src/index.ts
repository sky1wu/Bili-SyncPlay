import { createSyncServer } from "./app.js";
import { loadRuntimeConfig } from "./config/runtime-config.js";

const {
  port,
  metricsPort,
  logLevel,
  securityConfig,
  persistenceConfig,
  adminConfig,
  adminUiConfig,
} = await loadRuntimeConfig();

const { httpServer, metricsHttpServer } = await createSyncServer(
  securityConfig,
  persistenceConfig,
  {
    adminConfig,
    adminUiConfig,
    logLevel,
    metricsPort,
  },
);
httpServer.listen(port, () => {
  console.log(`Bili-SyncPlay server listening on http://localhost:${port}`);
});
if (metricsHttpServer && metricsPort !== undefined) {
  metricsHttpServer.listen(metricsPort, () => {
    console.log(
      `Bili-SyncPlay metrics listening on http://localhost:${metricsPort}/metrics`,
    );
  });
}
