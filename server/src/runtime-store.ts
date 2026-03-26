import type { ActiveRoom, Session } from "./types.js";

type TimedEvent = {
  event: string;
  timestamp: number;
};

type KickedMemberBlock = {
  memberToken: string;
  expiresAt: number;
};

const COUNTER_WINDOW_MS = 60_000;

export type RuntimeStore = {
  registerSession: (session: Session) => void;
  unregisterSession: (sessionId: string) => void;
  markSessionJoinedRoom: (sessionId: string, roomCode: string) => void;
  markSessionLeftRoom: (sessionId: string, roomCode?: string | null) => void;
  recordEvent: (event: string, timestamp?: number) => void;
  getSession: (sessionId: string) => Session | null;
  listSessionsByRoom: (roomCode: string) => Session[];
  getConnectionCount: () => number;
  getActiveRoomCount: () => number;
  getActiveMemberCount: () => number;
  getStartedAt: () => number;
  getRecentEventCounts: (now?: number) => Record<string, number>;
  getLifetimeEventCounts: () => Record<string, number>;
  getActiveRoomCodes: () => Set<string>;
  getRoom: (code: string) => ActiveRoom | null;
  getOrCreateRoom: (code: string) => ActiveRoom;
  addMember: (
    code: string,
    memberId: string,
    session: Session,
    memberToken: string,
  ) => ActiveRoom;
  findMemberIdByToken: (code: string, memberToken: string) => string | null;
  blockMemberToken: (
    code: string,
    memberToken: string,
    expiresAt: number,
  ) => void;
  isMemberTokenBlocked: (
    code: string,
    memberToken: string,
    currentTime?: number,
  ) => boolean;
  removeMember: (
    code: string,
    memberId: string,
    session?: Session,
  ) => { room: ActiveRoom | null; roomEmpty: boolean };
  deleteRoom: (code: string) => void;
};

