import type { ActiveRoom, ClusterNodeStatus, Session } from "./types.js";
import {
  addMemberToRoom,
  detachSessionFromRoomIndexes,
  filterActiveBlockedMemberTokens,
  findMemberIdByTokenEntries,
  getOrCreateActiveRoom,
  type KickedMemberBlock,
  removeMemberFromRoom,
  revokeMemberTokenInRoom,
  resolveRoomCodeToLeave,
} from "./runtime-store-state.js";

type TimedEvent = {
  event: string;
  timestamp: number;
};

const COUNTER_WINDOW_MS = 60_000;

/**
 * Who is waiting on a cluster read, and therefore what bounds its commands.
 *
 * Two of these reads serve both an HTTP request and a `maintenance-pass` tick,
 * and the two want opposite treatment: the pass derives `stalled` from its call
 * not coming back, so capping it lets the next tick run a second pass on top of
 * the first (#261, #263) — while an HTTP handler has nothing behind it at all.
 * Node's `requestTimeout` is NOT a backstop for the second case: it bounds
 * RECEIVING a request, not producing its response, so a handler awaiting a
 * stalled Redis is never answered (measured, #277 review).
 *
 * So the bound is chosen per CALL, exactly as it is for `loadSession` inside
 * the Redis store, and this parameter is how the call says which. Required, so
 * a new call site cannot inherit the wrong one by saying nothing.
 */
export type RuntimeReadCaller = "request" | "maintenance_pass";

