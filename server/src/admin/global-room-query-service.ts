import { createAdminRoomQueryService } from "./room-query-service.js";

export function createGlobalAdminRoomQueryService(
  options: Parameters<typeof createAdminRoomQueryService>[0],
) {
  return createAdminRoomQueryService(options);
}
