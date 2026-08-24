import { randomUUID } from "node:crypto";
import {
  DEFAULT_ADMIN_COMMAND_MAX_ACTIVE_REQUESTS,
  type AdminCommandBus,
  type AdminCommandResult,
} from "../admin-command-bus.js";
import type { GlobalAuditStore } from "./global-audit-store.js";
import type { AdminSession } from "./types.js";
import {
  MEMBER_NOT_FOUND_MESSAGE,
  ROOM_ACTIVE_MESSAGE,
  ROOM_NOT_FOUND_MESSAGE,
  ROOM_VERSION_CONFLICT_MESSAGE,
  SESSION_NOT_FOUND_MESSAGE,
} from "../messages.js";
import type { LogEvent, PersistedRoom } from "../types.js";
import type {
  RoomDeleteOutcome,
  RoomStore,
  RoomUpdateResult,
} from "../room-store.js";
import type { RuntimeStore } from "../runtime-store.js";
import { createConcurrencyLimiter } from "../concurrency-limiter.js";
import { createRetryPacer } from "../retry-pacer.js";

/** Leave half the bus's reply capacity for concurrent single-admin actions. */
export const ADMIN_COMMAND_FANOUT_CONCURRENCY = Math.max(
  1,
  Math.floor(DEFAULT_ADMIN_COMMAND_MAX_ACTIVE_REQUESTS / 2),
);

export class AdminActionError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Default deadline for an admin action's wait on its room deletion. */
export const DEFAULT_ROOM_DELETE_CONFIRM_TIMEOUT_MS = 5_000;

/**
 * Default deadline for an admin action's wait on clearing a room's video.
 *
 * Its own constant, not the deletion's: a deadline is derived from what ITS
 * caller can promise, and two behaviours are two constants even when the number
 * happens to match today (#271).
 */
export const DEFAULT_ROOM_VIDEO_CLEAR_CONFIRM_TIMEOUT_MS = 5_000;

/** Leaves shutdown-step time for reporting after draining deletion effects. */
export const DEFAULT_ADMIN_ACTION_SERVICE_CLOSE_BUDGET_MS = 4_000;

type RoomDeletionAction = "close_room" | "expire_room";

class RoomVideoClearUnconfirmedError extends Error {
  constructor() {
    super(
      "Clearing the room video did not confirm before the deadline; its real effect is still tracked.",
    );
  }
}

class RoomDeletionUnconfirmedError extends Error {
  constructor(readonly timeoutMs: number) {
    super(
      `Room deletion did not confirm within ${timeoutMs}ms; its real effect is still tracked.`,
    );
  }
}

