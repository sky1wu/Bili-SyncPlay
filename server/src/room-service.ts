import { randomUUID } from "node:crypto";
import type { ActiveRoomRegistry } from "./active-room-registry.js";
import type { MetricsCollector } from "./admin/metrics.js";
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
  type RoomDeleteOutcome,
  type RoomReadCaller,
  type RoomStore,
} from "./room-store.js";
import { createRetryPacer } from "./retry-pacer.js";
import type { RuntimeReadCaller, RuntimeStore } from "./runtime-store.js";
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
/**
 * How many times the rollback of an unstamped room re-reads and re-CASes.
 *
 * Its own constant rather than `MAX_VERSION_RETRIES`: that one bounds a
 * request's optimistic update of a LIVE room, where giving up simply reports a
 * conflict to the caller. This one bounds a compensation whose failure leaves a
 * room nothing collects, so the two are free to move for different reasons.
 */
const ROOM_ROLLBACK_MAX_ATTEMPTS = 3;
const ROOM_LAST_ACTIVE_WRITE_INTERVAL_MS = 30_000;
const JOIN_ADMISSION_LOCK_KEY = "join-admission";
const JOIN_ADMISSION_LOCK_TTL_MS = 30_000;
const JOIN_ADMISSION_LOCK_MAX_WAIT_MS = 5_000;
const JOIN_ADMISSION_LOCK_RETRY_INTERVAL_MS = 25;

/**
 * How long a request waits to confirm guarded runtime teardown.
 *
 * This is a behaviour deadline, not Redis's connection-liveness backstop. The
 * two happen to start at the same magnitude, but must be free to move for
 * different reasons (#271, #277).
 */
export const DEFAULT_RUNTIME_TEARDOWN_CONFIRM_TIMEOUT_MS = 5_000;

/**
 * How long a reader waits for an expired room's collection to confirm.
 *
 * Its own constant, not the teardown's: this one bounds a READ that found an
 * expired room. If the bound wins, the read fails retryably rather than
 * claiming the room is absent: the guarded delete may still answer
 * `superseded`, which means another node kept that room alive. The teardown's
 * constant instead bounds a request waiting to know whether cleanup happened.
 * Two behaviours, two constants (#271).
 */
export const DEFAULT_ROOM_DELETE_CONFIRM_TIMEOUT_MS = 5_000;

/**
 * Leaves one second inside the shutdown step for reporting and dependency close
 * hand-off. The delete and teardown pacers share this one budget below.
 */
export const DEFAULT_ROOM_SERVICE_CLOSE_BUDGET_MS = 4_000;

type ServiceErrorReason =
  | "room_not_found"
  | "join_token_invalid"
  | "member_token_invalid"
  | "not_in_room"
  | "room_full"
  | "invalid_message"
  | "room_resolution_unconfirmed"
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

type RoomExpiryResolutionUnconfirmedTrigger =
  "delete_timeout" | "service_closing" | "still_expired_after_superseded";

/**
 * "This room's collection has not confirmed" — a DIAGNOSIS, not a wire code.
 *
 * The distinction is deliberately kept off the protocol. On the wire this is
 * `internal_error`, the same answer every other bounded store command already
 * gives when it cannot answer, and the only pre-v5 code that reports "no
 * answer" without asserting one. Minting a code for it would cost a protocol
 * version, a compatibility gate for every older client, and a client-side
 * state machine — for a window that heals itself on the next attempt. The
 * `trigger` and `confirmation` details below keep the diagnosis where it is
 * actually needed: the log.
 */
