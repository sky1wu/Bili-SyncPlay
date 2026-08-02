import { randomUUID } from "node:crypto";
import type { ActiveRoomRegistry } from "./active-room-registry.js";
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
import { sharedVideoOwnerChangedOnLeave } from "./shared-video-owner.js";
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
const PLAYBACK_AUTHORITY_SWEEP_INTERVAL_MS = 60_000;
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

/**
 * 房间服务实际依赖的运行时存储子集。`registerSession` / `flush` 在服务内均以可选
 * 调用（`?.`）访问，因此只要求 `ActiveRoomRegistry` 那一组方法；完整的
 * `RuntimeStore` 是它的超集，仍可直接传入。
 */
export type RoomServiceRuntimeStore = ActiveRoomRegistry &
  Partial<Pick<RuntimeStore, "registerSession" | "flush">>;

/**
 * Why a session is leaving a room. Identity (`memberToken`) survives a
 * `"disconnect"` and is revoked on a `"client-request"`; see `leaveCurrentRoom`.
 */
export type LeaveRoomReason = "client-request" | "disconnect";

type JoinedRoomAccess = {
  session: Session;
  persistedRoom: PersistedRoom;
  activeRoom: ReturnType<RuntimeStore["getOrCreateRoom"]>;
};

type JoinTargetState = {
  activeRoom: ActiveRoom | null;
  reconnectMemberId: string | null;
  /**
   * Whether `reconnectMemberId` is still occupying a seat, i.e. this join
   * replaces a live session rather than adding a member.
   *
   * Not the same thing as `reconnectMemberId !== null` any more. Member tokens
   * now outlive a disconnect (#234), so a member who dropped hours ago still
   * resolves one — and treating that as a seat-holder let them rejoin past
   * `maxMembersPerRoom` once someone else had taken the last seat, once per
   * disconnected member (#237 review).
   */
  reconnectHoldsSeat: boolean;
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
  runtimeStore?: RoomServiceRuntimeStore;
  activeRooms?: RoomServiceRuntimeStore;
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
  resolveRoomResidue?: (roomCode: string) => Promise<boolean>;
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
  leaveRoomForSession: (
    session: Session,
    reason?: LeaveRoomReason,
  ) => Promise<{
    room: PersistedRoom | null;
    notifyRoom?: boolean;
    memberRemoved?: boolean;
    /**
     * The caller owes the room a full `room:state` on top of the
     * `room:member-left` delta, because a delta only edits the recipient's
     * member list and leaves its cached `sharedVideo` untouched (#235).
     *
     * Set when the leave moved the share to another member — and also when a
     * persistence failure meant we could not work out whether it did.
     */
    needsRoomStateResync?: boolean;
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
  teardownRoomRuntime: (code: string) => Promise<void>;
} {
  const { config, persistence, roomStore, generateToken, logEvent } = options;
  const runtimeStoreOption = options.runtimeStore ?? options.activeRooms;
  const now = options.now ?? Date.now;
  const nextRoomCode = options.createRoomCode ?? createRoomCode;
  const playbackAuthorityByRoom = new Map<string, PlaybackAuthority>();

  if (!runtimeStoreOption) {
    throw new Error("RuntimeStore is required");
  }
  const runtimeStore: RoomServiceRuntimeStore = runtimeStoreOption;
  const resolveActiveRoom =
    options.resolveActiveRoom ??
    ((roomCode: string) => Promise.resolve(runtimeStore.getRoom(roomCode)));
  const resolveMemberIdByToken =
    options.resolveMemberIdByToken ??
    ((roomCode: string, memberToken: string) =>
      Promise.resolve(runtimeStore.findMemberIdByToken(roomCode, memberToken)));
  const resolveRoomResidue =
    options.resolveRoomResidue ??
    ((roomCode: string) =>
      Promise.resolve(runtimeStore.hasRoomResidue(roomCode)));
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

  /**
   * Room codes whose runtime teardown failed, retried on every later reaper
   * pass. Kept because a failed teardown is otherwise unrecoverable: the
   * persisted room and its expiry index are already gone, so nothing else will
   * ever produce this code again (#237 review).
   */
  const pendingRuntimeTeardowns = new Set<string>();

  async function collectRuntimeStateForDeletedRooms(
    codes: Iterable<string>,
  ): Promise<void> {
    for (const code of new Set(codes)) {
      // Defence in depth behind the allocation-time check: a teardown queued
      // for retry could otherwise fire after its code came back into use — the
      // residue it was queued for may have expired on its own in the meantime,
      // which frees the code for allocation.
      //
      // A read failure is "unknown", NOT "absent". Treating it as absent made
      // this guard fail in exactly the conditions that queue teardowns in the
      // first place, and it would then wipe the new room's members and tokens
      // (#237 review). Keep the debt and try again later.
      // Pinned BEFORE anything is checked, so it names the room instance this
      // teardown is about. Reading it after the absence check below left a
      // second window: a code recycled between the two reads handed us the NEW
      // room's generation, which then matched and wiped it (#237 review).
      let expectedGeneration: string | null;
      try {
        expectedGeneration = await runtimeStore.getRoomGeneration(code);
      } catch {
        pendingRuntimeTeardowns.add(code);
        continue;
      }

      let currentRoom: PersistedRoom | null;
      try {
        currentRoom = await roomStore.getRoom(code);
      } catch {
        // A read failure is "unknown", NOT "absent". Treating it as absent made
        // this guard fail in exactly the conditions that queue teardowns in the
        // first place. Keep the debt and try again later.
        pendingRuntimeTeardowns.add(code);
        continue;
      }
      if (currentRoom) {
        pendingRuntimeTeardowns.delete(code);
        continue;
      }
      try {
        // The delete only applies while that generation still holds. Both
        // guards around it are check-then-act; no arrangement of them makes the
        // delete itself conditional, which is what actually closes the race.
        await runtimeStore.deleteRoom(code, expectedGeneration);
        pendingRuntimeTeardowns.delete(code);
      } catch (error) {
        pendingRuntimeTeardowns.add(code);
        logEvent("room_runtime_cleanup_failed", {
          roomCode: code,
          provider: persistence.provider,
          result: "error",
          pendingRetryCount: pendingRuntimeTeardowns.size,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async function resolveRoom(code: string): Promise<PersistedRoom | null> {
    const room = await roomStore.getRoom(code);
    if (!room) {
      return null;
    }
    if (room.expiresAt !== null && room.expiresAt <= now()) {
      await roomStore.deleteRoom(code);
      // Same helper as the reaper: it refuses to tear down a code that has
      // already been recycled, and queues a failed teardown for retry.
      await collectRuntimeStateForDeletedRooms([code]);
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

  let lastAuthoritySweepAt = 0;

  // getPlaybackAuthority only removes the entry for the room it is asked
  // about, so authorities of rooms that are deleted (or simply never read
  // again) would sit in the map forever. Sweeping on record keeps the map
  // bounded across every room-deletion path without wiring into them.
  function sweepExpiredPlaybackAuthorities(currentTime: number): void {
    if (
      currentTime - lastAuthoritySweepAt <
      PLAYBACK_AUTHORITY_SWEEP_INTERVAL_MS
    ) {
      return;
    }
    lastAuthoritySweepAt = currentTime;
    for (const [roomCode, authority] of playbackAuthorityByRoom) {
      if (authority.until <= currentTime) {
        playbackAuthorityByRoom.delete(roomCode);
      }
    }
  }

  function recordPlaybackAuthority(args: {
    roomCode: string;
    actorId: string;
    kind: PlaybackAuthority["kind"];
    source: PlaybackAuthority["source"];
  }): void {
    sweepExpiredPlaybackAuthorities(now());
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
      reconnectHoldsSeat:
        reconnectMemberId !== null &&
        (activeRoom?.members.has(reconnectMemberId) ?? false),
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
      !joinTargetState.reconnectHoldsSeat
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
      // A reconnect that no longer holds a seat consumes one like any other
      // join, so it has to serialize on the admission lock too.
      const needsCapacitySerialization = !joinTargetState.reconnectHoldsSeat;

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

  /**
   * `reason` decides whether the member's identity survives.
   *
   * - `"client-request"` — an explicit `room:leave`. The member is done with the
   *   room, so their `memberToken` is revoked and a later join is issued a fresh
   *   `memberId`.
   * - `"disconnect"` — the socket closed. The client still holds its token and
   *   is expected to come back with it, so identity is KEPT. Revoking here is
   *   what broke #234: every server restart closes every socket at once, so
   *   every member returned with a new `memberId` and
   *   `sharedVideo.sharedByMemberId` matched nobody.
   */
  async function leaveCurrentRoom(
    session: Session,
    reason: LeaveRoomReason = "client-request",
  ): Promise<{
    room: PersistedRoom | null;
    notifyRoom?: boolean;
    memberRemoved?: boolean;
    needsRoomStateResync?: boolean;
  }> {
    if (!session.roomCode) {
      return { room: null };
    }

    const roomCode = session.roomCode;
    const leavingMemberId = session.memberId ?? session.id;
    const leavingDisplayName = session.displayName;
    const leavingJoinedAt = session.joinedAt;
    const sessionSnapshot = snapshotJoinedSession(session);
    const removal = session.memberId
      ? runtimeStore.removeMember(roomCode, session.memberId, session)
      : {
          room: runtimeStore.getRoom(roomCode),
          roomEmpty: false,
          removed: false,
        };
    // The session is passed so the STORE decides whether this leave still owns
    // the identity, against the shared member binding. Gating on `removal.removed`
    // instead only worked within one node: the mirrored store returns the local
    // removal, so after a member reconnected onto another node the old node still
    // considered its stale session the current member and would revoke the token
    // the new node was using (#237 review).

    // Recomputed from the shared view inside the try; the catch reads it too.
    let roomEmpty = removal.roomEmpty;

    try {
      // Inside the try: revoking is a durable write that now rejects when it
      // fails, and outside the recovery path a failure left the member removed
      // from the runtime while `clearSessionRoom` had not run — the client got
      // an internal error still believing it was joined, with no runtime
      // membership behind it (#237 review). `restoreLeaveState` in the catch
      // re-adds the member with the snapshot token, undoing both.
      if (reason === "client-request" && session.memberId) {
        await runtimeStore.revokeMemberToken(
          roomCode,
          session.memberId,
          session,
        );
      }
      await runtimeStore.flush?.();
      // The removal's REAL outcome, which `flush` cannot give: it waits on the
      // error-swallowed copies kept for backpressure accounting. A failed member
      // write leaves the leaver in the member hash that `resolveActiveRoom`
      // reads below, while the session-index cleanup that `room:state` is built
      // from goes on to succeed — the election would then be decided from a view
      // no client ever sees (#235 review).
      const memberRemovalConfirmed = await Promise.resolve(removal.durable)
        .then(() => true)
        .catch(() => false);
      clearSessionRoom(session);

      const persistedRoom = await resolveRoom(roomCode);
      if (!persistedRoom) {
        return { room: null };
      }

      // Emptiness has to come from the SHARED member state. `removal.roomEmpty`
      // is this node's local view: when an old node's socket cleanup interleaves
      // with the same member reconnecting elsewhere, the old node removes its
      // only local member and calls the room empty — then writes an `expiresAt`
      // over the one the new node's join had just cleared, and the reaper
      // eventually deletes a room that still has members (#237 review).
      // A successful read that finds no active room means the room IS empty; a
      // failed read means nothing at all. Collapsing both into `null` is what
      // let an unreadable view fall back to `removal.roomEmpty` — reinstating
      // the very thing the paragraph above describes, on the one path where
      // nothing can contradict it: the expiry lands on a room other nodes are
      // still using, and the same `!roomEmpty` guard swallows the resync that
      // would have told them (#235 review).
      const sharedView = await resolveActiveRoom(roomCode).then(
        (room) => ({ readable: true as const, room }),
        () => ({ readable: false as const, room: null }),
      );
      const sharedRoom = sharedView.room;
      // The shared view can still be carrying THIS leave's own entry: the member
      // write is queued, and an unconfirmed one leaves the seat behind. Only our
      // own stale entry is discounted — the binding has to still name this very
      // session, so a member who reconnected elsewhere keeps their seat and the
      // #237 hazard above stays closed. Without this the room's last member
      // could not empty it: the leaver kept it "occupied", no `expiresAt` was
      // written, and nothing afterwards collects the room, its member map or its
      // tokens (#235 review).
      const remainingMembers = Array.from(sharedRoom?.members ?? []).filter(
        ([memberId, member]) =>
          memberId !== leavingMemberId || member.id !== session.id,
      );
      // Unknown counts as non-empty. That can strand a genuinely empty room
      // without an `expiresAt`, which is the trade this file already makes in
      // the catch below: an orphan is recoverable, an erased live room is not.
      roomEmpty = sharedView.readable ? remainingMembers.length === 0 : false;
      if (!sharedView.readable) {
        logEvent("room_leave_orphan_possible", {
          sessionId: session.id,
          roomCode,
          remoteAddress: session.remoteAddress,
          origin: session.origin,
          provider: persistence.provider,
          reason: "shared_member_view_unreadable",
        });
      }

      // Derived from the member list this leave already loaded, so it adds no
      // store read. An unreadable shared view means we cannot run the election
      // at all, and that resolves to a resync request rather than to silence —
      // the same call the catch below makes, for the same reason: a room left
      // pointing at a member who is gone has nothing scheduled to correct it,
      // while an unnecessary broadcast costs one message (#235 review).
      // An emptied room is the one case that needs neither: nobody is left to
      // hold a wrong owner, and the election has no candidates to run over.
      const needsRoomStateResync =
        !roomEmpty &&
        (!sharedRoom ||
          !memberRemovalConfirmed ||
          sharedVideoOwnerChangedOnLeave({
            sharedByMemberId: persistedRoom.sharedVideo?.sharedByMemberId,
            membersAfter: remainingMembers.map(([memberId, member]) => ({
              id: memberId,
              joinedAt: member.joinedAt,
            })),
            leavingMember: {
              id: leavingMemberId,
              joinedAt: sessionSnapshot?.joinedAt ?? leavingJoinedAt,
            },
          }));

      if (!roomEmpty) {
        logEvent("room_left", {
          sessionId: session.id,
          roomCode,
          memberId: leavingMemberId,
          displayName: leavingDisplayName,
          remoteAddress: session.remoteAddress,
          origin: session.origin,
          result: "ok",
        });
        return {
          room: persistedRoom,
          memberRemoved: removal.removed,
          needsRoomStateResync,
        };
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
          if (roomEmpty) {
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
        return {
          room: null,
          notifyRoom: true,
          memberRemoved: removal.removed,
          // We never got far enough to run the election, so whether this member
          // held the share is unknowable here. Ask for the full state anyway:
          // over-sending costs one broadcast, while staying silent leaves every
          // remaining client pointing at a member who is gone until some
          // unrelated event happens to resync them (#235).
          needsRoomStateResync: true,
        };
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
    /**
     * Tear down a deleted room's runtime state, guarded and retried.
     *
     * Exposed so the admin paths use the same one entry point: they delete the
     * persisted room irrecoverably first, so a teardown that fails there has no
     * way back — the room code would never reach the reaper again (#237 review).
     */
    async teardownRoomRuntime(code: string) {
      // The backlog rides along. `deleteExpiredRooms` is the only other thing
      // that drains it, and the standalone global-admin process never runs the
      // reaper — an admin close/expire whose teardown failed there would have
      // queued a retry nothing ever performed (#237 review).
      await collectRuntimeStateForDeletedRooms([
        ...pendingRuntimeTeardowns,
        code,
      ]);
    },
    async createRoomForSession(session, displayName) {
      setSessionDisplayName(session, displayName);
      await leaveCurrentRoom(session);

      const createdAt = now();
      let room: PersistedRoom | null = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const roomCode = nextRoomCode();
        // Room codes are recycled, so a code is only safe to hand out once no
        // runtime state remains under it. Enforcing that HERE — at the one point
        // where a code becomes live — is what makes the rest of the lifecycle
        // simple: a teardown can never collide with a new room, and a new room
        // can never inherit the previous occupant's identities, so neither needs
        // its own guard (#237 review).
        //
        // Every runtime key, not just the members/tokens view `getRoom` gives:
        // a code carrying only leftover session index entries, blocked tokens,
        // dedup slots or a generation would otherwise read as free and take the
        // old room's ghosts into the new one (#237 review).
        //
        // An unreadable runtime store means "unknown", never "empty": try
        // another code rather than risk handing out a dirty one.
        const dirty = await resolveRoomResidue(roomCode).catch(() => true);
        if (dirty) {
          continue;
        }
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

      // A fresh generation marks the start of this room instance. Any teardown
      // still owed for the code's previous occupant was decided against the old
      // one and will now decline.
      //
      // On failure the persisted room has to go with it: it would otherwise sit
      // there with no members and no `expiresAt`, which the reaper never
      // collects, holding its code and counting towards room totals forever
      // (#237 review).
      try {
        await runtimeStore.markRoomGeneration(room.code, randomUUID());
      } catch (error) {
        // CAS on the version we just created, not a delete by code. Between the
        // failure and this line an admin can expire the (still memberless) room
        // and another request can take the code — deleting by code would then
        // remove the replacement out from under its owner, who had already been
        // told the creation succeeded (#237 review).
        //
        // Expiring rather than deleting: `updateRoom` is the only conditional
        // primitive the store has, and a room marked expired is collected by the
        // reaper and can never be mistaken for a live one.
        await roomStore
          .updateRoom(room.code, room.version, { expiresAt: now() })
          .catch(() => undefined);
        logEvent("room_persist_failed", {
          sessionId: session.id,
          roomCode: room.code,
          provider: persistence.provider,
          result: "error",
          reason: "room_generation_mark_failed",
          error: error instanceof Error ? error.message : String(error),
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
          // Deliberately no `revokeMemberToken` here. `removeMember` already
          // declines when a newer session owns this memberId, but a bare revoke
          // has no such guard and would delete that live session's binding. The
          // leftover binding is harmless either way: the client whose join failed
          // reclaims the same memberId when it retries with the same token, which
          // is what we want.
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

      // A steady tick must not refresh the authority window. It carries no new
      // intent by definition — same playState, same rate, no syncIntent, and a
      // currentTime that only advanced as far as the previous rate predicts —
      // yet recording it used to push the 1.2s veto window forward in full,
      // which is what `decidePlaybackAcceptance` reads to drop other members'
      // updates as `authority-window-follow`.
      //
      // That turned a repeated `paused` frame into a rolling veto: a peer that
      // hard-seeks across a shared-video switch leaks its just-applied pause
      // back as two identical frames, and the second one extends the window
      // far enough to swallow every `playing` the sharer emits while its own
      // autoplay-next starts up — the room sticks at paused with nobody having
      // paused anything. Only the frame that actually changes something may
      // claim the veto.
      //
      // The gate is deliberately the same predicate as the applied-event log
      // below: a frame that is not worth an audit entry is not worth a veto,
      // and keeping one predicate means the log stays an accurate record of
      // which frames can move the authority.
      if (authorityKind && !isSteadyTick) {
        recordPlaybackAuthority({
          roomCode: access.persistedRoom.code,
          actorId: nextPlayback.actorId,
          kind: authorityKind,
          source: "playback:update",
        });
      }

      const nextAuthority = getPlaybackAuthority(access.persistedRoom.code);
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
      const deletedCodes = await roomStore.deleteExpiredRooms(currentTime);
      // Retries first, then this pass's own codes. The reaper is the only path
      // that deletes a room nobody touches again, so it is also the only chance
      // to collect the runtime state that outlives it — member tokens survive a
      // disconnect on purpose (#234) — and once the persisted room is gone
      // nothing will ever name that code again (#237 review).
      await collectRuntimeStateForDeletedRooms([
        ...pendingRuntimeTeardowns,
        ...deletedCodes,
      ]);
      return deletedCodes.length;
    },
  };
}
