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
/**
 * Redis 版实现额外带一个 RoomStore 契约之外的 close() 钩子,关服时按结构探测
 * (见 server-bootstrap 的 hasClose)。把它写进类型里,包装前后都不必强转。
 */
export type CloseableRoomStore = RoomStore & {
  close?: () => Promise<void>;
};

export function instrumentRoomStore(
  roomStore: CloseableRoomStore,
  metricsCollector: RoomStoreMetricsCollector,
): CloseableRoomStore {
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

  const instrumented: RoomStore = {
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

  // close() must survive wrapping or server.close() would leak the Redis
  // connection.
  if (typeof roomStore.close === "function") {
    const close = roomStore.close.bind(roomStore);
    return Object.assign(instrumented, { close });
  }
  return instrumented;
}
