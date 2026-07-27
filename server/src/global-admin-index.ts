import { installGracefulShutdown } from "./bootstrap/graceful-shutdown.js";
import {
  assertMetricsPortDoesNotCollide,
  loadRuntimeConfig,
} from "./config/runtime-config.js";
import { logEffectiveOriginPolicy } from "./config/security-config.js";
import { createGlobalAdminServer } from "./global-admin-app.js";

// Installed before any awaited startup work — see the note in index.ts.
const shutdown = installGracefulShutdown({
  name: "Bili-SyncPlay global admin",
});

const {
  globalAdminPort: port,
  metricsPort,
  logLevel,
  securityConfig,
  persistenceConfig,
  adminConfig,
  adminUiConfig,
} = await loadRuntimeConfig();

assertMetricsPortDoesNotCollide(metricsPort, port, "GLOBAL_ADMIN_PORT");
logEffectiveOriginPolicy(securityConfig);

const { httpServer, metricsHttpServer, close } = await createGlobalAdminServer(
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

if (shutdown.attachCloseTarget(close)) {
  httpServer.listen(port, () => {
    console.log(
      `Bili-SyncPlay global admin listening on http://localhost:${port}`,
    );
  });
  if (metricsHttpServer && metricsPort !== undefined) {
    metricsHttpServer.on("error", (error) => {
      console.error(
        `Bili-SyncPlay global admin metrics server failed to listen on ${metricsPort}:`,
        error,
      );
      process.exit(1);
    });
    metricsHttpServer.listen(metricsPort, () => {
      console.log(
        `Bili-SyncPlay global admin metrics listening on http://localhost:${metricsPort}/metrics`,
      );
    });
  }
}