export type RuntimeStore = {
  /**
   * Record the full session snapshot. The returned promise, where the store has
   * a durable step, settles once that write is confirmed and REJECTS when it is
   * not.
   *
   * Nothing is obliged to await it — the join path deliberately does not, see
   * `markSessionJoinedRoom` — but a silently swallowed outcome was how a lost
   * registration used to leave a session hash that later writes only ever
   * patched a single field into, which `loadSession` reads as "no such session"
   * (#242).
   */
  registerSession: (session: Session) => void | Promise<void>;
  /**
   * The queue has EMPTIED. Says nothing about whether the writes in it landed:
   * it waits on error-swallowed copies, so a failed write drains exactly like a
   * successful one.
   *
   * Use it when the point is ordering — "my own writes are visible to the read I
   * am about to do". When the point is durability, use
   * {@link RuntimeStore.confirmWrites}; conflating the two is what let #235's
   * fixes be built on unconfirmed data (#242).
   */
  flush?: () => Promise<void>;
  /**
   * Every queued session write has been CONFIRMED; rejects with an
   * `AggregateError` naming the ones that were not.
   *
   * Store-wide, not per session: it answers "is the shared view of this node's
   * sessions complete", which is the question a sweep or a shutdown asks. A
   * caller that only needs its OWN write confirmed should await that write —
   * `registerSession`, `markSessionJoinedRoom` and `markSessionLeftRoom` all
   * report their real outcome.
   */
  confirmWrites?: () => Promise<void>;
  purgeSessionsByInstance?: (instanceId: string) => Promise<number>;
  unregisterSession: (sessionId: string) => void;
  /**
   * Awaitable, and it rejects when the index write fails — the same contract as
   * `markSessionLeftRoom`, and for a mirror-image reason: the join's own
   * bootstrap `room:state` is rebuilt from this index, so a write that has not
   * landed produces a state missing the member who just joined, and every
   * ownership decision taken from it is wrong (#235 review).
   *
   * It also re-writes the WHOLE session record, not just the room code. A store
   * with a durable step cannot assume `registerSession` landed, and a join that
   * patched only `roomCode` on top of a missing registration produced a session
   * hash with no `id` — which reads back as no session at all, so the joiner was
   * absent from every state built from the shared view (#242). Folding the two
   * into one write means the join either seats the member completely or not at
   * all, and a lost registration heals at the next join.
   */
  markSessionJoinedRoom: (sessionId: string, roomCode: string) => Promise<void>;
  /**
   * Awaitable, and it rejects when the index write fails.
   *
   * Unlike its `markSessionJoinedRoom` sibling, callers ACT on the answer: a
   * `room:state` built while this write is outstanding — or after it failed —
   * still lists the session, so the member who just left reappears in the
   * snapshot and can win the share back (#235 review). A fire-and-forget
   * version cannot tell them apart from success.
   */
  markSessionLeftRoom: (
    sessionId: string,
    roomCode?: string | null,
  ) => Promise<void>;
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
  /**
   * Evict a member: block their token AND end their identity, as ONE commit.
   *
   * A kick is a single act, but it used to be two independent durable writes.
   * When the block landed and the revoke then failed, nothing could roll the
   * block back: the admin was told the kick failed while the member kept working
   * until their next reconnect, which was refused with `member_kicked` (#237
   * review). Durable-first only protects each write's own local mirror; it
   * cannot undo a write that already succeeded.
   */
  evictMemberToken: (
    code: string,
    memberId: string,
    memberToken: string,
    blockedUntil: number,
  ) => void | Promise<void>;
  isMemberTokenBlocked: (
    code: string,
    memberToken: string,
    currentTime?: number,
  ) => boolean;
  /**
   * Drop a member's presence. Their `memberToken` survives so a reconnect can
   * reclaim the same `memberId`; use {@link RuntimeStore.revokeMemberToken} to
   * end that. See `removeMemberFromRoom` for why the two are separate.
   */
  removeMember: (
    code: string,
    memberId: string,
    session?: Session,
  ) => {
    room: ActiveRoom | null;
    roomEmpty: boolean;
    removed: boolean;
    /**
     * Resolves once the removal is durable and REJECTS when it is not.
     *
     * The three fields above describe this node's own map, which is updated
     * synchronously; the shared write is queued behind them. A caller that
     * reads the shared member view afterwards and decides something from it —
     * `leaveCurrentRoom` elects the next share owner — has to know the view it
     * read reflects this removal, because a failed write leaves the leaver in
     * the member hash while the session index cleanup goes on to succeed, and
     * the two disagree exactly where it matters (#235 review).
     *
     * Absent on stores with no separate durable step.
     */
    durable?: Promise<void>;
  };
  /**
   * Revoke a member's identity so their `memberToken` can no longer reclaim
   * their `memberId`. Only for deliberate departures: an explicit `room:leave`
   * or an admin kick.
   *
   * Pass `session` to make it conditional on that session still owning the
   * memberId (see `revokeMemberTokenInRoom`); omit it only where the caller
   * means "this identity is over regardless of who holds it now" — the kick.
   *
   * The returned promise settles once the revocation is durable and REJECTS if
   * the write failed. A caller that acts on the revocation (the kick disconnects
   * the socket right after) must await it: resolving early would report success
   * while the old token still resolved (#237 review).
   */
  revokeMemberToken: (
    code: string,
    memberId: string,
    session?: Session,
  ) => void | Promise<void>;
  /**
   * Tear down every runtime key for a room. Returns a promise that settles once
   * the teardown is durable and rejects if it failed — the caller is usually
   * deleting the persisted room in the same breath, after which nothing will
   * ever name this room code again, so a silent failure strands the keys.
   *
   * `expectedGeneration` makes the teardown target ONE room instance. Room codes
   * are recycled, and a teardown is decided (the room is gone) and performed
   * (delete its keys) at two different moments; between them the code can come
   * back into use, and an unconditional delete would then wipe the new room's
   * members and tokens. Two check-then-act guards cannot compose their way out
   * of that — only the delete itself can be conditional (#237 review).
   *
   * Read the generation with {@link RuntimeStore.getRoomGeneration} when the
   * teardown is decided and pass it here; a mismatch means the code changed
   * hands and the teardown is skipped. `null` matches only `null`, so a room
   * that predates generations is still collected, and one that has since been
   * stamped is left alone.
   */
  deleteRoom: (
    code: string,
    expectedGeneration?: string | null,
  ) => boolean | Promise<boolean>;
  /**
   * Whether ANY runtime state remains under this code.
   *
   * Not `getRoom() !== null`: that answers "are there members or member tokens",
   * which is a strict subset. A code carrying only leftover session index
   * entries, blocked tokens, dedup slots or a generation would read as free, be
   * handed to a new room, and take the old room's ghosts with it (#237 review).
   */
  hasRoomResidue: (code: string) => boolean | Promise<boolean>;
  /** The generation stamped on this code's runtime state, or null. */
  getRoomGeneration: (code: string) => string | null | Promise<string | null>;
  /**
   * Stamp a fresh generation on a code, marking the start of a new room
   * instance. Called once when a room is created.
   */
  markRoomGeneration: (
    code: string,
    generation: string,
  ) => void | Promise<void>;
  heartbeatNode: (status: ClusterNodeStatus) => Promise<void>;
  listNodeStatuses: (
    caller: RuntimeReadCaller,
    currentTime?: number,
  ) => Promise<ClusterNodeStatus[]>;
  purgeNodeStatus: (instanceId: string) => Promise<void>;
  countClusterActiveRooms: () => Promise<number>;
  listClusterActiveRoomCodes: () => Promise<string[]>;
  listClusterSessionsByRoom: (roomCode: string) => Promise<Session[]>;
  listClusterSessions: (caller: RuntimeReadCaller) => Promise<Session[]>;
  tryClaimMessageSlot: (
    roomCode: string,
    key: string,
    token: string,
    expiresAt: number,
  ) => Promise<boolean>;
  releaseMessageSlot: (
    roomCode: string,
    key: string,
    token: string,
  ) => Promise<boolean>;
  acquireRoomLock: (
    roomCode: string,
    key: string,
    token: string,
    expiresAt: number,
  ) => Promise<boolean>;
  releaseRoomLock: (
    roomCode: string,
    key: string,
    token: string,
  ) => Promise<boolean>;
};