export function createInMemoryRuntimeStore(
  now: () => number = Date.now,
): RuntimeStore {
  const startedAt = now();
  const sessionsById = new Map<string, Session>();
  const sessionIdsByRemoteAddress = new Map<string, Set<string>>();
  const roomSessionIds = new Map<string, Set<string>>();
  const timedEvents: TimedEvent[] = [];
  const lifetimeEventCounts: Record<string, number> = {};
  const rooms = new Map<string, ActiveRoom>();
  const blockedMemberTokensByRoom = new Map<string, KickedMemberBlock[]>();

  function pruneEvents(currentTime: number): void {
    while (
      timedEvents.length > 0 &&
      timedEvents[0] &&
      currentTime - timedEvents[0].timestamp > COUNTER_WINDOW_MS
    ) {
      timedEvents.shift();
    }
  }

  function detachSessionFromRooms(
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

  function pruneBlockedMemberTokens(
    code: string,
    currentTime: number,
  ): KickedMemberBlock[] {
    const entries = blockedMemberTokensByRoom.get(code) ?? [];
    const activeEntries = entries.filter(
      (entry) => entry.expiresAt > currentTime,
    );
    if (activeEntries.length === 0) {
      blockedMemberTokensByRoom.delete(code);
      return [];
    }
    if (activeEntries.length !== entries.length) {
      blockedMemberTokensByRoom.set(code, activeEntries);
    }
    return activeEntries;
  }

  function getOrCreateRoom(code: string): ActiveRoom {
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

  return {
    registerSession(session) {
      sessionsById.set(session.id, session);
      if (session.remoteAddress) {
        const ids =
          sessionIdsByRemoteAddress.get(session.remoteAddress) ??
          new Set<string>();
        ids.add(session.id);
        sessionIdsByRemoteAddress.set(session.remoteAddress, ids);
      }
    },
    unregisterSession(sessionId) {
      const session = sessionsById.get(sessionId);
      if (!session) {
        detachSessionFromRooms(sessionId);
        return;
      }
      detachSessionFromRooms(sessionId, session.roomCode);
      if (session.remoteAddress) {
        const ids = sessionIdsByRemoteAddress.get(session.remoteAddress);
        ids?.delete(sessionId);
        if (ids && ids.size === 0) {
          sessionIdsByRemoteAddress.delete(session.remoteAddress);
        }
      }
      sessionsById.delete(sessionId);
    },
    markSessionJoinedRoom(sessionId, roomCode) {
      const session = sessionsById.get(sessionId);
      if (!session) {
        return;
      }
      detachSessionFromRooms(sessionId, session.roomCode);
      const ids = roomSessionIds.get(roomCode) ?? new Set<string>();
      ids.add(sessionId);
      roomSessionIds.set(roomCode, ids);
      session.roomCode = roomCode;
    },
    markSessionLeftRoom(sessionId, roomCode) {
      const session = sessionsById.get(sessionId);
      const targetRoomCode = roomCode ?? session?.roomCode ?? null;
      if (!targetRoomCode) {
        return;
      }
      const ids = roomSessionIds.get(targetRoomCode);
      ids?.delete(sessionId);
      if (ids && ids.size === 0) {
        roomSessionIds.delete(targetRoomCode);
      }
      if (session && session.roomCode === targetRoomCode) {
        session.roomCode = null;
      }
    },
    recordEvent(event, timestamp = now()) {
      timedEvents.push({ event, timestamp });
      lifetimeEventCounts[event] = (lifetimeEventCounts[event] ?? 0) + 1;
      pruneEvents(timestamp);
    },
    getSession(sessionId) {
      return sessionsById.get(sessionId) ?? null;
    },
    listSessionsByRoom(roomCode) {
      const ids = roomSessionIds.get(roomCode);
      if (!ids) {
        return [];
      }
      return Array.from(ids)
        .map((sessionId) => sessionsById.get(sessionId) ?? null)
        .filter((session): session is Session => session !== null);
    },
    getConnectionCount() {
      return sessionsById.size;
    },
    getActiveRoomCount() {
      return roomSessionIds.size;
    },
    getActiveMemberCount() {
      let count = 0;
      for (const ids of roomSessionIds.values()) {
        count += ids.size;
      }
      return count;
    },
    getStartedAt() {
      return startedAt;
    },
    getRecentEventCounts(currentTime = now()) {
      pruneEvents(currentTime);
      const counts: Record<string, number> = {};
      for (const item of timedEvents) {
        counts[item.event] = (counts[item.event] ?? 0) + 1;
      }
      return counts;
    },
    getLifetimeEventCounts() {
      return { ...lifetimeEventCounts };
    },
    getActiveRoomCodes() {
      return new Set(roomSessionIds.keys());
    },
    getRoom(code) {
      return rooms.get(code) ?? null;
    },
    getOrCreateRoom,
    addMember(code, memberId, session, memberToken) {
      const room = getOrCreateRoom(code);
      room.members.set(memberId, session);
      room.memberTokens.set(memberId, memberToken);
      return room;
    },
    findMemberIdByToken(code, memberToken) {
      const room = rooms.get(code) ?? null;
      if (!room) {
        return null;
      }

      for (const [memberId, token] of room.memberTokens.entries()) {
        if (token === memberToken) {
          return memberId;
        }
      }
      return null;
    },
    blockMemberToken(code, memberToken, expiresAt) {
      const activeEntries = pruneBlockedMemberTokens(code, now());
      activeEntries.push({ memberToken, expiresAt });
      blockedMemberTokensByRoom.set(code, activeEntries);
    },
    isMemberTokenBlocked(code, memberToken, currentTime = now()) {
      const activeEntries = pruneBlockedMemberTokens(code, currentTime);
      return activeEntries.some((entry) => entry.memberToken === memberToken);
    },
    removeMember(code, memberId, session) {
      const room = rooms.get(code) ?? null;
      if (!room) {
        return { room: null, roomEmpty: true };
      }

      if (session) {
        const currentSession = room.members.get(memberId);
        if (currentSession && currentSession !== session) {
          return { room, roomEmpty: false };
        }
      }

      room.members.delete(memberId);
      room.memberTokens.delete(memberId);
      const roomEmpty = room.members.size === 0;
      if (roomEmpty) {
        rooms.delete(code);
      }
      return { room: roomEmpty ? null : room, roomEmpty };
    },
    deleteRoom(code) {
      rooms.delete(code);
      roomSessionIds.delete(code);
      blockedMemberTokensByRoom.delete(code);
    },
  };
}