class RoomExpiryResolutionUnconfirmedError extends RoomServiceError {
  constructor(
    roomCode: string,
    readonly trigger: RoomExpiryResolutionUnconfirmedTrigger,
    timeoutMs?: number,
  ) {
    super(
      "internal_error",
      INTERNAL_SERVER_ERROR_MESSAGE,
      "room_resolution_unconfirmed",
      {
        roomCode,
        reason: "room_expiry_resolution_unconfirmed",
        trigger,
        confirmation: "unconfirmed",
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
    );
    this.name = "RoomExpiryResolutionUnconfirmedError";
  }
}

class RuntimeTeardownConfirmationTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(
      `Runtime room teardown did not confirm within ${timeoutMs}ms; its real effect is still tracked.`,
    );
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

/**
 * What one expiry sweep did, counted. The two are reported apart because only
 * the first is a reclaimed room — see `ExpiredRoomSweep` in `room-store`.
 */
export type ExpiredRoomSweepCounts = {
  deletedRooms: number;
  orphanedIndexEntries: number;
};

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
  /**
   * Meters rooms reclaimed because they expired. Both expiry paths live in this
   * file, so this is the only layer that sees all of them; the reaper's log
   * event fires once per sweep and cannot answer "how many rooms".
   */
  metricsCollector?: Pick<MetricsCollector, "recordRoomsExpiredDeleted">;
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
  /** Request-side confirmation budget; maintenance passes keep their own cap. */
  runtimeTeardownConfirmationTimeoutMs?: number;
  /** How long a reader waits for an expired room's collection to confirm. */
  roomDeleteConfirmationTimeoutMs?: number;
  /** Shared by late persisted-room deletions and runtime teardown effects. */
  closeBudgetMs?: number;
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
  deleteExpiredRooms: (currentTime?: number) => Promise<ExpiredRoomSweepCounts>;
  teardownRoomRuntime: (code: string) => Promise<void>;
  close: () => Promise<void>;
} {
  const { config, persistence, roomStore, generateToken, logEvent } = options;
  const runtimeStoreOption = options.runtimeStore ?? options.activeRooms;
  const now = options.now ?? Date.now;
  const nextRoomCode = options.createRoomCode ?? createRoomCode;
  const runtimeTeardownConfirmationTimeoutMs =
    options.runtimeTeardownConfirmationTimeoutMs ??
    DEFAULT_RUNTIME_TEARDOWN_CONFIRM_TIMEOUT_MS;
  const runtimeTeardownConfirmationPacer = createRetryPacer({
    initialDelayMs: runtimeTeardownConfirmationTimeoutMs,
    maxDelayMs: runtimeTeardownConfirmationTimeoutMs,
  });
  const roomDeleteConfirmationTimeoutMs =
    options.roomDeleteConfirmationTimeoutMs ??
    DEFAULT_ROOM_DELETE_CONFIRM_TIMEOUT_MS;
  const roomDeleteConfirmationPacer = createRetryPacer({
    initialDelayMs: roomDeleteConfirmationTimeoutMs,
    maxDelayMs: roomDeleteConfirmationTimeoutMs,
  });
  const closeBudgetMs =
    options.closeBudgetMs ?? DEFAULT_ROOM_SERVICE_CLOSE_BUDGET_MS;
  let closing = false;
  let closePromise: Promise<void> | null = null;
  const playbackAuthorityByRoom = new Map<string, PlaybackAuthority>();
  const expiredRoomCollectionEffects = new Map<
    string,
    Promise<RoomDeleteOutcome>
  >();

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

  async function releaseMessageSlotBestEffort(
    roomCode: string,
    key: string,
    token: string,
    slotKind: "share" | "playback",
  ): Promise<void> {
    try {
      await runtimeStore.releaseMessageSlot(roomCode, key, token);
    } catch (error) {
      // This is rollback after the request's business outcome is already
      // known. A Redis timeout here must not replace a useful validation,
      // persistence, or version error with cleanup noise (#278 review).
      try {
        logEvent("message_slot_release_failed", {
          roomCode,
          slotKind,
          result: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Logging is diagnostic; it cannot become a second cleanup failure.
      }
    }
  }

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
    void runtimeStore.registerSession?.(session);
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
    // Swallowed here alone: this runs while an earlier failure is being
    // compensated, and letting the barrier's own rejection escape would replace
    // the error the caller is reporting (#242 review).
    await runtimeStore.flush?.().catch(() => undefined);

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
   * One real teardown effect per room generation. A request may stop waiting
   * for confirmation, but this promise stays alive until the guarded Redis
   * write and every local mirror behind it have settled. The generation belongs
   * in the identity: a stale effect must not hide cleanup for a later occupant
   * that reused the same room code. Reusing each exact effect prevents a busy
   * request path from turning one stalled teardown into duplicate commands.
   */
  type RuntimeTeardownEffect = {
    expectedGeneration: string | null;
    effect: Promise<boolean>;
    /** One request-side cap shared by every waiter on this exact effect. */
    requestConfirmation: Promise<boolean> | null;
    confirmationTimedOut: boolean;
  };

  type RuntimeTeardownDebt = {
    /** The effect currently responsible for settling this debt, if any. */
    owner: RuntimeTeardownEffect | null;
  };

  /**
   * Room codes whose runtime teardown is unfinished, and the exact effect that
   * most recently took responsibility for each debt. Every debt is its own
   * identity so a reaper candidate can prove, after its precondition awaits,
   * that the debt it captured still exists. A null owner means that exact debt
   * is waiting for a fresh attempt after an unreadable precondition or a
   * terminal skip/failure. A newer generation effect, or observing a live
   * persisted room, supersedes the whole debt record; an older effect may still
   * settle and log its own outcome, but cannot resurrect or retain someone
   * else's debt.
   *
   * Kept because a failed teardown is otherwise unrecoverable: the persisted
   * room and its expiry index are already gone, so nothing else will ever
   * produce this code again (#237 review, #277).
   */
  const pendingRuntimeTeardowns = new Map<string, RuntimeTeardownDebt>();
  const runtimeTeardownEffects = new Map<
    string,
    Map<string | null, RuntimeTeardownEffect>
  >();

  function rememberRuntimeTeardownDebt(code: string): void {
    if (!pendingRuntimeTeardowns.has(code)) {
      // Do not replace an in-flight owner merely because a sibling precondition
      // read was inconclusive. Its terminal result still answers this debt.
      pendingRuntimeTeardowns.set(code, { owner: null });
    }
  }

  function removeRuntimeTeardownEffect(
    code: string,
    entry: RuntimeTeardownEffect,
  ): void {
    const effectsByGeneration = runtimeTeardownEffects.get(code);
    if (effectsByGeneration?.get(entry.expectedGeneration) !== entry) {
      return;
    }
    effectsByGeneration.delete(entry.expectedGeneration);
    if (effectsByGeneration.size === 0) {
      runtimeTeardownEffects.delete(code);
    }
  }

  function logRuntimeTeardownTerminal(
    event:
      "room_runtime_cleanup_late_settled" | "room_runtime_cleanup_late_failed",
    code: string,
    details: Record<string, unknown>,
  ): void {
    try {
      logEvent(event, {
        roomCode: code,
        provider: persistence.provider,
        pendingRetryCount: pendingRuntimeTeardowns.size,
        ...details,
      });
    } catch {
      // Diagnostics must not turn a settled cleanup effect into a rejection.
    }
  }

  function startRuntimeTeardownEffect(
    code: string,
    expectedGeneration: string | null,
  ): RuntimeTeardownEffect {
    let effectsByGeneration = runtimeTeardownEffects.get(code);
    const existing = effectsByGeneration?.get(expectedGeneration);
    if (existing) {
      // Ownership is assigned when an effect is CREATED, never when it is
      // reused. A waiter may carry this generation across the room-read await;
      // letting it reassign here would allow an old snapshot to take the debt
      // back from a newer generation effect that started in the meantime.
      return existing;
    }

    let effect: Promise<boolean>;
    try {
      effect = Promise.resolve(
        runtimeStore.deleteRoom(code, expectedGeneration),
      );
    } catch (error) {
      effect = Promise.reject(error);
    }
    const entry: RuntimeTeardownEffect = {
      expectedGeneration,
      effect,
      requestConfirmation: null,
      confirmationTimedOut: false,
    };
    if (!effectsByGeneration) {
      effectsByGeneration = new Map();
      runtimeTeardownEffects.set(code, effectsByGeneration);
    }
    effectsByGeneration.set(expectedGeneration, entry);
    pendingRuntimeTeardowns.set(code, { owner: entry });

    void effect.then(
      (applied) => {
        removeRuntimeTeardownEffect(code, entry);
        const debt = pendingRuntimeTeardowns.get(code);
        if (debt?.owner === entry) {
          if (applied) {
            pendingRuntimeTeardowns.delete(code);
          } else {
            debt.owner = null;
          }
        }
        if (entry.confirmationTimedOut) {
          logRuntimeTeardownTerminal(
            "room_runtime_cleanup_late_settled",
            code,
            { result: applied ? "ok" : "skipped" },
          );
        }
      },
      (error: unknown) => {
        removeRuntimeTeardownEffect(code, entry);
        const debt = pendingRuntimeTeardowns.get(code);
        if (debt?.owner === entry) {
          debt.owner = null;
        }
        if (entry.confirmationTimedOut) {
          logRuntimeTeardownTerminal("room_runtime_cleanup_late_failed", code, {
            result: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return entry;
  }

  async function awaitRuntimeTeardownEffect(
    entry: RuntimeTeardownEffect,
    caller: RuntimeReadCaller,
  ): Promise<boolean> {
    if (caller === "maintenance_pass") {
      return await entry.effect;
    }
    if (!entry.requestConfirmation) {
      entry.requestConfirmation = runtimeTeardownConfirmationPacer.capAttempt(
        entry.effect,
        runtimeTeardownConfirmationTimeoutMs,
        () => {
          entry.confirmationTimedOut = true;
          return new RuntimeTeardownConfirmationTimeoutError(
            runtimeTeardownConfirmationTimeoutMs,
          );
        },
      );
    }
    return await entry.requestConfirmation;
  }

  function reportRuntimeTeardownWaitFailure(
    code: string,
    error: unknown,
  ): void {
    const unconfirmed =
      error instanceof RuntimeTeardownConfirmationTimeoutError;
    logEvent(
      unconfirmed
        ? "room_runtime_cleanup_unconfirmed"
        : "room_runtime_cleanup_failed",
      {
        roomCode: code,
        provider: persistence.provider,
        result: unconfirmed ? "unconfirmed" : "error",
        pendingRetryCount: pendingRuntimeTeardowns.size,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }

  async function collectRuntimeStateForDeletedRooms(
    pendingCandidates: Iterable<readonly [string, RuntimeTeardownDebt]>,
    freshCodes: Iterable<string>,
    caller: RoomReadCaller,
  ): Promise<Set<string>> {
    const settledCodes = new Set<string>();
    const candidates = new Map<string, RuntimeTeardownDebt | undefined>();
    for (const [code, debt] of pendingCandidates) {
      candidates.set(code, debt);
    }
    // A fresh persisted-room deletion or explicit admin teardown supersedes a
    // backlog snapshot for the same code and owns a new cleanup decision.
    for (const code of freshCodes) {
      candidates.set(code, undefined);
    }

    for (const [code, expectedDebt] of candidates) {
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
      // It is re-read after the room lookup as a CONFIRMATION: otherwise a
      // waiter carrying this old pin across that await can retake retry-debt
      // ownership from a newer generation effect (#277 review).
      let expectedGeneration: string | null;
      try {
        expectedGeneration = await runtimeStore.getRoomGeneration(code, caller);
      } catch {
        rememberRuntimeTeardownDebt(code);
        continue;
      }

      let currentRoom: PersistedRoom | null;
      try {
        currentRoom = await roomStore.getRoom(code, caller);
      } catch {
        // A read failure is "unknown", NOT "absent". Treating it as absent made
        // this guard fail in exactly the conditions that queue teardowns in the
        // first place. Keep the debt and try again later.
        rememberRuntimeTeardownDebt(code);
        continue;
      }
      if (currentRoom) {
        pendingRuntimeTeardowns.delete(code);
        settledCodes.add(code);
        continue;
      }

      let confirmedGeneration: string | null;
      try {
        confirmedGeneration = await runtimeStore.getRoomGeneration(
          code,
          caller,
        );
      } catch {
        rememberRuntimeTeardownDebt(code);
        continue;
      }
      if (confirmedGeneration !== expectedGeneration) {
        // This invocation's absence snapshot and generation pin no longer name
        // one room instance. A current/newer effect owns any cleanup debt; this
        // stale waiter must not create, reuse, or take ownership of an effect.
        continue;
      }
      if (
        expectedDebt !== undefined &&
        pendingRuntimeTeardowns.get(code) !== expectedDebt
      ) {
        // This backlog item was settled or superseded while its preconditions
        // were in flight. It no longer licenses another teardown effect.
        continue;
      }
      try {
        // The delete only applies while that generation still holds. Both
        // guards around it are check-then-act; no arrangement of them makes the
        // delete itself conditional, which is what actually closes the race.
        const effect = startRuntimeTeardownEffect(code, expectedGeneration);
        await awaitRuntimeTeardownEffect(effect, caller);
        settledCodes.add(code);
      } catch (error) {
        reportRuntimeTeardownWaitFailure(code, error);
      }
    }
    return settledCodes;
  }

  /**
   * One effect: the guarded delete AND everything a successful one owes.
   *
   * They belong together because a reader may stop waiting. The cap below
   * answers that reader without cancelling the command, so anything left
   * outside this chain — the reclamation metric, the runtime teardown — would
   * simply not happen once the delete lands late, and each caller would have to
   * grow its own compensation for it (#277 review).
   */
  async function collectExpiredRoom(code: string): Promise<RoomDeleteOutcome> {
    const outcome = await roomStore.deleteExpiredRoom(code, now());
    if (outcome === "superseded") {
      // Nothing of that room to collect, and the runtime state under this code
      // belongs to whoever holds it now — the one case where the teardown would
      // be actively wrong.
      return outcome;
    }
    // Counted here as well as in the sweep: a room read between its expiry
    // instant and the next pass dies on this path instead, and leaving it out
    // would make reclamations look like they trail room creations forever.
    //
    // Only the effect whose delete actually removed the record counts it. Lazy
    // readers now share one effect below, but the reaper's sweep can still race
    // it; counting an `already_deleted` arrival would meter one room twice,
    // which is the exact defect this counter exists to remove (#254 review).
    if (outcome === "deleted") {
      options.metricsCollector?.recordRoomsExpiredDeleted(1);
    }
    // Same helper as the reaper: it refuses to tear down a code that has
    // already been recycled, and queues a failed teardown for retry.
    await collectRuntimeStateForDeletedRooms([], [code], "request");
    return outcome;
  }

  function getOrStartExpiredRoomCollection(
    code: string,
  ): Promise<RoomDeleteOutcome> {
    const existing = expiredRoomCollectionEffects.get(code);
    if (existing) {
      return existing;
    }

    // One real, shutdown-tracked delete effect per room code while its guarded
    // outcome is still unknown. Retries cap only their waits on this promise;
    // they must add neither another tracked wrapper nor another Redis delete.
    const effect = roomDeleteConfirmationPacer.trackCall(
      collectExpiredRoom(code),
    );
    expiredRoomCollectionEffects.set(code, effect);
    void effect.then(
      () => {
        if (expiredRoomCollectionEffects.get(code) === effect) {
          expiredRoomCollectionEffects.delete(code);
        }
      },
      () => {
        if (expiredRoomCollectionEffects.get(code) === effect) {
          expiredRoomCollectionEffects.delete(code);
        }
      },
    );
    return effect;
  }

  /**
   * Builds the unconfirmed-resolution error AND records it, in one place.
   *
   * The wire answer is `internal_error` for every trigger, so this log line is
   * the only thing that can tell an expected retryable timing apart from an
   * ordinary internal failure. Logging at each throw site instead left two of
   * the three triggers silent, which is how the diagnosis this error exists to
   * carry never reached anyone (#277 review).
   */
  function unconfirmedRoomResolution(
    code: string,
    trigger: RoomExpiryResolutionUnconfirmedTrigger,
    timeoutMs?: number,
  ): RoomExpiryResolutionUnconfirmedError {
    logEvent("room_expiry_delete_unconfirmed", {
      roomCode: code,
      provider: persistence.provider,
      trigger,
      result: "unconfirmed",
      confirmation: "unconfirmed",
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return new RoomExpiryResolutionUnconfirmedError(code, trigger, timeoutMs);
  }

  async function resolveRoom(code: string): Promise<PersistedRoom | null> {
    const room = await roomStore.getRoom(code);
    if (!room) {
      return null;
    }
    if (room.expiresAt !== null && room.expiresAt <= now()) {
      // `close()` may have run while the room read above was in flight. Do not
      // admit a new lazy-delete effect after its shutdown snapshot, but do not
      // call the room absent either: another node may already have revived the
      // stale snapshot. The caller keeps its session and may retry elsewhere.
      if (closing) {
        throw unconfirmedRoomResolution(code, "service_closing");
      }
      // The wait may end while the effect does not: it still holds the delete
      // and everything a successful one owes, and its final result can still be
      // `superseded`, so this reader fails retryably instead of claiming
      // confirmed absence.
      const outcome = await roomDeleteConfirmationPacer.capWait(
        getOrStartExpiredRoomCollection(code),
        roomDeleteConfirmationTimeoutMs,
        () =>
          unconfirmedRoomResolution(
            code,
            "delete_timeout",
            roomDeleteConfirmationTimeoutMs,
          ),
      );
      if (outcome === "superseded") {
        // The code no longer carries the expired record this read decided
        // against: an update cleared its expiry, or a different room took the
        // code. Answered from a fresh read rather than from the snapshot that is
        // now known to be stale. A room that reads as expired AGAIN remains an
        // unconfirmed resolution instead of looping back into another delete.
        const fresh = await roomStore.getRoom(code);
        if (!fresh) {
          return null;
        }
        if (fresh.expiresAt !== null && fresh.expiresAt <= now()) {
          // The guard declined the old delete, but this later snapshot has now
          // expired too. No delete has confirmed this room absent; let the
          // caller retry rather than collapsing a still-present record to null.
          throw unconfirmedRoomResolution(
            code,
            "still_expired_after_superseded",
          );
        }
        return fresh;
      }
      return null;
    }
    return room;
  }

  async function closeRoomService(): Promise<void> {
    const deadline = performance.now() + closeBudgetMs;
    const remainingBudgetMs = (): number =>
      Math.max(deadline - performance.now(), 0);

    // Drain the outer delete chain first. A delete that settles here may start
    // a runtime teardown only after its Redis outcome arrives, so taking both
    // pacer snapshots together would let that nested effect escape shutdown.
    await roomDeleteConfirmationPacer.settleTracked(remainingBudgetMs());
    const remaining = remainingBudgetMs();
    if (remaining > 0) {
      await runtimeTeardownConfirmationPacer.settleTracked(remaining);
    }

    const pendingRoomDeletions = roomDeleteConfirmationPacer.trackedCount();
    // The debt ledger is the source of truth, not the request confirmation
    // pacer. A fast rejection or guarded skip leaves no tracked request, but its
    // ownerless ledger entry is still the only trail to runtime state whose
    // persisted room has already gone.
    const pendingRuntimeTeardownCount = pendingRuntimeTeardowns.size;
    if (pendingRoomDeletions > 0 || pendingRuntimeTeardownCount > 0) {
      logEvent("room_service_close_unfinished", {
        provider: persistence.provider,
        pendingRoomDeletions,
        pendingRuntimeTeardowns: pendingRuntimeTeardownCount,
        budgetMs: closeBudgetMs,
        result: "timeout",
      });
    }
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
    close() {
      if (!closePromise) {
        // Close lazy-delete admission before the drain takes its first snapshot.
        closing = true;
        closePromise = closeRoomService();
      }
      return closePromise;
    },
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
      await collectRuntimeStateForDeletedRooms(
        pendingRuntimeTeardowns,
        [code],
        "request",
      );
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
      // When it does not land the persisted room has to go with it: it would
      // otherwise sit there with no members and no `expiresAt`, which the
      // reaper never collects, holding its code and counting towards room
      // totals forever (#237 review).
      //
      // The stamp is capped now (#277), so "did not land" also covers a write
      // that is merely still out there. That case converges without help: the
      // rolled-back room is reaped, and the teardown reads the generation when
      // it runs — finding this late stamp and deleting under it, or finding the
      // older value and leaving a tombstone the late stamp then declines
      // against. Neither outcome can reach a room this code goes on to serve.
      const persistedRoom = room;
      const rollbackUnstampedRoom = async (
        reason: string,
        error?: unknown,
      ): Promise<never> => {
        // CAS on the version we just created, not a delete by code. Between the
        // failure and this line an admin can expire the (still memberless) room
        // and another request can take the code — deleting by code would then
        // remove the replacement out from under its owner, who had already been
        // told the creation succeeded (#237 review).
        //
        // Expiring rather than deleting: `updateRoom` is the only conditional
        // primitive the store has, and a room marked expired is collected by the
        // reaper and can never be mistaken for a live one.
        //
        // What the rollback prevents is a PERMANENT orphan: a room with no
        // members and no `expiresAt` is exactly what the reaper never collects,
        // so failing to write it holds the code and the room total until an
        // operator intervenes. Until #277 only a Redis error could reach this
        // path and the failure was swallowed; capping the stamp makes it
        // reachable by a timeout and by a lost code too, so what the rollback
        // could not do is now said out loud.
        //
        // A conflict is not by itself evidence that there is nothing to
        // collect. It only says the record moved since we created it — which is
        // true both when the code changed hands (nothing of ours survives) and
        // when an admin merely touched OUR still-memberless room (the orphan is
        // still there). The two are told apart by re-reading, never assumed.
        let rollbackResidue: string | null = null;
        try {
          let expectedVersion = persistedRoom.version;
          // Attempts against a live conflict, not a retry schedule: a losing
          // CAS re-reads to the current version immediately, and only a
          // concurrent writer on this same record can make it lose again.
          for (let attempt = 0; ; attempt += 1) {
            const rollback = await roomStore.updateRoom(
              persistedRoom.code,
              expectedVersion,
              { expiresAt: now() },
            );
            if (rollback.ok || rollback.reason === "not_found") {
              break;
            }
            // Re-read on EVERY conflict, the last one included: giving up is a
            // report, and a report about a room that has since been replaced is
            // a false alarm. A different room under this code owes us nothing,
            // and one that is already expired is already collectable.
            const current = await roomStore.getRoom(persistedRoom.code);
            if (
              !current ||
              current.joinToken !== persistedRoom.joinToken ||
              current.expiresAt !== null
            ) {
              break;
            }
            if (attempt + 1 >= ROOM_ROLLBACK_MAX_ATTEMPTS) {
              rollbackResidue = "version_conflict";
              break;
            }
            expectedVersion = current.version;
          }
        } catch (rollbackError) {
          rollbackResidue =
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError);
        }
        if (rollbackResidue !== null) {
          logEvent(
            "room_rollback_failed",
            {
              sessionId: session.id,
              roomCode: persistedRoom.code,
              provider: persistence.provider,
              result: "error",
              reason,
              error: rollbackResidue,
            },
            { level: "error" },
          );
        }
        logEvent("room_persist_failed", {
          sessionId: session.id,
          roomCode: persistedRoom.code,
          provider: persistence.provider,
          result: "error",
          reason,
          ...(error === undefined
            ? {}
            : {
                error: error instanceof Error ? error.message : String(error),
              }),
        });
        throw new RoomServiceError(
          "internal_error",
          INTERNAL_SERVER_ERROR_MESSAGE,
          "internal_error",
        );
      };
      let stamped = false;
      try {
        // Pinned immediately before the stamp, and by THIS request: the stamp
        // is conditional on it, so a stamp that lands after we stopped waiting
        // is a no-op rather than an overwrite of the next occupant's generation
        // (#277). Re-reading the pin inside the store would reopen exactly that
        // hole — a read answered late would pin the successor's value and the
        // guard would wave the stale stamp through.
        const pinnedGeneration = await runtimeStore.getRoomGeneration(
          persistedRoom.code,
        );
        stamped = await runtimeStore.markRoomGeneration(
          persistedRoom.code,
          randomUUID(),
          pinnedGeneration,
        );
      } catch (error) {
        await rollbackUnstampedRoom("room_generation_mark_failed", error);
      }
      if (!stamped) {
        // The pin no longer held: a teardown owed for the previous occupant
        // tombstoned the key, or the code changed hands. Either way this room
        // instance was never stamped, so it must not go live.
        await rollbackUnstampedRoom("room_generation_superseded");
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
          //
          // Swallowed: we are already unwinding a failed join and about to
          // rethrow its error.
          await runtimeStore.flush?.().catch(() => undefined);

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
            await runtimeStore.flush?.().catch(() => undefined);
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
      const shareDedupToken = randomUUID();
      if (
        !(await runtimeStore.tryClaimMessageSlot(
          access.persistedRoom.code,
          shareDedupKey,
          shareDedupToken,
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
        await releaseMessageSlotBestEffort(
          access.persistedRoom.code,
          shareDedupKey,
          shareDedupToken,
          "share",
        );
        throw error;
      }

      if (!room) {
        await releaseMessageSlotBestEffort(
          access.persistedRoom.code,
          shareDedupKey,
          shareDedupToken,
          "share",
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
      const playbackDedupToken = randomUUID();
      const playbackCurrentTime = now();
      if (
        !(await runtimeStore.tryClaimMessageSlot(
          access.persistedRoom.code,
          playbackDedupKey,
          playbackDedupToken,
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
        await releaseMessageSlotBestEffort(
          access.persistedRoom.code,
          playbackDedupKey,
          playbackDedupToken,
          "playback",
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
        await releaseMessageSlotBestEffort(
          access.persistedRoom.code,
          playbackDedupKey,
          playbackDedupToken,
          "playback",
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
        await releaseMessageSlotBestEffort(
          access.persistedRoom.code,
          playbackDedupKey,
          playbackDedupToken,
          "playback",
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
        await releaseMessageSlotBestEffort(
          access.persistedRoom.code,
          playbackDedupKey,
          playbackDedupToken,
          "playback",
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
      // Authentication and room resolution are one snapshot. Resolving again
      // opens a second confirmed-absence branch that bypasses the session
      // cleanup owned by `requireJoinedRoomSession`; it can also return a state
      // assembled from two different room lifetimes. A later request observes
      // any deletion through the same authoritative entry point.
      const persistedRoom = access.persistedRoom;
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
      const swept = await roomStore.deleteExpiredRooms(currentTime);
      // Only rooms this pass actually deleted. NOT the orphaned index entries
      // beside them — those never had a room behind them, so metering them
      // would put this counter back out of step with room creations, which is
      // the whole reason it exists (#254 review). NOT the backlog below either:
      // that is runtime cleanup owed for rooms whose record died in an earlier
      // pass, and counting it would meter the same room twice.
      options.metricsCollector?.recordRoomsExpiredDeleted(
        swept.deletedRoomCodes.length,
      );
      // Teardown, unlike the metric, owes both categories the same thing — an
      // orphaned code still has runtime state under it and still cannot be
      // handed out again until that state is gone (#237 review). Retries ride
      // along first: the reaper is the only path that reaches a room nobody
      // touches again, so it is also the only chance to collect the runtime
      // state that outlives it (member tokens survive a disconnect on purpose,
      // #234), and once the persisted room is gone nothing will ever name that
      // code again.
      const settledCodes = await collectRuntimeStateForDeletedRooms(
        pendingRuntimeTeardowns,
        [...swept.deletedRoomCodes, ...swept.orphanedIndexCodes],
        "maintenance_pass",
      );
      const settledClaims = (swept.orphanedIndexClaims ?? []).filter(
        ({ code }) => settledCodes.has(code),
      );
      if (
        settledClaims.length > 0 &&
        roomStore.acknowledgeOrphanedIndexClaims
      ) {
        try {
          // The shared claim is the crash-recovery trail. Remove it only after
          // the guarded runtime delete above has settled; a token comparison in
          // the room store keeps this late acknowledgement from consuming a
          // newer orphan occurrence under a recycled code (#258 review).
          await roomStore.acknowledgeOrphanedIndexClaims(settledClaims);
        } catch (error) {
          // Runtime cleanup already landed. Rejecting now would overwrite that
          // real result, while leaving the shared claim is safe and lets any
          // later room-node sweep retry the idempotent teardown.
          logEvent("room_persist_failed", {
            provider: persistence.provider,
            result: "error",
            reason: "orphan_runtime_cleanup_ack_failed",
            claimCount: settledClaims.length,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return {
        deletedRooms: swept.deletedRoomCodes.length,
        orphanedIndexEntries: swept.orphanedIndexCodes.length,
      };
    },
  };
}