/**
 * How long a member's identity survives their disconnect.
 *
 * Retention is per IDENTITY, not per room. Hanging it off "the room emptied"
 * never released anything while the room stayed busy — a public room with a
 * steady trickle of visitors kept every departed visitor's token forever — and
 * in a cluster only the one node that observed the emptying ever acted on it
 * (#237 review).
 */
export const DEFAULT_MEMBER_TOKEN_RETENTION_MS = 30 * 60_000;

export function createInMemoryRuntimeStore(
  now: () => number = Date.now,
  memberTokenRetentionMs: number = DEFAULT_MEMBER_TOKEN_RETENTION_MS,
): RuntimeStore {
  const startedAt = now();
  const sessionsById = new Map<string, Session>();
  const sessionIdsByRemoteAddress = new Map<string, Set<string>>();
  const roomSessionIds = new Map<string, Set<string>>();
  const timedEvents: TimedEvent[] = [];
  const lifetimeEventCounts: Record<string, number> = {};
  const rooms = new Map<string, ActiveRoom>();
  const blockedMemberTokensByRoom = new Map<string, KickedMemberBlock[]>();
  const claimedSlotsByRoom = new Map<
    string,
    Map<string, { token: string; expiresAt: number }>
  >();
  const ownedRoomLocks = new Map<
    string,
    Map<string, { token: string; expiresAt: number }>
  >();
  const nodeStatuses = new Map<string, ClusterNodeStatus>();
  // memberId → when its token stops reclaiming the identity. Only disconnected
  // members appear here; `addMember` removes the entry again.
  const memberTokenExpiryByRoom = new Map<string, Map<string, number>>();
  // code → the generation of the room instance currently using it.
  const roomGenerations = new Map<string, string>();

  /** Drop identities whose retention has run out. Lazy: no timers. */
  function pruneExpiredMemberTokens(code: string, currentTime = now()): void {
    const expiryByMember = memberTokenExpiryByRoom.get(code);
    if (!expiryByMember) {
      return;
    }
    for (const [memberId, expiresAt] of Array.from(expiryByMember.entries())) {
      if (expiresAt <= currentTime) {
        expiryByMember.delete(memberId);
        revokeMemberTokenInRoom(rooms, code, memberId);
      }
    }
    if (expiryByMember.size === 0) {
      memberTokenExpiryByRoom.delete(code);
    }
  }

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

  function revokeMemberIdentity(
    code: string,
    memberId: string,
    session?: Session,
  ): void {
    if (revokeMemberTokenInRoom(rooms, code, memberId, session)) {
      const expiryByMember = memberTokenExpiryByRoom.get(code);
      expiryByMember?.delete(memberId);
      if (expiryByMember?.size === 0) {
        memberTokenExpiryByRoom.delete(code);
      }
    }
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
    async markSessionJoinedRoom(sessionId, roomCode) {
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
    async markSessionLeftRoom(sessionId, roomCode) {
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
      pruneExpiredMemberTokens(code);
      return rooms.get(code) ?? null;
    },
    getOrCreateRoom,
    addMember(code, memberId, session, memberToken) {
      pruneExpiredMemberTokens(code);
      // Back in use: the identity is no longer on the clock.
      memberTokenExpiryByRoom.get(code)?.delete(memberId);
      return addMemberToRoom(rooms, code, memberId, session, memberToken);
    },
    findMemberIdByToken(code, memberToken) {
      pruneExpiredMemberTokens(code);
      const room = rooms.get(code) ?? null;
      if (!room) {
        return null;
      }
      return findMemberIdByTokenEntries(
        room.memberTokens.entries(),
        memberToken,
      );
    },
    isMemberTokenBlocked(code, memberToken, currentTime = now()) {
      const activeEntries = pruneBlockedMemberTokens(code, currentTime);
      return activeEntries.some((entry) => entry.memberToken === memberToken);
    },
    tryClaimMessageSlot(roomCode, key, token, expiresAt) {
      const currentTime = now();
      const roomSlots =
        claimedSlotsByRoom.get(roomCode) ??
        new Map<string, { token: string; expiresAt: number }>();
      for (const [k, slot] of roomSlots) {
        if (slot.expiresAt <= currentTime) roomSlots.delete(k);
      }
      if (roomSlots.has(key)) {
        return Promise.resolve(false);
      }
      roomSlots.set(key, { token, expiresAt });
      claimedSlotsByRoom.set(roomCode, roomSlots);
      return Promise.resolve(true);
    },
    releaseMessageSlot(roomCode, key, token) {
      const roomSlots = claimedSlotsByRoom.get(roomCode);
      if (roomSlots?.get(key)?.token !== token) {
        return Promise.resolve(false);
      }
      roomSlots.delete(key);
      return Promise.resolve(true);
    },
    acquireRoomLock(roomCode, key, token, expiresAt) {
      const currentTime = now();
      const roomLocks =
        ownedRoomLocks.get(roomCode) ??
        new Map<string, { token: string; expiresAt: number }>();
      for (const [k, lock] of roomLocks) {
        if (lock.expiresAt <= currentTime) roomLocks.delete(k);
      }
      if (roomLocks.has(key)) {
        return Promise.resolve(false);
      }
      roomLocks.set(key, { token, expiresAt });
      ownedRoomLocks.set(roomCode, roomLocks);
      return Promise.resolve(true);
    },
    releaseRoomLock(roomCode, key, token) {
      const roomLocks = ownedRoomLocks.get(roomCode);
      if (!roomLocks) {
        return Promise.resolve(false);
      }
      const lock = roomLocks.get(key);
      if (!lock || lock.token !== token) {
        return Promise.resolve(false);
      }
      roomLocks.delete(key);
      if (roomLocks.size === 0) {
        ownedRoomLocks.delete(roomCode);
      }
      return Promise.resolve(true);
    },
    removeMember(code, memberId, session) {
      pruneExpiredMemberTokens(code);
      const removal = removeMemberFromRoom(rooms, code, memberId, session);
      // Presence is gone but the identity survives (#234) — start its clock, so
      // a room that never empties still releases the people who left it.
      if (removal.removed && rooms.get(code)?.memberTokens.has(memberId)) {
        const expiryByMember =
          memberTokenExpiryByRoom.get(code) ?? new Map<string, number>();
        expiryByMember.set(memberId, now() + memberTokenRetentionMs);
        memberTokenExpiryByRoom.set(code, expiryByMember);
      }
      return removal;
    },
    evictMemberToken(code, memberId, memberToken, blockedUntil) {
      const activeEntries = pruneBlockedMemberTokens(code, now());
      const existingBlock = activeEntries.find(
        (entry) => entry.memberToken === memberToken,
      );
      if (existingBlock) {
        existingBlock.expiresAt = Math.max(
          existingBlock.expiresAt,
          blockedUntil,
        );
      } else {
        activeEntries.push({ memberToken, expiresAt: blockedUntil });
      }
      blockedMemberTokensByRoom.set(code, activeEntries);
      // Not `this.revokeMemberToken`: every consumer takes these off the object
      // as bare references (`active-room-registry`, the mirrored store), so
      // `this` is gone by the time they call it.
      revokeMemberIdentity(code, memberId);
    },
    revokeMemberToken: revokeMemberIdentity,
    hasRoomResidue(code) {
      pruneExpiredMemberTokens(code);
      // Deliberately NOT the generation or a held room lock. Neither is state a
      // new room could inherit — the generation is overwritten by the new room's
      // own stamp, and a lock is transient — and counting them would mean a code
      // is freed only by a successful teardown, losing the self-healing path
      // where the residue simply ages out.
      return (
        rooms.has(code) ||
        roomSessionIds.has(code) ||
        blockedMemberTokensByRoom.has(code) ||
        memberTokenExpiryByRoom.has(code) ||
        claimedSlotsByRoom.has(code)
      );
    },
    getRoomGeneration(code) {
      return roomGenerations.get(code) ?? null;
    },
    markRoomGeneration(code, generation) {
      roomGenerations.set(code, generation);
    },
    deleteRoom(code, expectedGeneration) {
      if (
        expectedGeneration !== undefined &&
        (roomGenerations.get(code) ?? null) !== expectedGeneration
      ) {
        return false;
      }
      roomGenerations.delete(code);
      rooms.delete(code);
      memberTokenExpiryByRoom.delete(code);
      roomSessionIds.delete(code);
      blockedMemberTokensByRoom.delete(code);
      claimedSlotsByRoom.delete(code);
      ownedRoomLocks.delete(code);
      return true;
    },
    async heartbeatNode(status) {
      nodeStatuses.set(status.instanceId, { ...status });
    },
    async listNodeStatuses(_caller: RuntimeReadCaller, currentTime = now()) {
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
    async listClusterSessions(_caller: RuntimeReadCaller) {
      return Array.from(sessionsById.values());
    },
  };
}
