import type { ActiveRoom, Session } from "./types.js";

export type KickedMemberBlock = {
  memberToken: string;
  expiresAt: number;
};

export function getPreviousRoomToLeave(
  currentRoomCode: string | null | undefined,
  nextRoomCode: string,
): string | null {
  if (!currentRoomCode || currentRoomCode === nextRoomCode) {
    return null;
  }
  return currentRoomCode;
}

export function resolveRoomCodeToLeave(
  currentRoomCode: string | null | undefined,
  requestedRoomCode?: string | null,
): string | null {
  return requestedRoomCode ?? currentRoomCode ?? null;
}

export function detachSessionFromRoomIndexes(
  roomSessionIds: Map<string, Set<string>>,
  sessionId: string,
  preferredRoomCode?: string | null,
): void {
  const candidateRoomCodes = preferredRoomCode
    ? [preferredRoomCode, ...roomSessionIds.keys()]
    : roomSessionIds.keys();
  const visited = new Set<string>();

  for (const roomCode of candidateRoomCodes) {
    if (visited.has(roomCode)) {
      continue;
    }
    visited.add(roomCode);

    const ids = roomSessionIds.get(roomCode);
    ids?.delete(sessionId);
    if (ids && ids.size === 0) {
      roomSessionIds.delete(roomCode);
    }
  }
}

export function getOrCreateActiveRoom(
  rooms: Map<string, ActiveRoom>,
  code: string,
): ActiveRoom {
  const existingRoom = rooms.get(code);
  if (existingRoom) {
    return existingRoom;
  }

  const room: ActiveRoom = {
    code,
    members: new Map(),
    memberTokens: new Map(),
  };
  rooms.set(code, room);
  return room;
}

export function addMemberToRoom(
  rooms: Map<string, ActiveRoom>,
  code: string,
  memberId: string,
  session: Session,
  memberToken: string,
): ActiveRoom {
  const room = getOrCreateActiveRoom(rooms, code);
  room.members.set(memberId, session);
  room.memberTokens.set(memberId, memberToken);
  return room;
}

export function findMemberIdByTokenEntries(
  entries: Iterable<readonly [string, string]>,
  memberToken: string,
): string | null {
  for (const [memberId, token] of entries) {
    if (token === memberToken) {
      return memberId;
    }
  }
  return null;
}

export function filterActiveBlockedMemberTokens(
  entries: KickedMemberBlock[],
  currentTime: number,
): KickedMemberBlock[] {
  return entries.filter((entry) => entry.expiresAt > currentTime);
}

export function shouldRemoveMemberBinding(
  currentSessionId: string | null,
  expectedSessionId?: string,
): boolean {
  return (
    !expectedSessionId ||
    !currentSessionId ||
    currentSessionId === expectedSessionId
  );
}

/**
 * Drop a member's *presence*. Their `memberToken` is deliberately left behind.
 *
 * A disconnect is not a departure: the client still holds the token and will
 * present it on the next `room:join` to reclaim the same `memberId`
 * (`buildJoinIdentity`). Deleting it here revoked identity on every socket
 * close, so even a brief network blip — and every server restart, which closes
 * every socket at once — handed everybody a fresh `memberId`. Anything keyed on
 * the old one then pointed at nobody, most visibly
 * `sharedVideo.sharedByMemberId`: after a restart no member matched it, every
 * client evaluated `isLocalSharedSource()` as false, and the room could no
 * longer advance to the next video (#234).
 *
 * Revocation is a separate, deliberate act — see {@link revokeMemberTokenInRoom},
 * called on an explicit `room:leave`, on an admin kick, and when the room dies.
 */
export function removeMemberFromRoom(
  rooms: Map<string, ActiveRoom>,
  code: string,
  memberId: string,
  session?: Session,
): { room: ActiveRoom | null; roomEmpty: boolean; removed: boolean } {
  const room = rooms.get(code) ?? null;
  if (!room) {
    return { room: null, roomEmpty: true, removed: false };
  }

  if (session) {
    const currentSession = room.members.get(memberId);
    if (currentSession && currentSession !== session) {
      return { room, roomEmpty: false, removed: false };
    }
  }

  const existed = room.members.delete(memberId);
  const roomEmpty = room.members.size === 0;
  // `roomEmpty` stays a statement about *members*, which is what every caller
  // means by it. The entry itself only goes once no identity is left to
  // reclaim, otherwise the last member to disconnect would take everyone's
  // tokens down with the room. Room counters read `roomSessionIds`, not this
  // map, so a token-only entry inflates nothing.
  if (roomEmpty && room.memberTokens.size === 0) {
    rooms.delete(code);
  }
  return { room: roomEmpty ? null : room, roomEmpty, removed: existed };
}

/**
 * Revoke a member's identity: after this, their `memberToken` no longer reclaims
 * their `memberId` and a rejoin is issued a new one. The counterpart to
 * {@link removeMemberFromRoom}, which only drops presence.
 */
export function revokeMemberTokenInRoom(
  rooms: Map<string, ActiveRoom>,
  code: string,
  memberId: string,
): boolean {
  const room = rooms.get(code) ?? null;
  if (!room) {
    return false;
  }
  const revoked = room.memberTokens.delete(memberId);
  if (room.members.size === 0 && room.memberTokens.size === 0) {
    rooms.delete(code);
  }
  return revoked;
}
