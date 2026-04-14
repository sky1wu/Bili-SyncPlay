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
  room.memberTokens.delete(memberId);
  const roomEmpty = room.members.size === 0;
  if (roomEmpty) {
    rooms.delete(code);
  }
  return { room: roomEmpty ? null : room, roomEmpty, removed: existed };
}
