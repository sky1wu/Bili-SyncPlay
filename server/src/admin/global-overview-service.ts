import { createAdminOverviewService } from "./overview-service.js";

export function createGlobalAdminOverviewService(
  options: Parameters<typeof createAdminOverviewService>[0],
) {
  return createAdminOverviewService({
    ...options,
    serviceName: options.serviceName || "bili-syncplay-global-admin",
    // The standalone control plane owns a RuntimeStore for shared reads, but
    // it is not a room node and must not appear in the node inventory.
    includeLocalNodeFallback: false,
  });
}