export function createAdminActionService(options: {
  instanceId: string;
  roomStore: RoomStore;
  runtimeStore: Pick<RuntimeStore, "listSessionsByRoom" | "getSession">;
  /**
   * Tears down a deleted room's runtime state, guarded and retried.
   *
   * Not `runtimeStore.deleteRoom`: both paths below delete the persisted room
   * first and irrecoverably, so a teardown that fails has no way back — the code
   * would never reach the reaper again. The room service owns the retry ledger
   * and the generation check, so it has to be the one entry point (#237 review).
   */
  teardownRoomRuntime: (roomCode: string) => Promise<void>;
  listClusterSessions: () => Promise<
    Awaited<ReturnType<RuntimeStore["listClusterSessions"]>>
  >;
  listClusterSessionsByRoom: (
    roomCode: string,
  ) => Promise<Awaited<ReturnType<RuntimeStore["listClusterSessionsByRoom"]>>>;
  requestAdminCommand: AdminCommandBus["request"];
  auditLogService: GlobalAuditStore;
  getRoomStateByCode: (roomCode: string) => Promise<unknown | null>;
  publishRoomStateUpdate: (roomCode: string) => Promise<void>;
  publishRoomDeleted: (roomCode: string) => Promise<void>;
  logEvent: LogEvent;
  now?: () => number;
  /** Shared across every close-room fan-out owned by this service instance. */
  maxFanoutConcurrency?: number;
  /**
   * How long an admin action waits for its room deletion to confirm.
   *
   * A behaviour deadline of this action, not the store's liveness backstop: the
   * effect it caps keeps running, and its follow-ups belong to that effect
   * (#277).
   */
  roomDeleteConfirmTimeoutMs?: number;
  roomVideoClearConfirmTimeoutMs?: number;
  /** How long shutdown waits for deletion effects that outlived requests. */
  closeBudgetMs?: number;
}) {
  const now = options.now ?? Date.now;
  const fanoutLimiter = createConcurrencyLimiter(
    options.maxFanoutConcurrency ?? ADMIN_COMMAND_FANOUT_CONCURRENCY,
  );

  async function getRoomOrThrow(roomCode: string): Promise<PersistedRoom> {
    const room = await options.roomStore.getRoom(roomCode);
    if (!room) {
      throw new AdminActionError(404, "room_not_found", ROOM_NOT_FOUND_MESSAGE);
    }
    return room;
  }

  async function updateRoomWithRetry(
    roomCode: string,
    action: (room: PersistedRoom) => Promise<RoomUpdateResult>,
  ): Promise<PersistedRoom> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const room = await getRoomOrThrow(roomCode);
      const result = await action(room);
      if (result.ok) {
        return result.room;
      }
      if (result.reason === "not_found") {
        throw new AdminActionError(
          404,
          "room_not_found",
          ROOM_NOT_FOUND_MESSAGE,
        );
      }
    }
    throw new AdminActionError(
      409,
      "room_version_conflict",
      ROOM_VERSION_CONFLICT_MESSAGE,
    );
  }

  const roomDeleteConfirmTimeoutMs =
    options.roomDeleteConfirmTimeoutMs ??
    DEFAULT_ROOM_DELETE_CONFIRM_TIMEOUT_MS;
  const roomVideoClearConfirmTimeoutMs =
    options.roomVideoClearConfirmTimeoutMs ??
    DEFAULT_ROOM_VIDEO_CLEAR_CONFIRM_TIMEOUT_MS;
  const roomVideoClearPacer = createRetryPacer({
    initialDelayMs: roomVideoClearConfirmTimeoutMs,
    maxDelayMs: roomVideoClearConfirmTimeoutMs,
  });
  const roomDeletionPacer = createRetryPacer({
    initialDelayMs: roomDeleteConfirmTimeoutMs,
    maxDelayMs: roomDeleteConfirmTimeoutMs,
  });
  const closeBudgetMs =
    options.closeBudgetMs ?? DEFAULT_ADMIN_ACTION_SERVICE_CLOSE_BUDGET_MS;
  const roomDeletionHandlerPacer = createRetryPacer({
    initialDelayMs: closeBudgetMs,
    maxDelayMs: closeBudgetMs,
  });
  let closing = false;
  let closePromise: Promise<void> | null = null;

  async function closeActionService(): Promise<void> {
    const deadline = performance.now() + closeBudgetMs;
    const remainingBudgetMs = (): number =>
      Math.max(deadline - performance.now(), 0);

    // An accepted action can still be in its room read or disconnect fan-out
    // and create a deletion only afterwards. Drain handlers first, then take a
    // fresh deletion snapshot so that late-created effect stays in this same
    // lifecycle boundary.
    await roomDeletionHandlerPacer.settleTracked(remainingBudgetMs());
    const remaining = remainingBudgetMs();
    if (remaining > 0) {
      await roomDeletionPacer.settleTracked(remaining);
    }
    const pendingHandlers = roomDeletionHandlerPacer.trackedCount();
    const remainingForVideoClears = remainingBudgetMs();
    if (remainingForVideoClears > 0) {
      await roomVideoClearPacer.settleTracked(remainingForVideoClears);
    }

    const pendingRoomDeletions = roomDeletionPacer.trackedCount();
    const pendingRoomVideoClears = roomVideoClearPacer.trackedCount();
    if (
      pendingHandlers > 0 ||
      pendingRoomDeletions > 0 ||
      pendingRoomVideoClears > 0
    ) {
      options.logEvent("admin_action_service_close_unfinished", {
        instanceId: options.instanceId,
        pendingHandlers,
        pendingRoomDeletions,
        pendingRoomVideoClears,
        budgetMs: closeBudgetMs,
        result: "timeout",
      });
    }
  }

  function runRoomDeletionAction<T>(action: () => Promise<T>): Promise<T> {
    if (closing) {
      return Promise.reject(
        new AdminActionError(
          503,
          "admin_action_service_closed",
          "Admin action service is shutting down.",
        ),
      );
    }
    return roomDeletionHandlerPacer.trackCall(action());
  }

  function writeAudit(
    actor: AdminSession,
    action: string,
    targetType: "room" | "session" | "member",
    targetId: string,
    request: Record<string, unknown>,
    result: "ok" | "rejected" | "error",
    reason?: string,
    commandDetails?: {
      targetInstanceId?: string;
      commandResult?: AdminCommandResult;
    },
  ): void {
    // .then() defers the append call so a synchronous throw is routed to
    // .catch() instead of escaping into the admin action call site.
    void Promise.resolve()
      .then(() =>
        options.auditLogService.append({
          actor,
          action,
          targetType,
          targetId,
          request,
          result,
          reason,
          instanceId: options.instanceId,
          targetInstanceId: commandDetails?.targetInstanceId,
          executorInstanceId: commandDetails?.commandResult?.executorInstanceId,
          commandRequestId: commandDetails?.commandResult?.requestId,
          commandStatus: commandDetails?.commandResult?.status,
          commandConfirmation:
            commandDetails?.commandResult?.status === "ok"
              ? undefined
              : commandDetails?.commandResult?.confirmation,
          commandCode:
            commandDetails?.commandResult?.status === "ok"
              ? undefined
              : commandDetails?.commandResult?.code,
        }),
      )
      .catch((error: unknown) => {
        options.logEvent("admin_audit_log_append_failed", {
          actor: actor.username,
          action,
          targetType,
          targetId,
          result: "error",
          instanceId: options.instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function throwCommandFailure(
    result: Exclude<AdminCommandResult, { status: "ok" }>,
  ): never {
    const statusCode = commandFailureStatusCode(result);
    throw new AdminActionError(statusCode, result.code, result.message);
  }

  function commandFailureStatusCode(
    result: Exclude<AdminCommandResult, { status: "ok" }>,
  ): number {
    if (result.status === "not_found") {
      return 404;
    }
    if (result.status === "stale_target") {
      return 409;
    }
    if (result.confirmation === "unconfirmed") {
      return 409;
    }
    // An executor error is a bad upstream result; failure to reach the command
    // bus is this service's Redis dependency being unavailable and is retryable.
    return result.code === "command_bus_unavailable" ? 503 : 502;
  }

  function recordUnconfirmedCommand(
    actor: AdminSession,
    action: "kick_member" | "disconnect_session",
    targetType: "member" | "session",
    targetId: string,
    request: Record<string, unknown>,
    targetInstanceId: string,
    commandResult: Exclude<AdminCommandResult, { status: "ok" }> & {
      confirmation: "unconfirmed";
    },
  ): void {
    options.logEvent("admin_command_unconfirmed", {
      commandType: action,
      targetType,
      targetId,
      targetInstanceId,
      executorInstanceId: commandResult.executorInstanceId,
      commandRequestId: commandResult.requestId,
      result: "rejected",
      confirmation: "unconfirmed",
      actor: actor.username,
    });
    writeAudit(
      actor,
      action,
      targetType,
      targetId,
      request,
      "rejected",
      commandResult.code,
      { targetInstanceId, commandResult },
    );
  }

  /**
   * One effect: the guarded delete AND everything a successful one owes.
   *
   * The follow-ups are inside the chain, not after the await, because this
   * action may stop waiting. The cap below answers it without cancelling the
   * command, so a delete that lands afterwards would otherwise skip the runtime
   * teardown and the `room_deleted` broadcast entirely — and each of them would
   * then need its own compensation bolted onto the failure path (#277 review).
   * Both are addressed BY CODE, which is why `superseded` runs neither: the
   * code belongs to a different room by then.
   *
   * Terminal reporting belongs to the effect, so a late outcome is still
   * visible after the caller has been answered.
   */
  function startRoomDeletion(args: {
    target: PersistedRoom;
    roomCode: string;
    actor: AdminSession;
    action: RoomDeletionAction;
    announce: boolean;
  }): { effect: Promise<RoomDeleteOutcome>; giveUpWaiting: () => void } {
    let waiterGaveUp = false;
    const effect = (async () => {
      const outcome = await options.roomStore.deleteRoom(args.target);
      if (outcome !== "superseded") {
        await options.teardownRoomRuntime(args.roomCode);
        if (args.announce) {
          await options.publishRoomDeleted(args.roomCode);
        }
      }
      return outcome;
    })().then(
      (outcome) => {
        if (waiterGaveUp) {
          options.logEvent("admin_room_delete_late_completed", {
            roomCode: args.roomCode,
            action: args.action,
            outcome,
            result: "ok",
            actor: args.actor.username,
          });
        }
        return outcome;
      },
      (error: unknown) => {
        if (waiterGaveUp) {
          options.logEvent("admin_room_delete_late_failed", {
            roomCode: args.roomCode,
            action: args.action,
            result: "error",
            actor: args.actor.username,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      },
    );
    return {
      effect,
      giveUpWaiting: () => {
        waiterGaveUp = true;
      },
    };
  }

  /**
   * Waits for one room deletion, bounded, and reports what it could not learn.
   *
   * An unconfirmed deletion is NOT reported as a completed action: the record
   * may still be there. The effect keeps running either way, so its follow-ups
   * are owed to it and not to this waiter.
   */
  async function confirmRoomDeletion(args: {
    target: PersistedRoom;
    roomCode: string;
    actor: AdminSession;
    action: RoomDeletionAction;
    announce: boolean;
  }): Promise<RoomDeleteOutcome> {
    const started = startRoomDeletion(args);
    try {
      return await roomDeletionPacer.capAttempt(
        started.effect,
        roomDeleteConfirmTimeoutMs,
        () => {
          started.giveUpWaiting();
          return new RoomDeletionUnconfirmedError(roomDeleteConfirmTimeoutMs);
        },
      );
    } catch (error) {
      if (!(error instanceof RoomDeletionUnconfirmedError)) {
        throw error;
      }
      options.logEvent("admin_room_delete_unconfirmed", {
        roomCode: args.roomCode,
        action: args.action,
        result: "timeout",
        confirmation: "unconfirmed",
        actor: args.actor.username,
      });
      writeAudit(
        args.actor,
        args.action,
        "room",
        args.roomCode,
        { confirmation: "unconfirmed" },
        "rejected",
        "room_delete_unconfirmed",
      );
      throw new AdminActionError(
        503,
        "room_delete_unconfirmed",
        "Room deletion was not confirmed before the deadline.",
        { roomCode: args.roomCode },
      );
    }
  }

  const actions = {
    async closeRoom(actor: AdminSession, roomCode: string, reason?: string) {
      const target = await getRoomOrThrow(roomCode);
      const sessions = await options.listClusterSessionsByRoom(roomCode);
      const disconnectResults = await Promise.all(
        sessions.map((session) =>
          fanoutLimiter.run(async () => {
            const targetInstanceId = session.instanceId ?? options.instanceId;
            const result = await options.requestAdminCommand({
              kind: "disconnect_session",
              requestId: `close-room:${roomCode}:${session.id}:${randomUUID()}`,
              targetInstanceId,
              sessionId: session.id,
              reason,
              requestedAt: now(),
            });
            return { session, targetInstanceId, result };
          }),
        ),
      );
      const failedCommands = disconnectResults.filter(
        (
          entry,
        ): entry is {
          session: (typeof disconnectResults)[number]["session"];
          targetInstanceId: string;
          result: Exclude<AdminCommandResult, { status: "ok" }>;
        } => entry.result.status !== "ok",
      );
      if (failedCommands.length > 0) {
        const commandFailureCount = failedCommands.length;
        const failureCodes = Array.from(
          new Set(failedCommands.map(({ result }) => result.code)),
        ).sort();
        const failedSessions = failedCommands.map(
          ({ session, result, targetInstanceId }) => ({
            sessionId: session.id,
            roomCode: session.roomCode,
            memberId: session.memberId,
            targetInstanceId,
            commandStatus: result.status,
            commandConfirmation: result.confirmation,
            commandCode: result.code,
            message: result.message,
          }),
        );

        options.logEvent("admin_room_close_rejected", {
          roomCode,
          sessionCount: sessions.length,
          disconnectedSessionCount: sessions.length - commandFailureCount,
          commandFailureCount,
          failureCodes,
          result: "rejected",
          actor: actor.username,
        });
        writeAudit(
          actor,
          "close_room",
          "room",
          roomCode,
          {
            reason,
            commandFailureCount,
            failureCodes,
            failedSessions,
          },
          "rejected",
          "command_failed",
        );
        const representativeFailure =
          failedCommands.find(
            ({ result }) => commandFailureStatusCode(result) === 503,
          ) ??
          failedCommands.find(({ result }) => result.status === "error") ??
          failedCommands.find(({ result }) => result.status === "not_found") ??
          failedCommands[0]!;
        throw new AdminActionError(
          commandFailureStatusCode(representativeFailure.result),
          representativeFailure.result.code,
          "Failed to close room because one or more member sessions could not be disconnected.",
          {
            roomCode,
            commandFailureCount,
            failedSessions,
          },
        );
      }

      // The delete names the room this action read, so a code that changed
      // hands while its members were being disconnected is left alone. Both
      // steps after it are addressed BY CODE, so running them on a superseded
      // delete would tear down and evict the room that holds the code now.
      //
      // Two by-code windows this guard does NOT close, both older than it and
      // neither expressible without an instance identity on the wire: the
      // disconnect fan-out above enumerates sessions by code, so a code that
      // changed hands before it ran disconnects the successor's members and no
      // later verdict can undo that; and `publishRoomDeleted` names a code, so
      // a successful delete followed by an immediate reuse can show the new
      // room's members one empty `room:state` until the next room event
      // corrects them.
      //
      // `teardownRoomRuntime` is NOT one of them, though it is addressed by
      // code too: it skips outright when a persisted room exists under that
      // code, and its delete is guarded by a generation pinned before that
      // check and confirmed after it (#237, #277). A reused code therefore
      // either shows a live room or fails the generation guard.
      const deletion = await confirmRoomDeletion({
        target,
        roomCode,
        actor,
        action: "close_room",
        announce: true,
      });
      if (deletion === "superseded") {
        options.logEvent("admin_room_close_superseded", {
          roomCode,
          sessionCount: sessions.length,
          result: "ok",
          actor: actor.username,
        });
      }
      const disconnectedSessionCount = disconnectResults.filter(
        ({ result }) => result.status === "ok",
      ).length;

      options.logEvent("admin_room_closed", {
        roomCode,
        sessionCount: sessions.length,
        disconnectedSessionCount,
        commandFailureCount: 0,
        result: "ok",
        actor: actor.username,
      });
      writeAudit(actor, "close_room", "room", roomCode, { reason }, "ok");
      return {
        roomCode,
        disconnectedSessionCount,
      };
    },

    async expireRoom(actor: AdminSession, roomCode: string, reason?: string) {
      // The instance is pinned BEFORE the emptiness check, not after. Both are
      // addressed by code, so reading afterwards let the two describe different
      // rooms: a code that changed hands in between produced an "empty" verdict
      // about the room that is gone and a guarded delete of the one that
      // replaced it — which its members were already in.
      const target = await getRoomOrThrow(roomCode);
      const sessions = await options.listClusterSessionsByRoom(roomCode);
      if (sessions.length > 0) {
        throw new AdminActionError(409, "room_active", ROOM_ACTIVE_MESSAGE);
      }

      const deletion = await confirmRoomDeletion({
        target,
        roomCode,
        actor,
        action: "expire_room",
        announce: false,
      });
      // The teardown `closeRoom` also owes rides inside the effect above: without
      // it an expired room left its runtime keys behind — including the tokens
      // of members who had disconnected but whose identity is deliberately
      // retained (#234) — and a recycled room code would inherit them (#237
      // review).
      if (deletion === "superseded") {
        options.logEvent("admin_room_expire_superseded", {
          roomCode,
          result: "ok",
          actor: actor.username,
        });
      }

      options.logEvent("admin_room_expired", {
        roomCode,
        activeSessionCount: 0,
        result: "ok",
        actor: actor.username,
      });
      writeAudit(actor, "expire_room", "room", roomCode, { reason }, "ok");
      return {
        roomCode,
        activeSessionCount: 0,
      };
    },

    async clearRoomVideo(
      actor: AdminSession,
      roomCode: string,
      reason?: string,
    ) {
      // Two lifetimes, like the room deletion above. This action's SUCCESS owes
      // two things nobody else repeats — the audit record AND the
      // `room_state_updated` broadcast — so its write is not one whose outcome
      // may be discarded: a cleared video that nobody was told about leaves
      // every connected client showing and syncing the old one until some
      // unrelated broadcast happens (#277 review). The write therefore NAMES
      // this deadline and keeps running past it, and the effect owns both
      // follow-ups.
      let waiterGaveUp = false;
      const effect = (async () => {
        await updateRoomWithRetry(
          roomCode,
          async (room) =>
            await options.roomStore.updateRoom(
              room.code,
              room.version,
              {
                sharedVideo: null,
                playback: null,
                expiresAt: null,
                lastActiveAt: now(),
              },
              {
                boundedBy:
                  "admin action service: room video clear confirmation deadline (the request stops waiting; this effect does not)",
              },
            ),
        );
        await options.publishRoomStateUpdate(roomCode);
      })().then(
        () => {
          if (waiterGaveUp) {
            options.logEvent("admin_room_video_clear_late_completed", {
              roomCode,
              result: "ok",
              actor: actor.username,
            });
          }
        },
        (error: unknown) => {
          if (waiterGaveUp) {
            options.logEvent("admin_room_video_clear_late_failed", {
              roomCode,
              result: "error",
              actor: actor.username,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        },
      );

      try {
        await roomVideoClearPacer.capAttempt(
          effect,
          roomVideoClearConfirmTimeoutMs,
          () => {
            waiterGaveUp = true;
            return new RoomVideoClearUnconfirmedError();
          },
        );
      } catch (error) {
        if (!(error instanceof RoomVideoClearUnconfirmedError)) {
          throw error;
        }
        // An unconfirmed action is NOT a completed one — the clear may yet
        // land, and the effect above still owes it the broadcast. Never
        // audited as `ok`, but audited: an accountability record owes the
        // attempt and its outcome, and "unknown" is an outcome (#267).
        options.logEvent("admin_room_video_clear_unconfirmed", {
          roomCode,
          result: "timeout",
          confirmation: "unconfirmed",
          actor: actor.username,
        });
        writeAudit(
          actor,
          "clear_room_video",
          "room",
          roomCode,
          { reason, confirmation: "unconfirmed" },
          "rejected",
          "room_video_clear_unconfirmed",
        );
        throw new AdminActionError(
          503,
          "room_video_clear_unconfirmed",
          "Clearing the room's video was not confirmed before the deadline.",
          { roomCode },
        );
      }

      options.logEvent("admin_room_video_cleared", {
        roomCode,
        result: "ok",
        actor: actor.username,
      });
      writeAudit(actor, "clear_room_video", "room", roomCode, { reason }, "ok");
      return {
        roomCode,
        roomState: await options.getRoomStateByCode(roomCode),
      };
    },

    async kickMember(
      actor: AdminSession,
      roomCode: string,
      memberId: string,
      reason?: string,
    ) {
      await getRoomOrThrow(roomCode);
      const session = (await options.listClusterSessionsByRoom(roomCode)).find(
        (entry) => entry.memberId === memberId,
      );
      if (!session) {
        throw new AdminActionError(
          404,
          "member_not_found",
          MEMBER_NOT_FOUND_MESSAGE,
        );
      }

      const targetInstanceId = session.instanceId ?? options.instanceId;
      const commandResult = await options.requestAdminCommand({
        kind: "kick_member",
        requestId: `kick-member:${memberId}:${randomUUID()}`,
        targetInstanceId,
        roomCode,
        memberId,
        reason,
        requestedAt: now(),
      });
      if (commandResult.status !== "ok") {
        if (commandResult.confirmation === "unconfirmed") {
          // The result type, rather than an open-ended list of error codes,
          // carries the fact that this permission change can still land after
          // the response. The consumer has no actor identity; this layer is
          // the last place that can attach one.
          recordUnconfirmedCommand(
            actor,
            "kick_member",
            "member",
            memberId,
            { roomCode, reason },
            targetInstanceId,
            commandResult,
          );
        }
        throwCommandFailure(commandResult);
      }

      options.logEvent("admin_member_kicked", {
        roomCode,
        memberId,
        sessionId: commandResult.sessionId ?? session.id,
        result: "ok",
        actor: actor.username,
      });
      writeAudit(
        actor,
        "kick_member",
        "member",
        memberId,
        { roomCode, reason },
        "ok",
        undefined,
        { targetInstanceId, commandResult },
      );
      return {
        roomCode,
        memberId,
        sessionId: commandResult.sessionId ?? session.id,
      };
    },

    async disconnectSession(
      actor: AdminSession,
      sessionId: string,
      reason?: string,
    ) {
      const session =
        (await options.listClusterSessions()).find(
          (entry) => entry.id === sessionId,
        ) ?? options.runtimeStore.getSession(sessionId);
      if (!session) {
        throw new AdminActionError(
          404,
          "session_not_found",
          SESSION_NOT_FOUND_MESSAGE,
        );
      }
      const targetInstanceId = session.instanceId ?? options.instanceId;
      const commandResult = await options.requestAdminCommand({
        kind: "disconnect_session",
        requestId: `disconnect-session:${sessionId}:${randomUUID()}`,
        targetInstanceId,
        sessionId,
        reason,
        requestedAt: now(),
      });
      if (commandResult.status !== "ok") {
        if (commandResult.confirmation === "unconfirmed") {
          recordUnconfirmedCommand(
            actor,
            "disconnect_session",
            "session",
            sessionId,
            { reason },
            targetInstanceId,
            commandResult,
          );
        }
        throwCommandFailure(commandResult);
      }

      options.logEvent("admin_session_disconnected", {
        sessionId,
        roomCode: session.roomCode,
        result: "ok",
        actor: actor.username,
      });
      writeAudit(
        actor,
        "disconnect_session",
        "session",
        sessionId,
        { reason },
        "ok",
        undefined,
        { targetInstanceId, commandResult },
      );
      return {
        sessionId,
        roomCode: commandResult.roomCode ?? session.roomCode,
      };
    },
  };

  return {
    ...actions,
    close() {
      if (!closePromise) {
        // Close the gate before the async drain takes its first snapshot.
        closing = true;
        closePromise = closeActionService();
      }
      return closePromise;
    },
    closeRoom(actor: AdminSession, roomCode: string, reason?: string) {
      return runRoomDeletionAction(() =>
        actions.closeRoom(actor, roomCode, reason),
      );
    },
    expireRoom(actor: AdminSession, roomCode: string, reason?: string) {
      return runRoomDeletionAction(() =>
        actions.expireRoom(actor, roomCode, reason),
      );
    },
  };
}
