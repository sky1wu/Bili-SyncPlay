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
 * Durable-first write: the SHARED store goes first and the local mirror is only
 * updated once it succeeded, so the caller can both wait for durability and
 * trust that a rejection changed nothing.
 *
 * Order matters. Writing locally first left a partial apply behind on failure —
 * the kick's revoke rejected after the local token was already gone, so the
 * admin was told the kick failed while the member stayed connected with a
 * member token nothing would accept, failing every later request (#237 review).
 * `mirrorVoidWrite` additionally drops the promise, which would leave the kick
 * awaiting nothing at all.
 */
function mirrorAwaitedWrite<TArgs extends unknown[]>(
  localMethod: (...args: TArgs) => unknown,
  sharedMethod: (...args: TArgs) => void | Promise<void>,
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    await sharedMethod(...args);
    localMethod(...args);
  };
}

/**
 * Runs a conditional teardown against the SHARED store and mirrors it locally
 * only once that reported it applied.
 *
 * The condition can only be judged where the generation lives, which is the
 * shared store — this store no longer keeps a local copy. Handing the expected
 * generation to the local delete as well compared it against a value that is
 * always `null`: a legacy room (expected `null`) wiped the local state even when
 * the shared side went on to decline, and an ordinary room (expected non-null)
 * could never clear the local mirror at all (#237 review).
 */
function mirrorConditionalTeardown(
  localDelete: RuntimeStore["deleteRoom"],
  sharedDelete: RuntimeStore["deleteRoom"],
): RuntimeStore["deleteRoom"] {
  return async (code, expectedGeneration) => {
    const applied = await sharedDelete(code, expectedGeneration);
    if (applied) {
      localDelete(code);
    }
    return applied;
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
    // Awaited for the same reason as `markSessionLeftRoom`: the join's own
    // bootstrap `room:state` is rebuilt from the index this write maintains.
    markSessionJoinedRoom: mirrorAwaitedWrite(
      localRuntimeStore.markSessionJoinedRoom,
      sharedRuntimeStore.markSessionJoinedRoom,
    ),
    // Awaited, not fire-and-forget: callers act on whether the index write
    // landed, and `mirrorVoidWrite` drops the promise that carries the answer
    // (#235 review).
    markSessionLeftRoom: mirrorAwaitedWrite(
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
    // The local result decides membership (see `leaveCurrentRoom`), but the
    // SHARED store owns the durable write — so its `durable` has to ride along
    // rather than be dropped, or the caller cannot tell whether the member view
    // it reads next reflects this removal (#235 review).
    removeMember: (code, memberId, session) => {
      const localRemoval = localRuntimeStore.removeMember(
        code,
        memberId,
        session,
      );
      const sharedRemoval = sharedRuntimeStore.removeMember(
        code,
        memberId,
        session,
      );
      return { ...localRemoval, durable: sharedRemoval.durable };
    },
    evictMemberToken: mirrorAwaitedWrite(
      localRuntimeStore.evictMemberToken,
      sharedRuntimeStore.evictMemberToken,
    ),
    revokeMemberToken: mirrorAwaitedWrite(
      localRuntimeStore.revokeMemberToken,
      sharedRuntimeStore.revokeMemberToken,
    ),
    // Read from the shared view: the generation has to be the one every node
    // agrees on, or a teardown decided here would compare against a local copy.
    hasRoomResidue: readShared(sharedRuntimeStore.hasRoomResidue),
    getRoomGeneration: readShared(sharedRuntimeStore.getRoomGeneration),
    // Shared only, in both directions. A local copy would be written by whichever
    // node created the room and cleared by whichever node tore it down — rarely
    // the same one — so every node accumulated generations for rooms it merely
    // happened to create, with nothing to expire them (#237 review). Nothing
    // reads the local copy here anyway: the reads above go to the shared store,
    // and the shared store's own teardown clears its local mirror unconditionally.
    markRoomGeneration: readShared(sharedRuntimeStore.markRoomGeneration),
    deleteRoom: mirrorConditionalTeardown(
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
