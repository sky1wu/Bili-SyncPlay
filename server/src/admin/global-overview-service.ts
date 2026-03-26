import { createAdminOverviewService } from "./overview-service.js";

export function createGlobalAdminOverviewService(
  options: Parameters<typeof createAdminOverviewService>[0],
) {
  return createAdminOverviewService({
    ...options,
    serviceName: options.serviceName || "bili-syncplay-global-admin",
  });
}
