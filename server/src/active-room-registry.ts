import {
  createInMemoryRuntimeStore,
  type RuntimeStore,
} from "./runtime-store.js";

export type ActiveRoomRegistry = {
  getRoom: RuntimeStore["getRoom"];
  getOrCreateRoom: RuntimeStore["getOrCreateRoom"];
  addMember: RuntimeStore["addMember"];
  listClusterSessionsByRoom: RuntimeStore["listClusterSessionsByRoom"];
  findMemberIdByToken: RuntimeStore["findMemberIdByToken"];
  blockMemberToken: RuntimeStore["blockMemberToken"];
  isMemberTokenBlocked: RuntimeStore["isMemberTokenBlocked"];
  tryClaimMessageSlot: RuntimeStore["tryClaimMessageSlot"];
  releaseMessageSlot: RuntimeStore["releaseMessageSlot"];
  acquireRoomLock: RuntimeStore["acquireRoomLock"];
  releaseRoomLock: RuntimeStore["releaseRoomLock"];
  removeMember: RuntimeStore["removeMember"];
  deleteRoom: RuntimeStore["deleteRoom"];
};

export function createActiveRoomRegistry(
  now: () => number = Date.now,
): ActiveRoomRegistry {
  const store = createInMemoryRuntimeStore(now);
  return {
    getRoom: store.getRoom,
    getOrCreateRoom: store.getOrCreateRoom,
    addMember: store.addMember,
    async listClusterSessionsByRoom(roomCode) {
      return Array.from(store.getRoom(roomCode)?.members.values() ?? []);
    },
    findMemberIdByToken: store.findMemberIdByToken,
    blockMemberToken: store.blockMemberToken,
    isMemberTokenBlocked: store.isMemberTokenBlocked,
    tryClaimMessageSlot: store.tryClaimMessageSlot,
    releaseMessageSlot: store.releaseMessageSlot,
    acquireRoomLock: store.acquireRoomLock,
    releaseRoomLock: store.releaseRoomLock,
    removeMember: store.removeMember,
    deleteRoom: store.deleteRoom,
  };
}
