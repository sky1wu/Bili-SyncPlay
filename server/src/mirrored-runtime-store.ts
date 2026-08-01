import type { RuntimeStore } from "./runtime-store.js";

function mirrorVoidWrite<TArgs extends unknown[]>(
  localMethod: (...args: TArgs) => void,
  sharedMethod: (...args: TArgs) => unknown,
): (...args: TArgs) => void {
  return (...args: TArgs) => {
    localMethod(...args);
    sharedMethod(...args);
  };
}

/**
 * Mirrors the write and hands back the SHARED store's promise, so the caller can
 * wait for durability. `mirrorVoidWrite` drops it, which would leave the kick
 * awaiting nothing in a mirrored deployment — exactly the gap the awaitable
 * revoke exists to close (#237 review).
 */
function mirrorAwaitedWrite<TArgs extends unknown[]>(
  localMethod: (...args: TArgs) => unknown,
  sharedMethod: (...args: TArgs) => void | Promise<void>,
): (...args: TArgs) => void | Promise<void> {
  return (...args: TArgs) => {
    localMethod(...args);
    return sharedMethod(...args);
  };
}

function mirrorLocalResult<TArgs extends unknown[], TResult>(
  localMethod: (...args: TArgs) => TResult,
  sharedMethod: (...args: TArgs) => unknown,
): (...args: TArgs) => TResult {
  return (...args: TArgs) => {
    const result = localMethod(...args);
    void sharedMethod(...args);
    return result;
  };
}

function readLocal<TArgs extends unknown[], TResult>(
  localMethod: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return (...args: TArgs) => localMethod(...args);
}

function readShared<TArgs extends unknown[], TResult>(
  sharedMethod: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return (...args: TArgs) => sharedMethod(...args);
}

export function createMirroredRuntimeStore(
  localRuntimeStore: RuntimeStore,
  sharedRuntimeStore: RuntimeStore,
): RuntimeStore {
  return {
    registerSession: mirrorVoidWrite(
      localRuntimeStore.registerSession,
      sharedRuntimeStore.registerSession,
    ),
    flush: sharedRuntimeStore.flush
      ? readShared(sharedRuntimeStore.flush)
      : undefined,
    purgeSessionsByInstance: sharedRuntimeStore.purgeSessionsByInstance
      ? readShared(sharedRuntimeStore.purgeSessionsByInstance)
      : undefined,
    unregisterSession: mirrorVoidWrite(
      localRuntimeStore.unregisterSession,
      sharedRuntimeStore.unregisterSession,
    ),
    markSessionJoinedRoom: mirrorVoidWrite(
      localRuntimeStore.markSessionJoinedRoom,
      sharedRuntimeStore.markSessionJoinedRoom,
    ),
    markSessionLeftRoom: mirrorVoidWrite(
      localRuntimeStore.markSessionLeftRoom,
      sharedRuntimeStore.markSessionLeftRoom,
    ),
    recordEvent: mirrorVoidWrite(
      localRuntimeStore.recordEvent,
      sharedRuntimeStore.recordEvent,
    ),
    getSession: readLocal(localRuntimeStore.getSession),
    listSessionsByRoom: readLocal(localRuntimeStore.listSessionsByRoom),
    getConnectionCount: readLocal(localRuntimeStore.getConnectionCount),
    getActiveRoomCount: readLocal(localRuntimeStore.getActiveRoomCount),
    getActiveMemberCount: readLocal(localRuntimeStore.getActiveMemberCount),
    getStartedAt: readLocal(localRuntimeStore.getStartedAt),
    getRecentEventCounts: readLocal(localRuntimeStore.getRecentEventCounts),
    getLifetimeEventCounts: readLocal(localRuntimeStore.getLifetimeEventCounts),
    getActiveRoomCodes: readLocal(localRuntimeStore.getActiveRoomCodes),
    getRoom: readLocal(localRuntimeStore.getRoom),
    getOrCreateRoom: readLocal(localRuntimeStore.getOrCreateRoom),
    addMember: mirrorLocalResult(
      localRuntimeStore.addMember,
      sharedRuntimeStore.addMember,
    ),
    findMemberIdByToken: readLocal(localRuntimeStore.findMemberIdByToken),
    blockMemberToken: mirrorAwaitedWrite(
      localRuntimeStore.blockMemberToken,
      sharedRuntimeStore.blockMemberToken,
    ),
    isMemberTokenBlocked: readLocal(localRuntimeStore.isMemberTokenBlocked),
    tryClaimMessageSlot: readShared(sharedRuntimeStore.tryClaimMessageSlot),
    releaseMessageSlot: readShared(sharedRuntimeStore.releaseMessageSlot),
    acquireRoomLock: readShared(sharedRuntimeStore.acquireRoomLock),
    releaseRoomLock: readShared(sharedRuntimeStore.releaseRoomLock),
    removeMember: mirrorLocalResult(
      localRuntimeStore.removeMember,
      sharedRuntimeStore.removeMember,
    ),
    revokeMemberToken: mirrorAwaitedWrite(
      localRuntimeStore.revokeMemberToken,
      sharedRuntimeStore.revokeMemberToken,
    ),
    deleteRoom: mirrorVoidWrite(
      localRuntimeStore.deleteRoom,
      sharedRuntimeStore.deleteRoom,
    ),
    heartbeatNode: readShared(sharedRuntimeStore.heartbeatNode),
    listNodeStatuses: readShared(sharedRuntimeStore.listNodeStatuses),
    purgeNodeStatus: mirrorLocalResult(
      localRuntimeStore.purgeNodeStatus,
      sharedRuntimeStore.purgeNodeStatus,
    ),
    countClusterActiveRooms: readShared(
      sharedRuntimeStore.countClusterActiveRooms,
    ),
    listClusterActiveRoomCodes: readShared(
      sharedRuntimeStore.listClusterActiveRoomCodes,
    ),
    listClusterSessionsByRoom: readShared(
      sharedRuntimeStore.listClusterSessionsByRoom,
    ),
    listClusterSessions: readShared(sharedRuntimeStore.listClusterSessions),
  };
}
