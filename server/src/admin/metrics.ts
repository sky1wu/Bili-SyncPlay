import type { RuntimeStore } from "../runtime-store.js";
import type { RoomStore } from "../room-store.js";

export function createMetricsService(options: {
  runtimeStore: RuntimeStore;
  roomStore: RoomStore;
}) {
  return {
    async render(): Promise<string> {
      const totals = options.runtimeStore.getLifetimeEventCounts();
      const totalNonExpired = await options.roomStore.countRooms({
        keyword: undefined,
        includeExpired: false,
      });

      const lines = [
        "# HELP bili_syncplay_connections Current websocket connection count",
        "# TYPE bili_syncplay_connections gauge",
        `bili_syncplay_connections ${options.runtimeStore.getConnectionCount()}`,
        "# HELP bili_syncplay_active_rooms Current active room count",
        "# TYPE bili_syncplay_active_rooms gauge",
        `bili_syncplay_active_rooms ${options.runtimeStore.getActiveRoomCount()}`,
        "# HELP bili_syncplay_rooms_non_expired Current non-expired room count",
        "# TYPE bili_syncplay_rooms_non_expired gauge",
        `bili_syncplay_rooms_non_expired ${totalNonExpired}`,
        "# HELP bili_syncplay_room_created_total Total room_created events",
        "# TYPE bili_syncplay_room_created_total counter",
        `bili_syncplay_room_created_total ${totals.room_created ?? 0}`,
        "# HELP bili_syncplay_room_joined_total Total room_joined events",
        "# TYPE bili_syncplay_room_joined_total counter",
        `bili_syncplay_room_joined_total ${totals.room_joined ?? 0}`,
        "# HELP bili_syncplay_ws_connection_rejected_total Total rejected websocket upgrades",
        "# TYPE bili_syncplay_ws_connection_rejected_total counter",
        `bili_syncplay_ws_connection_rejected_total ${totals.ws_connection_rejected ?? 0}`,
        "# HELP bili_syncplay_rate_limited_total Total rate_limited events",
        "# TYPE bili_syncplay_rate_limited_total counter",
        `bili_syncplay_rate_limited_total ${totals.rate_limited ?? 0}`,
      ];

      return `${lines.join("\n")}\n`;
    },
  };
}
