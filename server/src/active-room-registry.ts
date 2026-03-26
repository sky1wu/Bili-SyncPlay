import {
  createInMemoryRuntimeStore,
  type RuntimeStore,
} from "./runtime-store.js";

export type ActiveRoomRegistry = {
  getRoom: RuntimeStore["getRoom"];
  getOrCreateRoom: RuntimeStore["getOrCreateRoom"];
  addMember: RuntimeStore["addMember"];
  findMemberIdByToken: RuntimeStore["findMemberIdByToken"];
  blockMemberToken: RuntimeStore["blockMemberToken"];
  isMemberTokenBlocked: RuntimeStore["isMemberTokenBlocked"];
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
    findMemberIdByToken: store.findMemberIdByToken,
    blockMemberToken: store.blockMemberToken,
    isMemberTokenBlocked: store.isMemberTokenBlocked,
    removeMember: store.removeMember,
    deleteRoom: store.deleteRoom,
  };
}
