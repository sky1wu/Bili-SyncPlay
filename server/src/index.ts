import { createSyncServer } from "./app.js";
import { installGracefulShutdown } from "./bootstrap/graceful-shutdown.js";
import {
  assertMetricsPortDoesNotCollide,
  loadRuntimeConfig,
} from "./config/runtime-config.js";
import { logEffectiveOriginPolicy } from "./config/security-config.js";

// Installed before any awaited startup work: this process is PID 1 in the
// container image, so a SIGTERM arriving while the server is still connecting
// to Redis would be ignored outright and `docker stop` would fall through to
// SIGKILL.
const shutdown = installGracefulShutdown({ name: "Bili-SyncPlay server" });

const {
  port,
  metricsPort,
  logLevel,
  securityConfig,
  persistenceConfig,
  adminConfig,
  adminUiConfig,
} = await loadRuntimeConfig();

assertMetricsPortDoesNotCollide(metricsPort, port, "PORT");
logEffectiveOriginPolicy(securityConfig);

const { httpServer, metricsHttpServer, close } = await createSyncServer(
  securityConfig,
  persistenceConfig,
  {
    adminConfig,
    adminUiConfig,
    logLevel,
    metricsPort,
  },
);

// Returns false when a stop signal already arrived during startup: the teardown
// is running with the server just built, so it must not start listening.
if (shutdown.attachCloseTarget(close)) {
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
}
