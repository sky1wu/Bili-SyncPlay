import { randomUUID } from "node:crypto";
import {
  normalizeBilibiliUrl,
  type ClientMessage,
  type ErrorCode,
  type PlaybackState,
  type SharedVideo,
} from "@bili-syncplay/protocol";
import {
  INTERNAL_SERVER_ERROR_MESSAGE,
  JOIN_TOKEN_INVALID_MESSAGE,
  MEMBER_KICKED_REJOIN_MESSAGE,
  MEMBER_TOKEN_INVALID_MESSAGE,
  NOT_IN_ROOM_MESSAGE,
  PLAYBACK_URL_MISMATCH_MESSAGE,
  ROOM_FULL_MESSAGE,
  ROOM_HAS_NO_SHARED_VIDEO_MESSAGE,
  ROOM_NOT_FOUND_MESSAGE,
} from "./messages.js";
import { decidePlaybackAcceptance } from "./playback-authority.js";
import {
  createRoomCode,
  roomStateFromSessions,
  roomStateOf,
  type RoomStore,
} from "./room-store.js";
import type { RuntimeStore } from "./runtime-store.js";
import { hasAttachedSocket } from "./types.js";
import type {
  ActiveRoom,
  LogEvent,
  PlaybackAuthority,
  PersistenceConfig,
  PersistedRoom,
  SecurityConfig,
  Session,
} from "./types.js";

const PLAYBACK_AUTHORITY_WINDOW_MS = 1200;
const MAX_VERSION_RETRIES = 3;
const ROOM_LAST_ACTIVE_WRITE_INTERVAL_MS = 30_000;
const JOIN_ADMISSION_LOCK_KEY = "join-admission";
const JOIN_ADMISSION_LOCK_TTL_MS = 30_000;
const JOIN_ADMISSION_LOCK_MAX_WAIT_MS = 5_000;
const JOIN_ADMISSION_LOCK_RETRY_INTERVAL_MS = 25;

type ServiceErrorReason =
  | "room_not_found"
  | "join_token_invalid"
  | "member_token_invalid"
  | "not_in_room"
  | "room_full"
  | "invalid_message"
  | "internal_error";

export class RoomServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly reason: ServiceErrorReason,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type JoinedRoomAccess = {
  session: Session;
  persistedRoom: PersistedRoom;
  activeRoom: ReturnType<RuntimeStore["getOrCreateRoom"]>;
};

type JoinTargetState = {
  activeRoom: ActiveRoom | null;
  reconnectMemberId: string | null;
  activeMemberCount: number;
};

type JoinIdentity = {
  memberId: string;
  memberToken: string;
};

type PersistJoinedRoomResult = {
  room: PersistedRoom;
  joinTargetState: JoinTargetState;
};

type JoinAdmissionLock = {
  token: string;
  expiresAt: number;
};

type JoinAdmissionLockGuard = {
  assertActive: () => void;
};

type JoinedSessionSnapshot = {
  roomCode: string;
  memberId: string;
  memberToken: string;
  joinedAt: number | null;
};

