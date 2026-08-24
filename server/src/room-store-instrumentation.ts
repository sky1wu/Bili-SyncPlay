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
 * Redis 版实现额外带两个 RoomStore 契约之外的钩子:关服用的 close() (按结构
 * 探测,见 server-bootstrap 的 hasClose),以及索引对账 reconcileRoomIndex()
 * (由 createRoomIndexReconciler 定时驱动)。把它们写进类型里,包装前后都不必
 * 强转。
 */
export type MaintainableRoomStore = RoomStore & {
  close?: () => Promise<void>;
  reconcileRoomIndex?: () => Promise<void>;
};

export function instrumentRoomStore(
  roomStore: MaintainableRoomStore,
  metricsCollector: RoomStoreMetricsCollector,
): MaintainableRoomStore {
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
    listNeverExpiringRooms: measure(
      "list_never_expiring_rooms",
      (limit, offset) => roomStore.listNeverExpiringRooms(limit, offset),
    ),
    getRoom: measure("get_room", (code, caller) =>
      roomStore.getRoom(code, caller),
    ),
    updateRoom: measure(
      "update_room",
      // Every parameter forwarded by name: a wrapper that declares fewer than
      // the type it is assigned to still typechecks, and silently drops the
      // ones it left out (AGENTS.md).
      (code, expectedVersion, patch, options) =>
        roomStore.updateRoom(code, expectedVersion, patch, options),
    ),
    deleteRoom: measure("delete_room", (expected) =>
      roomStore.deleteRoom(expected),
    ),
    deleteExpiredRoom: measure("delete_expired_room", (code, currentTime) =>
      roomStore.deleteExpiredRoom(code, currentTime),
    ),
    deleteExpiredRooms: measure("delete_expired_rooms", (now) =>
      roomStore.deleteExpiredRooms(now),
    ),
    listRooms: measure("list_rooms", (query) => roomStore.listRooms(query)),
    countRooms: measure("count_rooms", (query) => roomStore.countRooms(query)),
    isReady: measure("is_ready", () => roomStore.isReady()),
  };

  if (typeof roomStore.acknowledgeOrphanedIndexClaims === "function") {
    instrumented.acknowledgeOrphanedIndexClaims = measure(
      "acknowledge_orphaned_index_claims",
      roomStore.acknowledgeOrphanedIndexClaims.bind(roomStore),
    );
  }

  // Both implementation hooks must survive wrapping: losing close() would
  // leak the Redis connection, and losing reconcileRoomIndex() would silently
  // stop the index from ever converging again — a rolling upgrade's rooms
  // would go unreaped with nothing failing. The optional RoomStore operation
  // above is deliberately part of `instrumented` instead: production room
  // services call through this wrapper and must both retain and measure it.
  const hooks: Pick<MaintainableRoomStore, "close" | "reconcileRoomIndex"> = {};
  if (typeof roomStore.close === "function") {
    hooks.close = roomStore.close.bind(roomStore);
  }
  if (typeof roomStore.reconcileRoomIndex === "function") {
    hooks.reconcileRoomIndex = measure(
      "reconcile_room_index",
      roomStore.reconcileRoomIndex.bind(roomStore),
    );
  }
  return Object.assign(instrumented, hooks);
}
