import type { ActiveRoom, ClusterNodeStatus, Session } from "./types.js";
import {
  addMemberToRoom,
  detachSessionFromRoomIndexes,
  filterActiveBlockedMemberTokens,
  findMemberIdByTokenEntries,
  getOrCreateActiveRoom,
  type KickedMemberBlock,
  removeMemberFromRoom,
  resolveRoomCodeToLeave,
} from "./runtime-store-state.js";

type TimedEvent = {
  event: string;
  timestamp: number;
};

const COUNTER_WINDOW_MS = 60_000;

export type RuntimeStore = {
  registerSession: (session: Session) => void;
  flush?: () => Promise<void>;
  purgeSessionsByInstance?: (instanceId: string) => Promise<number>;
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
  heartbeatNode: (status: ClusterNodeStatus) => Promise<void>;
  listNodeStatuses: (currentTime?: number) => Promise<ClusterNodeStatus[]>;
  purgeNodeStatus: (instanceId: string) => Promise<void>;
  countClusterActiveRooms: () => Promise<number>;
  listClusterActiveRoomCodes: () => Promise<string[]>;
  listClusterSessionsByRoom: (roomCode: string) => Promise<Session[]>;
  listClusterSessions: () => Promise<Session[]>;
  tryClaimMessageSlot: (
    roomCode: string,
    key: string,
    expiresAt: number,
  ) => Promise<boolean>;
  releaseMessageSlot: (roomCode: string, key: string) => Promise<void>;
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
  const claimedSlotsByRoom = new Map<string, Map<string, number>>();
  const nodeStatuses = new Map<string, ClusterNodeStatus>();

  function pruneEvents(currentTime: number): void {
    while (
      timedEvents.length > 0 &&
      timedEvents[0] &&
      currentTime - timedEvents[0].timestamp > COUNTER_WINDOW_MS
    ) {
      timedEvents.shift();
    }
  }

  function pruneBlockedMemberTokens(
    code: string,
    currentTime: number,
  ): KickedMemberBlock[] {
    const entries = blockedMemberTokensByRoom.get(code) ?? [];
    const activeEntries = filterActiveBlockedMemberTokens(entries, currentTime);
    if (activeEntries.length === 0) {
      blockedMemberTokensByRoom.delete(code);
      return [];
    }
    if (activeEntries.length !== entries.length) {
      blockedMemberTokensByRoom.set(code, activeEntries);
    }
    return activeEntries;
  }

  const getOrCreateRoom = (code: string): ActiveRoom =>
    getOrCreateActiveRoom(rooms, code);

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
    async flush() {},
    async purgeSessionsByInstance() {
      return 0;
    },
    unregisterSession(sessionId) {
      const session = sessionsById.get(sessionId);
      if (!session) {
        detachSessionFromRoomIndexes(roomSessionIds, sessionId);
        return;
      }
      detachSessionFromRoomIndexes(roomSessionIds, sessionId, session.roomCode);
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
      detachSessionFromRoomIndexes(roomSessionIds, sessionId, session.roomCode);
      const ids = roomSessionIds.get(roomCode) ?? new Set<string>();
      ids.add(sessionId);
      roomSessionIds.set(roomCode, ids);
      session.roomCode = roomCode;
    },
    markSessionLeftRoom(sessionId, roomCode) {
      const session = sessionsById.get(sessionId);
      const targetRoomCode = resolveRoomCodeToLeave(
        session?.roomCode,
        roomCode,
      );
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
      return addMemberToRoom(rooms, code, memberId, session, memberToken);
    },
    findMemberIdByToken(code, memberToken) {
      const room = rooms.get(code) ?? null;
      if (!room) {
        return null;
      }
      return findMemberIdByTokenEntries(
        room.memberTokens.entries(),
        memberToken,
      );
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
    tryClaimMessageSlot(roomCode, key, expiresAt) {
      const currentTime = now();
      const roomSlots =
        claimedSlotsByRoom.get(roomCode) ?? new Map<string, number>();
      for (const [k, exp] of roomSlots) {
        if (exp <= currentTime) roomSlots.delete(k);
      }
      if (roomSlots.has(key)) {
        return Promise.resolve(false);
      }
      roomSlots.set(key, expiresAt);
      claimedSlotsByRoom.set(roomCode, roomSlots);
      return Promise.resolve(true);
    },
    releaseMessageSlot(roomCode, key) {
      claimedSlotsByRoom.get(roomCode)?.delete(key);
      return Promise.resolve();
    },
    removeMember(code, memberId, session) {
      return removeMemberFromRoom(rooms, code, memberId, session);
    },
    deleteRoom(code) {
      rooms.delete(code);
      roomSessionIds.delete(code);
      blockedMemberTokensByRoom.delete(code);
      claimedSlotsByRoom.delete(code);
    },
    async heartbeatNode(status) {
      nodeStatuses.set(status.instanceId, { ...status });
    },
    async listNodeStatuses(currentTime = now()) {
      return Array.from(nodeStatuses.values())
        .map((status): ClusterNodeStatus => {
          const health: ClusterNodeStatus["health"] =
            currentTime > status.expiresAt
              ? "offline"
              : currentTime > status.staleAt
                ? "stale"
                : "ok";

          return {
            ...status,
            health,
          };
        })
        .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    },
    async purgeNodeStatus(instanceId) {
      nodeStatuses.delete(instanceId);
    },
    async countClusterActiveRooms() {
      return roomSessionIds.size;
    },
    async listClusterActiveRoomCodes() {
      return Array.from(roomSessionIds.keys()).sort();
    },
    async listClusterSessionsByRoom(roomCode) {
      return Array.from(roomSessionIds.get(roomCode) ?? [])
        .map((sessionId) => sessionsById.get(sessionId) ?? null)
        .filter((session): session is Session => session !== null);
    },
    async listClusterSessions() {
      return Array.from(sessionsById.values());
    },
  };
}
