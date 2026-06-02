import { createSyncServer } from "./app.js";
import {
  assertMetricsPortDoesNotCollide,
  loadRuntimeConfig,
} from "./config/runtime-config.js";
import { logEffectiveOriginPolicy } from "./config/security-config.js";

const {
  port,
  metricsPort,
  logLevel,
  securityConfig,
  persistenceConfig,
  adminConfig,
  adminUiConfig,
  voiceConfig,
} = await loadRuntimeConfig();

assertMetricsPortDoesNotCollide(metricsPort, port, "PORT");
logEffectiveOriginPolicy(securityConfig);

const { httpServer, metricsHttpServer } = await createSyncServer(
  securityConfig,
  persistenceConfig,
  {
    adminConfig,
    adminUiConfig,
    logLevel,
    metricsPort,
    voiceConfig,
  },
);
httpServer.listen(port, () => {
  console.log(`Bili-SyncPlay server listening on http://localhost:${port}`);
});
if (metricsHttpServer && metricsPort !== undefined) {
  metricsHttpServer.on("error", (error) => {
    console.error(
      `Bili-SyncPlay metrics server failed to listen on ${metricsPort}:`,
      error,
    );
    process.exit(1);
  });
  metricsHttpServer.listen(metricsPort, () => {
    console.log(
      `Bili-SyncPlay metrics listening on http://localhost:${metricsPort}/metrics`,
    );
  });
}