export function createRoomService(options: {
  config: SecurityConfig;
  persistence: PersistenceConfig;
  roomStore: RoomStore;
  runtimeStore?: RuntimeStore;
  activeRooms?: RuntimeStore;
  createRoomCode?: () => string;
  generateToken: () => string;
  logEvent: LogEvent;
  now?: () => number;
  resolveActiveRoom?: (roomCode: string) => Promise<ActiveRoom | null>;
  resolveMemberIdByToken?: (
    roomCode: string,
    memberToken: string,
  ) => Promise<string | null>;
  resolveBlockedMemberToken?: (
    roomCode: string,
    memberToken: string,
    currentTime: number,
  ) => Promise<boolean>;
}): {
  createRoomForSession: (
    session: Session,
    displayName?: string,
  ) => Promise<{ room: PersistedRoom; memberToken: string }>;
  joinRoomForSession: (
    session: Session,
    roomCode: string,
    joinToken: string,
    displayName?: string,
    previousMemberToken?: string,
  ) => Promise<{ room: PersistedRoom; memberToken: string }>;
  leaveRoomForSession: (session: Session) => Promise<{
    room: PersistedRoom | null;
    notifyRoom?: boolean;
    memberRemoved?: boolean;
  }>;
  shareVideoForSession: (
    session: Session,
    memberToken: string,
    video: SharedVideo,
    playback?: PlaybackState,
  ) => Promise<{ room: PersistedRoom }>;
  updatePlaybackForSession: (
    session: Session,
    memberToken: string,
    playback: PlaybackState,
  ) => Promise<{ room: PersistedRoom | null; ignored: boolean }>;
  updateProfileForSession: (
    session: Session,
    memberToken: string,
    displayName: string,
  ) => Promise<{ room: PersistedRoom }>;
  getRoomStateForSession: (
    session: Session,
    memberToken: string,
    messageType: ClientMessage["type"],
  ) => Promise<ReturnType<typeof roomStateOf>>;
  getActiveRoom: (roomCode: string) => ReturnType<RuntimeStore["getRoom"]>;
  getPlaybackAuthority: (roomCode: string) => PlaybackAuthority | null;
  getRoomStateByCode: (
    roomCode: string,
  ) => Promise<ReturnType<typeof roomStateOf> | null>;
  deleteExpiredRooms: (currentTime?: number) => Promise<number>;
} {
  const { config, persistence, roomStore, generateToken, logEvent } = options;
  const runtimeStoreOption = options.runtimeStore ?? options.activeRooms;
  const now = options.now ?? Date.now;
  const nextRoomCode = options.createRoomCode ?? createRoomCode;
  const playbackAuthorityByRoom = new Map<string, PlaybackAuthority>();

  if (!runtimeStoreOption) {
    throw new Error("RuntimeStore is required");
  }
  const runtimeStore: RuntimeStore = runtimeStoreOption;
  const resolveActiveRoom =
    options.resolveActiveRoom ??
    ((roomCode: string) => Promise.resolve(runtimeStore.getRoom(roomCode)));
  const resolveMemberIdByToken =
    options.resolveMemberIdByToken ??
    ((roomCode: string, memberToken: string) =>
      Promise.resolve(runtimeStore.findMemberIdByToken(roomCode, memberToken)));
  const resolveBlockedMemberToken =
    options.resolveBlockedMemberToken ??
    ((roomCode: string, memberToken: string, currentTime: number) =>
      Promise.resolve(
        runtimeStore.isMemberTokenBlocked(roomCode, memberToken, currentTime),
      ));
  const roomJoinLocks = new Map<string, Promise<void>>();

  async function acquireDistributedJoinLock(
    roomCode: string,
  ): Promise<JoinAdmissionLock | null> {
    const deadline = now() + JOIN_ADMISSION_LOCK_MAX_WAIT_MS;
    while (true) {
      const expiresAt = now() + JOIN_ADMISSION_LOCK_TTL_MS;
      const token = randomUUID();
      if (
        await runtimeStore.acquireRoomLock(
          roomCode,
          JOIN_ADMISSION_LOCK_KEY,
          token,
          expiresAt,
        )
      ) {
        return { token, expiresAt };
      }
      if (now() >= deadline) {
        return null;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, JOIN_ADMISSION_LOCK_RETRY_INTERVAL_MS),
      );
    }
  }

  function createJoinAdmissionLockExpiredError(
    roomCode: string,
  ): RoomServiceError {
    return new RoomServiceError(
      "internal_error",
      INTERNAL_SERVER_ERROR_MESSAGE,
      "internal_error",
      { roomCode, reason: "join_admission_lock_expired" },
    );
  }

  async function withRoomJoinLock<T>(
    roomCode: string,
    action: (lock: JoinAdmissionLockGuard) => Promise<T>,
  ): Promise<T> {
    const previous = roomJoinLocks.get(roomCode) ?? Promise.resolve();
    let releaseNext: () => void = () => undefined;
    const next = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => next);
    roomJoinLocks.set(roomCode, tail);

    function releaseInProcessLock(): void {
      releaseNext();
      if (roomJoinLocks.get(roomCode) === tail) {
        roomJoinLocks.delete(roomCode);
      }
    }

    let distributedLock: JoinAdmissionLock | null = null;
    try {
      await previous.catch(() => undefined);
      distributedLock = await acquireDistributedJoinLock(roomCode);
      if (!distributedLock) {
        logEvent("room_join_admission_lock_unavailable", {
          roomCode,
          result: "rejected",
          reason: "join_admission_lock_timeout",
        });
        throw new RoomServiceError(
          "internal_error",
          INTERNAL_SERVER_ERROR_MESSAGE,
          "internal_error",
          { roomCode, reason: "join_admission_lock_timeout" },
        );
      }

      const lockGuard: JoinAdmissionLockGuard = {
        assertActive: () => {
          if (!distributedLock || now() >= distributedLock.expiresAt) {
            throw createJoinAdmissionLockExpiredError(roomCode);
          }
        },
      };

      return await action(lockGuard);
    } finally {
      if (distributedLock) {
        if (now() < distributedLock.expiresAt) {
          try {
            await runtimeStore.releaseRoomLock(
              roomCode,
              JOIN_ADMISSION_LOCK_KEY,
              distributedLock.token,
            );
          } catch {
            // Lock will expire via TTL.
          }
        } else {
          logEvent("room_join_admission_lock_ttl_exceeded", {
            roomCode,
            result: "rejected",
            reason: "join_admission_lock_ttl_exceeded",
            ttlMs: JOIN_ADMISSION_LOCK_TTL_MS,
          });
        }
      }
      releaseInProcessLock();
    }
  }

  function setSessionDisplayName(
    session: Session,
    displayName?: string,
  ): boolean {
    const nextDisplayName = displayName?.trim();
    if (!nextDisplayName || nextDisplayName === session.displayName) {
      return false;
    }

    session.displayName = nextDisplayName;
    runtimeStore.registerSession?.(session);
    return true;
  }

  function actorDetails(session: Session): Record<string, unknown> {
    return {
      actorId: session.memberId ?? session.id,
      displayName: session.displayName,
    };
  }

  function clearSessionRoom(session: Session): void {
    session.roomCode = null;
    session.memberId = null;
    session.memberToken = null;
    session.joinedAt = null;
  }

  function snapshotJoinedSession(
    session: Session,
  ): JoinedSessionSnapshot | null {
    if (!session.roomCode || !session.memberId || !session.memberToken) {
      return null;
    }

    return {
      roomCode: session.roomCode,
      memberId: session.memberId,
      memberToken: session.memberToken,
      joinedAt: session.joinedAt,
    };
  }

  function restoreJoinedSession(
    session: Session,
    snapshot: JoinedSessionSnapshot,
  ): void {
    session.roomCode = snapshot.roomCode;
    session.memberId = snapshot.memberId;
    session.memberToken = snapshot.memberToken;
    session.joinedAt = snapshot.joinedAt;
  }

  async function restoreLeaveState(args: {
    session: Session;
    snapshot: JoinedSessionSnapshot | null;
    roomCode: string;
    reason: string;
    error?: unknown;
  }): Promise<void> {
    if (!args.snapshot) {
      return;
    }

    runtimeStore.addMember(
      args.snapshot.roomCode,
      args.snapshot.memberId,
      args.session,
      args.snapshot.memberToken,
    );
    restoreJoinedSession(args.session, args.snapshot);
    await runtimeStore.flush?.();

    logEvent("room_leave_recovered", {
      sessionId: args.session.id,
      roomCode: args.roomCode,
      remoteAddress: args.session.remoteAddress,
      origin: args.session.origin,
      result: "ok",
      reason: args.reason,
      error:
        args.error instanceof Error ? args.error.message : String(args.error),
    });
  }

  async function resolveRoom(code: string): Promise<PersistedRoom | null> {
    const room = await roomStore.getRoom(code);
    if (!room) {
      return null;
    }
    if (room.expiresAt !== null && room.expiresAt <= now()) {
      await roomStore.deleteRoom(code);
      runtimeStore.deleteRoom(code);
      return null;
    }
    return room;
  }

  function getPlaybackAuthority(roomCode: string): PlaybackAuthority | null {
    const authority = playbackAuthorityByRoom.get(roomCode) ?? null;
    if (!authority) {
      return null;
    }
    if (authority.until <= now()) {
      playbackAuthorityByRoom.delete(roomCode);
      return null;
    }
    return authority;
  }

  function derivePlaybackAuthorityKind(args: {
    currentPlayback: PlaybackState | null;
    nextPlayback: PlaybackState;
  }): PlaybackAuthority["kind"] | null {
    if (!args.currentPlayback) {
      return "play";
    }
    if (
      args.nextPlayback.playState === "paused" ||
      args.nextPlayback.playState === "buffering"
    ) {
      return "pause";
    }
    if (
      Math.abs(
        args.nextPlayback.playbackRate - args.currentPlayback.playbackRate,
      ) > 0.01
    ) {
      return "ratechange";
    }
    if (
      args.nextPlayback.syncIntent === "explicit-seek" &&
      args.nextPlayback.playState === "playing"
    ) {
      return "seek";
    }
    if (
      Math.abs(
        args.nextPlayback.currentTime - args.currentPlayback.currentTime,
      ) >= 2.5
    ) {
      return "seek";
    }
    if (
      args.currentPlayback.playState !== "playing" &&
      args.nextPlayback.playState === "playing"
    ) {
      return "play";
    }
    return null;
  }

  function recordPlaybackAuthority(args: {
    roomCode: string;
    actorId: string;
    kind: PlaybackAuthority["kind"];
    source: PlaybackAuthority["source"];
  }): void {
    playbackAuthorityByRoom.set(args.roomCode, {
      actorId: args.actorId,
      until: now() + PLAYBACK_AUTHORITY_WINDOW_MS,
      kind: args.kind,
      source: args.source,
    });
  }

  function requireMemberToken(
    activeRoom: ReturnType<RuntimeStore["getOrCreateRoom"]>,
    session: Session,
    memberToken: string,
    messageType: ClientMessage["type"],
  ): void {
    const memberId = session.memberId;
    if (
      !memberId ||
      !session.memberToken ||
      memberToken !== session.memberToken ||
      activeRoom.memberTokens.get(memberId) !== session.memberToken
    ) {
      logEvent("auth_failed", {
        sessionId: session.id,
        roomCode: session.roomCode,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        messageType,
        result: "rejected",
        reason: "member_token_invalid",
      });
      throw new RoomServiceError(
        "member_token_invalid",
        MEMBER_TOKEN_INVALID_MESSAGE,
        "member_token_invalid",
      );
    }
  }

  async function requireJoinedRoomSession(
    session: Session,
    memberToken: string,
    messageType: ClientMessage["type"],
  ): Promise<JoinedRoomAccess> {
    if (!session.roomCode) {
      logEvent("auth_failed", {
        sessionId: session.id,
        roomCode: null,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        messageType,
        result: "rejected",
        reason: "not_in_room",
      });
      throw new RoomServiceError(
        "not_in_room",
        NOT_IN_ROOM_MESSAGE,
        "not_in_room",
      );
    }

    const persistedRoom = await resolveRoom(session.roomCode);
    if (!persistedRoom) {
      clearSessionRoom(session);
      logEvent("auth_failed", {
        sessionId: session.id,
        roomCode: session.roomCode,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        messageType,
        result: "rejected",
        reason: "room_not_found",
      });
      throw new RoomServiceError(
        "room_not_found",
        ROOM_NOT_FOUND_MESSAGE,
        "room_not_found",
      );
    }

    const activeRoom = runtimeStore.getRoom(persistedRoom.code);
    if (
      !activeRoom ||
      !session.memberId ||
      activeRoom.members.get(session.memberId) !== session
    ) {
      clearSessionRoom(session);
      logEvent("auth_failed", {
        sessionId: session.id,
        roomCode: persistedRoom.code,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        messageType,
        result: "rejected",
        reason: "member_token_invalid",
      });
      throw new RoomServiceError(
        "member_token_invalid",
        MEMBER_TOKEN_INVALID_MESSAGE,
        "member_token_invalid",
      );
    }

    requireMemberToken(activeRoom, session, memberToken, messageType);
    return { session, persistedRoom, activeRoom };
  }

  async function withVersionRetry<T = PersistedRoom>(
    roomCode: string,
    action: (room: PersistedRoom) => Promise<T | null>,
  ): Promise<T | null> {
    for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt += 1) {
      const room = await resolveRoom(roomCode);
      if (!room) {
        return null;
      }

      const updatedRoom = await action(room);
      if (updatedRoom) {
        return updatedRoom;
      }
    }

    logEvent("room_version_conflict", {
      roomCode,
      result: "conflict",
    });
    return null;
  }

  async function resolveJoinTargetState(
    roomCode: string,
    previousMemberToken?: string,
  ): Promise<JoinTargetState> {
    const activeRoom = await resolveActiveRoom(roomCode);
    const reconnectMemberId =
      previousMemberToken && activeRoom
        ? await resolveMemberIdByToken(roomCode, previousMemberToken)
        : null;

    return {
      activeRoom,
      reconnectMemberId,
      activeMemberCount: activeRoom?.members.size ?? 0,
    };
  }

  function rejectJoinToken(
    session: Session,
    roomCode: string,
    reason: "join_token_invalid" | "member_kicked",
    message: string,
  ): never {
    logEvent("auth_failed", {
      sessionId: session.id,
      roomCode,
      remoteAddress: session.remoteAddress,
      origin: session.origin,
      messageType: "room:join",
      result: "rejected",
      reason,
    });
    throw new RoomServiceError(
      "join_token_invalid",
      message,
      "join_token_invalid",
    );
  }

  async function ensureJoinRequestAllowed(args: {
    session: Session;
    room: PersistedRoom;
    roomCode: string;
    joinToken: string;
    previousMemberToken?: string;
  }): Promise<JoinTargetState> {
    if (args.room.joinToken !== args.joinToken) {
      rejectJoinToken(
        args.session,
        args.roomCode,
        "join_token_invalid",
        JOIN_TOKEN_INVALID_MESSAGE,
      );
    }

    if (
      args.previousMemberToken &&
      (await resolveBlockedMemberToken(
        args.roomCode,
        args.previousMemberToken,
        now(),
      ))
    ) {
      rejectJoinToken(
        args.session,
        args.roomCode,
        "member_kicked",
        MEMBER_KICKED_REJOIN_MESSAGE,
      );
    }

    const joinTargetState = await resolveJoinTargetState(
      args.roomCode,
      args.previousMemberToken,
    );
    if (
      joinTargetState.activeMemberCount >= config.maxMembersPerRoom &&
      joinTargetState.reconnectMemberId === null
    ) {
      throw new RoomServiceError("room_full", ROOM_FULL_MESSAGE, "room_full");
    }

    return joinTargetState;
  }

  async function persistJoinedRoom(args: {
    session: Session;
    roomCode: string;
    joinToken: string;
    previousMemberToken?: string;
  }): Promise<PersistJoinedRoomResult | null> {
    return withVersionRetry(args.roomCode, async (room) => {
      const currentTime = now();
      const joinTargetState = await ensureJoinRequestAllowed({
        session: args.session,
        room,
        roomCode: args.roomCode,
        joinToken: args.joinToken,
        previousMemberToken: args.previousMemberToken,
      });
      const needsCapacitySerialization =
        joinTargetState.reconnectMemberId === null;

      if (
        room.expiresAt === null &&
        currentTime - room.lastActiveAt < ROOM_LAST_ACTIVE_WRITE_INTERVAL_MS &&
        !needsCapacitySerialization
      ) {
        const latestRoom = await roomStore.getRoom(args.roomCode);
        if (!latestRoom) {
          return null;
        }
        if (latestRoom.version !== room.version) {
          return null;
        }
        return { room: latestRoom, joinTargetState };
      }

      const result = await roomStore.updateRoom(args.roomCode, room.version, {
        ...(room.expiresAt === null ? {} : { expiresAt: null }),
        lastActiveAt: currentTime,
      });
      if (!result.ok) {
        return null;
      }
      return { room: result.room, joinTargetState };
    });
  }

  function buildJoinIdentity(
    session: Session,
    reconnectMemberId: string | null,
    previousMemberToken?: string,
  ): JoinIdentity {
    return {
      memberId: reconnectMemberId ?? session.id,
      memberToken:
        reconnectMemberId && previousMemberToken
          ? previousMemberToken
          : generateToken(),
    };
  }

  function applyJoinedSessionState(args: {
    session: Session;
    roomCode: string;
    joinedAt: number;
    joinIdentity: JoinIdentity;
  }): void {
    args.session.memberId = args.joinIdentity.memberId;
    args.session.roomCode = args.roomCode;
    args.session.memberToken = args.joinIdentity.memberToken;
    args.session.joinedAt = args.joinedAt;
  }

  function disconnectReplacedSession(
    currentSession: Session,
    previousSession: Session | null,
  ): void {
    if (
      !previousSession ||
      previousSession === currentSession ||
      !hasAttachedSocket(previousSession) ||
      typeof previousSession.socket.close !== "function" ||
      previousSession.socket.readyState !== previousSession.socket.OPEN
    ) {
      return;
    }
    previousSession.socket.close(1000, "Session replaced");
  }

  function isSessionSocketOpen(session: Session): boolean {
    if (!hasAttachedSocket(session)) {
      return false;
    }
    const { readyState, OPEN } = session.socket;
    if (readyState === undefined || OPEN === undefined) {
      return true;
    }
    return readyState === OPEN;
  }

  async function leaveCurrentRoom(session: Session): Promise<{
    room: PersistedRoom | null;
    notifyRoom?: boolean;
    memberRemoved?: boolean;
  }> {
    if (!session.roomCode) {
      return { room: null };
    }

    const roomCode = session.roomCode;
    const leavingMemberId = session.memberId ?? session.id;
    const leavingDisplayName = session.displayName;
    const sessionSnapshot = snapshotJoinedSession(session);
    const removal = session.memberId
      ? runtimeStore.removeMember(roomCode, session.memberId, session)
      : {
          room: runtimeStore.getRoom(roomCode),
          roomEmpty: false,
          removed: false,
        };
    await runtimeStore.flush?.();
    clearSessionRoom(session);

    try {
      const persistedRoom = await resolveRoom(roomCode);
      if (!persistedRoom) {
        return { room: null };
      }

      if (!removal.roomEmpty) {
        logEvent("room_left", {
          sessionId: session.id,
          roomCode,
          memberId: leavingMemberId,
          displayName: leavingDisplayName,
          remoteAddress: session.remoteAddress,
          origin: session.origin,
          result: "ok",
        });
        return { room: persistedRoom, memberRemoved: removal.removed };
      }

      const expiresAt = now() + persistence.emptyRoomTtlMs;
      const updatedRoom = await withVersionRetry(roomCode, async (room) => {
        const result = await roomStore.updateRoom(roomCode, room.version, {
          expiresAt,
          lastActiveAt: now(),
        });
        if (!result.ok) {
          return null;
        }
        return result.room;
      });

      if (!updatedRoom) {
        throw new RoomServiceError(
          "internal_error",
          INTERNAL_SERVER_ERROR_MESSAGE,
          "internal_error",
          { roomCode, reason: "leave_room_expiry_schedule_failed" },
        );
      }

      logEvent("room_expiry_scheduled", {
        roomCode,
        version: updatedRoom.version,
        expiresAt,
        result: "ok",
      });

      logEvent("room_left", {
        sessionId: session.id,
        roomCode,
        memberId: leavingMemberId,
        displayName: leavingDisplayName,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        result: "ok",
      });

      return { room: updatedRoom, memberRemoved: removal.removed };
    } catch (error) {
      const reason =
        error instanceof RoomServiceError &&
        typeof error.details.reason === "string"
          ? error.details.reason
          : "leave_room_persist_failed";

      let swallowWithNotifyRoom = false;

      if (removal.removed) {
        if (!isSessionSocketOpen(session)) {
          // Socket already closed — re-adding would leave zombie entries in
          // `rooms[code].members` because `unregisterSession` does not clean
          // that map. Skip restore and let cleanup finish.
          logEvent("room_leave_recovery_skipped", {
            sessionId: session.id,
            roomCode,
            remoteAddress: session.remoteAddress,
            origin: session.origin,
            reason: "socket_detached",
          });
          if (removal.roomEmpty) {
            // Emptying-leave plus failed expiry write may leave the persisted
            // room without `expiresAt`, so the reaper won't collect it. We
            // can NOT force-delete here: the expiry write could have failed
            // due to a version conflict caused by a concurrent join, in
            // which case the room is no longer empty and deletion would
            // erase an active room. Surface the condition so operators /
            // reaper can reconcile.
            logEvent("room_leave_orphan_possible", {
              sessionId: session.id,
              roomCode,
              remoteAddress: session.remoteAddress,
              origin: session.origin,
              provider: persistence.provider,
              reason,
            });
          } else {
            // Other members are still in the room and the runtime reflects
            // the leave. Swallow the persistence error and have the caller
            // broadcast `room_member_changed` so clients don't see a stale
            // roster until the next unrelated room event.
            swallowWithNotifyRoom = true;
          }
        } else {
          let roomStillExists: boolean;
          try {
            roomStillExists = (await roomStore.getRoom(roomCode)) !== null;
          } catch {
            // Cannot determine room status — err on the side of restoring to
            // avoid leaving runtime and persistence out of sync.
            roomStillExists = true;
          }

          if (roomStillExists) {
            await restoreLeaveState({
              session,
              snapshot: sessionSnapshot,
              roomCode,
              reason,
              error,
            });
          } else {
            logEvent("room_leave_recovery_skipped", {
              sessionId: session.id,
              roomCode,
              remoteAddress: session.remoteAddress,
              origin: session.origin,
              reason: "room_deleted",
            });
          }
        }
      }

      logEvent("room_persist_failed", {
        sessionId: session.id,
        roomCode,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        provider: persistence.provider,
        result: "error",
        reason,
        error: error instanceof Error ? error.message : String(error),
      });

      if (swallowWithNotifyRoom) {
        return { room: null, notifyRoom: true, memberRemoved: removal.removed };
      }

      if (error instanceof RoomServiceError) {
        throw error;
      }

      throw new RoomServiceError(
        "internal_error",
        INTERNAL_SERVER_ERROR_MESSAGE,
        "internal_error",
        { roomCode, reason },
      );
    }
  }

  return {
    async createRoomForSession(session, displayName) {
      setSessionDisplayName(session, displayName);
      await leaveCurrentRoom(session);

      const createdAt = now();
      let room: PersistedRoom | null = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const roomCode = nextRoomCode();
        try {
          room = await roomStore.createRoom({
            code: roomCode,
            joinToken: generateToken(),
            createdAt,
            ownerMemberId: session.id,
            ownerDisplayName: session.displayName,
          });
          break;
        } catch {
          room = null;
        }
      }
      if (!room) {
        logEvent("room_persist_failed", {
          sessionId: session.id,
          result: "error",
          reason: "room_create_conflict",
        });
        throw new RoomServiceError(
          "internal_error",
          INTERNAL_SERVER_ERROR_MESSAGE,
          "internal_error",
        );
      }

      const memberToken = generateToken();
      session.memberId = session.id;
      runtimeStore.addMember(room.code, session.memberId, session, memberToken);
      session.roomCode = room.code;
      session.memberToken = memberToken;
      session.joinedAt = createdAt;

      logEvent("room_persisted", {
        roomCode: room.code,
        version: room.version,
        sessionId: session.id,
        provider: persistence.provider,
        result: "ok",
      });

      return { room, memberToken };
    },

    async joinRoomForSession(
      session,
      roomCode,
      joinToken,
      displayName,
      previousMemberToken,
    ) {
      setSessionDisplayName(session, displayName);
      await leaveCurrentRoom(session);

      return withRoomJoinLock(roomCode, async (lock) => {
        const joined = await persistJoinedRoom({
          session,
          roomCode,
          joinToken,
          previousMemberToken,
        });

        if (!joined) {
          throw new RoomServiceError(
            "room_not_found",
            ROOM_NOT_FOUND_MESSAGE,
            "room_not_found",
          );
        }

        const joinedRoom = joined.room;
        const reconnectMemberId = joined.joinTargetState.reconnectMemberId;
        const joinIdentity = buildJoinIdentity(
          session,
          reconnectMemberId,
          previousMemberToken,
        );
        const previousLocalSession =
          reconnectMemberId !== null
            ? (runtimeStore
                .getRoom(joinedRoom.code)
                ?.members.get(reconnectMemberId) ?? null)
            : null;
        const previousRuntimeSession =
          reconnectMemberId !== null
            ? (joined.joinTargetState.activeRoom?.members.get(
                reconnectMemberId,
              ) ?? previousLocalSession)
            : null;
        lock.assertActive();
        runtimeStore.addMember(
          joinedRoom.code,
          joinIdentity.memberId,
          session,
          joinIdentity.memberToken,
        );
        try {
          await runtimeStore.flush?.();
          lock.assertActive();
          applyJoinedSessionState({
            session,
            roomCode: joinedRoom.code,
            joinedAt: now(),
            joinIdentity,
          });
        } catch (error) {
          runtimeStore.removeMember(
            joinedRoom.code,
            joinIdentity.memberId,
            session,
          );
          await runtimeStore.flush?.();

          const currentRuntimeSession =
            (await resolveActiveRoom(joinedRoom.code))?.members.get(
              joinIdentity.memberId,
            ) ?? null;
          if (
            previousRuntimeSession &&
            (currentRuntimeSession === null ||
              currentRuntimeSession === session)
          ) {
            runtimeStore.addMember(
              joinedRoom.code,
              joinIdentity.memberId,
              previousRuntimeSession,
              joinIdentity.memberToken,
            );
            await runtimeStore.flush?.();
          }
          throw error;
        }
        disconnectReplacedSession(session, previousLocalSession);

        logEvent("room_restored", {
          roomCode: joinedRoom.code,
          version: joinedRoom.version,
          sessionId: session.id,
          provider: persistence.provider,
          result: "ok",
        });

        return { room: joinedRoom, memberToken: joinIdentity.memberToken };
      });
    },

    leaveRoomForSession: leaveCurrentRoom,

    async shareVideoForSession(session, memberToken, video, playback) {
      const access = await requireJoinedRoomSession(
        session,
        memberToken,
        "video:share",
      );
      const currentTime = now();
      const actorId = session.memberId ?? session.id;
      const shareDedupKey = `share:${actorId}:${video.url}:${playback?.seq ?? 0}`;
      if (
        !(await runtimeStore.tryClaimMessageSlot(
          access.persistedRoom.code,
          shareDedupKey,
          currentTime + 5_000,
        ))
      ) {
        logEvent("video_share_deduplicated", {
          roomCode: access.persistedRoom.code,
          sessionId: session.id,
          actorId,
        });
        return { room: access.persistedRoom };
      }

      let room: PersistedRoom | null;
      try {
        room = await withVersionRetry(
          access.persistedRoom.code,
          async (currentRoom) => {
            const nextPlayback: PlaybackState = playback
              ? {
                  ...playback,
                  url: video.url,
                  syncIntent: undefined,
                  actorId: session.memberId ?? session.id,
                  serverTime: currentTime,
                }
              : {
                  url: video.url,
                  currentTime: 0,
                  playState: "paused",
                  playbackRate: 1,
                  updatedAt: currentTime,
                  serverTime: currentTime,
                  actorId: session.memberId ?? session.id,
                  seq: 0,
                };
            const result = await roomStore.updateRoom(
              currentRoom.code,
              currentRoom.version,
              {
                sharedVideo: {
                  ...video,
                  sharedByMemberId: session.memberId ?? session.id,
                  sharedByDisplayName: session.displayName,
                },
                playback: nextPlayback,
                expiresAt: null,
                lastActiveAt: currentTime,
              },
            );
            if (!result.ok) {
              return null;
            }
            recordPlaybackAuthority({
              roomCode: currentRoom.code,
              actorId: nextPlayback.actorId,
              kind: "share",
              source: "video:share",
            });
            return result.room;
          },
        );
      } catch (error) {
        await runtimeStore.releaseMessageSlot(
          access.persistedRoom.code,
          shareDedupKey,
        );
        throw error;
      }

      if (!room) {
        await runtimeStore.releaseMessageSlot(
          access.persistedRoom.code,
          shareDedupKey,
        );
        logEvent("room_persist_failed", {
          roomCode: access.persistedRoom.code,
          sessionId: session.id,
          provider: persistence.provider,
          result: "error",
          reason: "video_share_conflict",
        });
        throw new RoomServiceError(
          "internal_error",
          INTERNAL_SERVER_ERROR_MESSAGE,
          "internal_error",
        );
      }

      logEvent("video_shared", {
        roomCode: room.code,
        sessionId: session.id,
        ...actorDetails(session),
        videoTitle: room.sharedVideo?.title ?? video.title,
        videoId: room.sharedVideo?.videoId ?? video.videoId,
        url: room.sharedVideo?.url ?? video.url,
        playState: room.playback?.playState ?? null,
        currentTime: room.playback?.currentTime ?? null,
        playbackRate: room.playback?.playbackRate ?? null,
        result: "ok",
      });

      return { room };
    },

    async updatePlaybackForSession(session, memberToken, playback) {
      const access = await requireJoinedRoomSession(
        session,
        memberToken,
        "playback:update",
      );
      const playbackActorId = session.memberId ?? session.id;
      const playbackDedupKey = `playback:${playbackActorId}:${session.id}:${playback.seq}`;
      const playbackCurrentTime = now();
      if (
        !(await runtimeStore.tryClaimMessageSlot(
          access.persistedRoom.code,
          playbackDedupKey,
          playbackCurrentTime + 10_000,
        ))
      ) {
        logEvent("playback_update_deduplicated", {
          roomCode: access.persistedRoom.code,
          sessionId: session.id,
          actorId: playbackActorId,
          seq: playback.seq,
        });
        return { room: null, ignored: true };
      }
      if (!access.persistedRoom.sharedVideo) {
        await runtimeStore.releaseMessageSlot(
          access.persistedRoom.code,
          playbackDedupKey,
        );
        throw new RoomServiceError(
          "invalid_message",
          ROOM_HAS_NO_SHARED_VIDEO_MESSAGE,
          "invalid_message",
        );
      }

      const sharedUrl = normalizeBilibiliUrl(
        access.persistedRoom.sharedVideo.url,
      );
      const playbackUrl = normalizeBilibiliUrl(playback.url);
      if (!sharedUrl || !playbackUrl || sharedUrl !== playbackUrl) {
        await runtimeStore.releaseMessageSlot(
          access.persistedRoom.code,
          playbackDedupKey,
        );
        throw new RoomServiceError(
          "invalid_message",
          PLAYBACK_URL_MISMATCH_MESSAGE,
          "invalid_message",
        );
      }

      const currentTime = now();
      const nextPlayback: PlaybackState = {
        ...playback,
        actorId: session.memberId ?? session.id,
        serverTime: currentTime,
      };
      const authorityKind = derivePlaybackAuthorityKind({
        currentPlayback: access.persistedRoom.playback,
        nextPlayback,
      });
      const acceptance = decidePlaybackAcceptance({
        currentPlayback: access.persistedRoom.playback,
        authority: getPlaybackAuthority(access.persistedRoom.code),
        incomingPlayback: nextPlayback,
        currentTime,
      });
      if (acceptance.decision !== "accept") {
        const authority = getPlaybackAuthority(access.persistedRoom.code);
        logEvent("playback_update_ignored", {
          roomCode: access.persistedRoom.code,
          sessionId: session.id,
          actorId: nextPlayback.actorId,
          seq: nextPlayback.seq,
          playState: nextPlayback.playState,
          currentTime: nextPlayback.currentTime,
          playbackRate: nextPlayback.playbackRate,
          syncIntent: nextPlayback.syncIntent ?? "none",
          result: "ignored",
          reason: acceptance.reason,
          authorityActorId: authority?.actorId ?? null,
          authorityKind: authority?.kind ?? null,
          authorityUntil: authority?.until ?? null,
          currentActorId: access.persistedRoom.playback?.actorId ?? null,
          currentPlayState: access.persistedRoom.playback?.playState ?? null,
          currentPlaybackTime:
            access.persistedRoom.playback?.currentTime ?? null,
        });
        return { room: access.persistedRoom, ignored: true };
      }

      let result: Awaited<ReturnType<typeof roomStore.updateRoom>>;
      try {
        result = await roomStore.updateRoom(
          access.persistedRoom.code,
          access.persistedRoom.version,
          {
            playback: nextPlayback,
            expiresAt: null,
            lastActiveAt: currentTime,
          },
        );
      } catch (error) {
        await runtimeStore.releaseMessageSlot(
          access.persistedRoom.code,
          playbackDedupKey,
        );
        throw error;
      }
      if (!result.ok) {
        if (result.reason === "version_conflict") {
          logEvent("room_version_conflict", {
            roomCode: access.persistedRoom.code,
            version: access.persistedRoom.version,
            sessionId: session.id,
            result: "ignored",
          });
          return { room: null, ignored: true };
        }
        await runtimeStore.releaseMessageSlot(
          access.persistedRoom.code,
          playbackDedupKey,
        );
        throw new RoomServiceError(
          "room_not_found",
          ROOM_NOT_FOUND_MESSAGE,
          "room_not_found",
        );
      }

      if (authorityKind) {
        recordPlaybackAuthority({
          roomCode: access.persistedRoom.code,
          actorId: nextPlayback.actorId,
          kind: authorityKind,
          source: "playback:update",
        });
      }

      const nextAuthority = getPlaybackAuthority(access.persistedRoom.code);
      // Skip steady timeupdate ticks so the admin event store keeps user
      // operations visible without being flooded by ~every-2s broadcasts:
      // log when playState, playbackRate, or syncIntent changes, or when
      // currentTime jumps beyond what natural progression at the prior
      // playback rate would produce. Anything else is a no-op tick. Actor
      // identity is intentionally not part of the steady-tick check because
      // the authority window (PLAYBACK_AUTHORITY_WINDOW_MS, 1.2s) is shorter
      // than the timeupdate cadence (~2s), so in multi-member rooms the
      // accepted actor rotates on each tick even when nobody touches
      // playback — gating on actor would re-flood the log. Elapsed time
      // uses the server-stamped serverTime — not the client-reported
      // updatedAt — so a modified client cannot forge a matching updatedAt
      // delta to mask a real seek.
      const previousPlayback = access.persistedRoom.playback;
      const elapsedSeconds =
        previousPlayback === null
          ? 0
          : (nextPlayback.serverTime - previousPlayback.serverTime) / 1000;
      const expectedTimeDelta =
        previousPlayback === null || previousPlayback.playState !== "playing"
          ? 0
          : previousPlayback.playbackRate * elapsedSeconds;
      const actualTimeDelta =
        previousPlayback === null
          ? 0
          : nextPlayback.currentTime - previousPlayback.currentTime;
      const isSteadyTick =
        previousPlayback !== null &&
        previousPlayback.playState === nextPlayback.playState &&
        Math.abs(previousPlayback.playbackRate - nextPlayback.playbackRate) <
          0.01 &&
        !nextPlayback.syncIntent &&
        Math.abs(actualTimeDelta - expectedTimeDelta) < 1;
      if (!isSteadyTick) {
        logEvent("playback_update_applied", {
          roomCode: access.persistedRoom.code,
          sessionId: session.id,
          ...actorDetails(session),
          seq: nextPlayback.seq,
          playState: nextPlayback.playState,
          currentTime: nextPlayback.currentTime,
          playbackRate: nextPlayback.playbackRate,
          syncIntent: nextPlayback.syncIntent ?? "none",
          result: "ok",
          authorityKind: nextAuthority?.kind ?? null,
          authorityActorId: nextAuthority?.actorId ?? null,
          authorityUntil: nextAuthority?.until ?? null,
        });
      }

      return { room: result.room, ignored: false };
    },

    async updateProfileForSession(session, memberToken, displayName) {
      const access = await requireJoinedRoomSession(
        session,
        memberToken,
        "profile:update",
      );
      const displayNameChanged = setSessionDisplayName(session, displayName);
      let room = access.persistedRoom;
      if (
        displayNameChanged &&
        (session.memberId ?? session.id) === access.persistedRoom.ownerMemberId
      ) {
        const updatedRoom = await withVersionRetry(
          access.persistedRoom.code,
          async (currentRoom) => {
            const result = await roomStore.updateRoom(
              currentRoom.code,
              currentRoom.version,
              {
                ownerDisplayName: session.displayName,
                lastActiveAt: now(),
              },
            );
            if (!result.ok) {
              return null;
            }
            return result.room;
          },
        );
        if (updatedRoom) {
          room = updatedRoom;
        } else {
          logEvent("room_persist_failed", {
            roomCode: access.persistedRoom.code,
            sessionId: session.id,
            provider: persistence.provider,
            result: "error",
            reason: "owner_profile_update_conflict",
          });
        }
      }
      await runtimeStore.flush?.();
      return { room };
    },

    async getRoomStateForSession(session, memberToken, messageType) {
      const access = await requireJoinedRoomSession(
        session,
        memberToken,
        messageType,
      );
      const persistedRoom = await resolveRoom(access.persistedRoom.code);
      if (!persistedRoom) {
        throw new RoomServiceError(
          "room_not_found",
          ROOM_NOT_FOUND_MESSAGE,
          "room_not_found",
        );
      }
      return roomStateFromSessions(
        persistedRoom,
        await runtimeStore.listClusterSessionsByRoom(persistedRoom.code),
      );
    },

    getActiveRoom(roomCode) {
      return runtimeStore.getRoom(roomCode);
    },

    getPlaybackAuthority(roomCode) {
      return getPlaybackAuthority(roomCode);
    },

    async getRoomStateByCode(roomCode) {
      const room = await resolveRoom(roomCode);
      if (!room) {
        return null;
      }
      return roomStateFromSessions(
        room,
        await runtimeStore.listClusterSessionsByRoom(roomCode),
      );
    },

    async deleteExpiredRooms(currentTime = now()) {
      return await roomStore.deleteExpiredRooms(currentTime);
    },
  };
}
