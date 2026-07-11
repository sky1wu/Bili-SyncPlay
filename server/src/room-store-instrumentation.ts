import type { MetricsCollector } from "./admin/metrics.js";
import type { RoomStore } from "./room-store.js";

type RoomStoreMetricsCollector = Pick<
  MetricsCollector,
  "observeRedisRoomStoreDuration" | "observeRedisRoomStoreFailure"
>;

/**
 * Wraps a RoomStore so every operation reports a duration histogram sample
 * (and a failure counter on throw). Applied to the Redis-backed store only —
 * the in-memory store is synchronous and would just add noise.
 */
export function instrumentRoomStore(
  roomStore: RoomStore,
  metricsCollector: RoomStoreMetricsCollector,
): RoomStore {
  function measure<Args extends unknown[], Result>(
    operation: string,
    run: (...args: Args) => Promise<Result>,
  ): (...args: Args) => Promise<Result> {
    return async (...args: Args): Promise<Result> => {
      const startedAt = performance.now();
      try {
        return await run(...args);
      } catch (error) {
        metricsCollector.observeRedisRoomStoreFailure(operation);
        throw error;
      } finally {
        metricsCollector.observeRedisRoomStoreDuration(
          operation,
          performance.now() - startedAt,
        );
      }
    };
  }

  return {
    createRoom: measure("create_room", (input) => roomStore.createRoom(input)),
    getRoom: measure("get_room", (code) => roomStore.getRoom(code)),
    saveRoom: measure("save_room", (room) => roomStore.saveRoom(room)),
    updateRoom: measure("update_room", (code, expectedVersion, patch) =>
      roomStore.updateRoom(code, expectedVersion, patch),
    ),
    deleteRoom: measure("delete_room", (code) => roomStore.deleteRoom(code)),
    deleteExpiredRooms: measure("delete_expired_rooms", (now) =>
      roomStore.deleteExpiredRooms(now),
    ),
    listRooms: measure("list_rooms", (query) => roomStore.listRooms(query)),
    countRooms: measure("count_rooms", (query) => roomStore.countRooms(query)),
    isReady: measure("is_ready", () => roomStore.isReady()),
  };
}
