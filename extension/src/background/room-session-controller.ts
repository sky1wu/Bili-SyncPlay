import type {
  RoomState,
  ServerMessage,
  ClientMessage,
} from "@bili-syncplay/protocol";
import { PROTOCOL_VERSION } from "@bili-syncplay/protocol";
import type { BackgroundToContentMessage } from "../shared/messages";
import {
  decideIncomingRoomState,
  getActivePendingLocalShareUrl,
  isSharedVideoChange,
  type RoomLifecycleAction,
} from "./room-state";
import type {
  ConnectionState,
  RoomSessionState,
  ShareState,
} from "./runtime-state";
import {
  createPendingShareToast as createRoomPendingShareToast,
  getPendingShareToastFor as getRoomPendingShareToastFor,
} from "./room-manager";
import { localizeServerError } from "../shared/i18n";

type JoinAttemptResult = "joined" | "failed" | "timeout";

export interface RoomSessionController {
  sendJoinRequest(targetRoomCode: string, targetJoinToken: string): void;
  waitForJoinAttemptResult(timeoutMs?: number): Promise<JoinAttemptResult>;
  handleServerMessage(message: ServerMessage): Promise<void>;
  clearCurrentRoomContext(
    reason: string,
    errorMessage?: string | null,
  ): Promise<void>;
  requestCreateRoom(): Promise<void>;
  requestJoinRoom(roomCode: string, joinToken: string): Promise<void>;
  requestLeaveRoom(): Promise<void>;
}

export function createRoomSessionController(args: {
  connectionState: ConnectionState;
  roomSessionState: RoomSessionState;
  shareState: ShareState;
  log: (
    scope: "background" | "popup" | "content" | "server",
    message: string,
  ) => void;
  notifyAll: () => void;
  persistState: () => Promise<void>;
  sendToServer: (message: ClientMessage) => void;
  connect: () => Promise<void>;
  disconnectSocket: () => void;
  resetReconnectState: () => void;
  resetRoomLifecycleTransientState: (
    action: RoomLifecycleAction,
    reason: string,
  ) => void;
  flushPendingShare: () => void;
  ensureSharedVideoOpen: (state: RoomState) => Promise<void>;
  notifyContentScripts: (message: BackgroundToContentMessage) => Promise<void>;
  compensateRoomState: (state: RoomState) => RoomState;
  clearPendingLocalShare: (reason: string) => void;
  expirePendingLocalShareIfNeeded: () => void;
  normalizeUrl: (url: string | undefined | null) => string | null;
  logServerError: (code: string, message: string) => void;
  shareToastTtlMs: number;
}): RoomSessionController {
  let pendingJoinAttemptResolvers: Array<(result: JoinAttemptResult) => void> =
    [];

  function syncProfileAfterRoomEstablished(): void {
    if (
      !args.connectionState.connected ||
      !args.roomSessionState.memberToken ||
      !args.roomSessionState.displayName
    ) {
      return;
    }

    args.sendToServer({
      type: "profile:update",
      payload: {
        memberToken: args.roomSessionState.memberToken,
        displayName: args.roomSessionState.displayName,
      },
    });
  }

  function sendJoinRequest(
    targetRoomCode: string,
    targetJoinToken: string,
  ): void {
    args.roomSessionState.pendingJoinRequestSent = true;
    args.sendToServer({
      type: "room:join",
      payload: {
        roomCode: targetRoomCode,
        joinToken: targetJoinToken,
        ...(args.roomSessionState.memberToken
          ? { memberToken: args.roomSessionState.memberToken }
          : {}),
        displayName: args.roomSessionState.displayName ?? undefined,
        protocolVersion: PROTOCOL_VERSION,
      },
    });
  }

  function settlePendingJoinAttempt(result: JoinAttemptResult): void {
    if (pendingJoinAttemptResolvers.length === 0) {
      return;
    }

    const resolvers = pendingJoinAttemptResolvers;
    pendingJoinAttemptResolvers = [];
    for (const resolve of resolvers) {
      resolve(result);
    }
  }

  function waitForJoinAttemptResult(
    timeoutMs = 3000,
  ): Promise<JoinAttemptResult> {
    return new Promise((resolve) => {
      const timer = globalThis.setTimeout(() => {
        pendingJoinAttemptResolvers = pendingJoinAttemptResolvers.filter(
          (candidate) => candidate !== finalize,
        );
        resolve("timeout");
      }, timeoutMs);

      const finalize = (result: JoinAttemptResult) => {
        globalThis.clearTimeout(timer);
        resolve(result);
      };

      pendingJoinAttemptResolvers.push(finalize);
    });
  }

  async function handleServerMessage(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case "room:created":
        args.roomSessionState.pendingJoinRoomCode = null;
        args.roomSessionState.pendingJoinToken = null;
        args.roomSessionState.roomCode = message.payload.roomCode;
        args.roomSessionState.joinToken = message.payload.joinToken;
        args.roomSessionState.memberToken = message.payload.memberToken;
        args.roomSessionState.memberId = message.payload.memberId;
        args.connectionState.lastError = null;
        syncProfileAfterRoomEstablished();
        await args.persistState();
        args.flushPendingShare();
        args.notifyAll();
        return;
      case "room:joined":
        args.roomSessionState.roomCode = message.payload.roomCode;
        args.roomSessionState.joinToken =
          args.roomSessionState.pendingJoinToken ??
          args.roomSessionState.joinToken;
        args.roomSessionState.memberToken = message.payload.memberToken;
        args.roomSessionState.memberId = message.payload.memberId;
        args.roomSessionState.pendingJoinRequestSent = false;
        args.roomSessionState.pendingJoinRoomCode = null;
        args.roomSessionState.pendingJoinToken = null;
        args.connectionState.lastError = null;
        settlePendingJoinAttempt("joined");
        syncProfileAfterRoomEstablished();
        await args.persistState();
        args.flushPendingShare();
        args.notifyAll();
        return;
      case "room:state":
        await handleRoomStateMessage(message.payload);
        return;
      case "error":
        args.connectionState.lastError = localizeServerError(
          message.payload.code,
          message.payload.message,
        );
        if (
          args.roomSessionState.pendingJoinRoomCode &&
          (message.payload.code === "room_not_found" ||
            message.payload.code === "join_token_invalid" ||
            message.payload.code === "invalid_message" ||
            message.payload.code === "unsupported_protocol_version")
        ) {
          args.log(
            "background",
            `Join failed for room ${args.roomSessionState.pendingJoinRoomCode}`,
          );
          settlePendingJoinAttempt("failed");
          args.roomSessionState.pendingJoinRequestSent = false;
          args.roomSessionState.pendingJoinRoomCode = null;
          args.roomSessionState.pendingJoinToken = null;
          args.roomSessionState.roomCode = null;
          args.roomSessionState.joinToken = null;
          args.roomSessionState.memberToken = null;
          args.roomSessionState.memberId = null;
          args.roomSessionState.roomState = null;
          await args.persistState();
        }
        if (
          args.roomSessionState.roomCode &&
          !args.roomSessionState.pendingJoinRoomCode &&
          (message.payload.code === "room_not_found" ||
            message.payload.code === "join_token_invalid" ||
            message.payload.code === "unsupported_protocol_version")
        ) {
          await clearCurrentRoomContext(
            `server rejected stored room context: ${message.payload.code}`,
            args.connectionState.lastError,
          );
          args.logServerError(message.payload.code, message.payload.message);
          return;
        }
        if (message.payload.code === "member_token_invalid") {
          args.roomSessionState.memberToken = null;
          await args.persistState();
        }
        args.logServerError(message.payload.code, message.payload.message);
        args.notifyAll();
        return;
      case "sync:pong":
        return;
    }
  }

  async function handleRoomStateMessage(nextState: RoomState): Promise<void> {
    args.expirePendingLocalShareIfNeeded();
    const decision = decideIncomingRoomState({
      currentRoomState: args.roomSessionState.roomState,
      normalizedPendingLocalShareUrl: args.normalizeUrl(
        getActivePendingLocalShareUrl({
          pendingLocalShareUrl: args.shareState.pendingLocalShareUrl,
          pendingLocalShareExpiresAt:
            args.shareState.pendingLocalShareExpiresAt,
          now: Date.now(),
        }),
      ),
      normalizedIncomingSharedUrl: args.normalizeUrl(
        nextState.sharedVideo?.url,
      ),
    });

    if (decision.kind === "ignore-stale") {
      args.log(
        "background",
        `Ignored stale room state while waiting for ${args.shareState.pendingLocalShareUrl}; received ${nextState.sharedVideo?.url ?? "none"}`,
      );
      return;
    }

    if (isSharedVideoChange(decision.previousSharedUrl, nextState)) {
      if (!decision.confirmedPendingLocalShare) {
        args.shareState.lastOpenedSharedUrl = null;
      }
      args.log(
        "background",
        `Shared video switched to ${nextState.sharedVideo?.url ?? "none"}`,
      );
      args.shareState.pendingShareToast = createPendingShareToast(nextState);
    }

    args.roomSessionState.roomState = nextState;
    args.roomSessionState.roomCode = nextState.roomCode;
    args.connectionState.lastError = null;

    if (decision.confirmedPendingLocalShare) {
      args.log(
        "background",
        `Confirmed shared video switch to ${args.shareState.pendingLocalShareUrl}`,
      );
      args.clearPendingLocalShare("share confirmation received");
    }

    await args.persistState();
    await args.ensureSharedVideoOpen(args.roomSessionState.roomState);
    const compensatedRoomState = args.compensateRoomState(
      args.roomSessionState.roomState,
    );
    await args.notifyContentScripts({
      type: "background:apply-room-state",
      payload: compensatedRoomState,
      shareToast: getPendingShareToastFor(nextState),
    });
    args.notifyAll();
  }

  function createPendingShareToast(
    state: RoomState,
  ): NonNullable<ShareState["pendingShareToast"]> {
    return createRoomPendingShareToast({
      state,
      normalizedSharedUrl: args.normalizeUrl(state.sharedVideo?.url),
      now: Date.now(),
      ttlMs: args.shareToastTtlMs,
    });
  }

  function getPendingShareToastFor(state: RoomState) {
    const result = getRoomPendingShareToastFor({
      pendingShareToast: args.shareState.pendingShareToast,
      state,
      normalizedPendingToastUrl: args.normalizeUrl(
        args.shareState.pendingShareToast?.videoUrl,
      ),
      normalizedSharedUrl: args.normalizeUrl(state.sharedVideo?.url),
      now: Date.now(),
    });
    args.shareState.pendingShareToast = result.pendingShareToast;
    return result.shareToast;
  }

  async function clearCurrentRoomContext(
    reason: string,
    errorMessage: string | null = null,
  ): Promise<void> {
    args.log("background", `Clearing current room context (${reason})`);
    args.roomSessionState.roomCode = null;
    args.roomSessionState.joinToken = null;
    args.roomSessionState.memberToken = null;
    args.roomSessionState.memberId = null;
    args.roomSessionState.roomState = null;
    args.roomSessionState.pendingCreateRoom = false;
    args.roomSessionState.pendingJoinRoomCode = null;
    args.roomSessionState.pendingJoinToken = null;
    args.roomSessionState.pendingJoinRequestSent = false;
    args.shareState.lastOpenedSharedUrl = null;
    args.connectionState.lastError = errorMessage;
    args.resetReconnectState();
    args.resetRoomLifecycleTransientState("leave-room", reason);
    await args.persistState();
    args.notifyAll();
  }

  async function requestCreateRoom(): Promise<void> {
    args.resetReconnectState();
    args.roomSessionState.roomCode = null;
    args.roomSessionState.joinToken = null;
    args.roomSessionState.memberToken = null;
    args.roomSessionState.memberId = null;
    args.roomSessionState.roomState = null;
    args.roomSessionState.pendingJoinRoomCode = null;
    args.roomSessionState.pendingJoinToken = null;
    args.resetRoomLifecycleTransientState(
      "create-room",
      "create room requested",
    );
    args.shareState.lastOpenedSharedUrl = null;
    await args.persistState();
    await args.connect();
    if (args.connectionState.connected) {
      args.roomSessionState.pendingCreateRoom = false;
      args.sendToServer({
        type: "room:create",
        payload: {
          displayName: args.roomSessionState.displayName ?? undefined,
          protocolVersion: PROTOCOL_VERSION,
        },
      });
      return;
    }
    args.roomSessionState.pendingCreateRoom = true;
  }

  async function requestJoinRoom(
    roomCode: string,
    joinToken: string,
  ): Promise<void> {
    args.resetReconnectState();
    args.roomSessionState.pendingCreateRoom = false;
    args.roomSessionState.pendingJoinRoomCode = roomCode.trim().toUpperCase();
    args.roomSessionState.pendingJoinToken = joinToken.trim();
    args.roomSessionState.pendingJoinRequestSent = false;
    args.log(
      "background",
      `Popup requested join for ${args.roomSessionState.pendingJoinRoomCode}`,
    );
    args.roomSessionState.roomCode = null;
    args.roomSessionState.joinToken = null;
    args.roomSessionState.memberToken = null;
    args.roomSessionState.memberId = null;
    args.roomSessionState.roomState = null;
    args.resetRoomLifecycleTransientState("join-room", "join room requested");
    args.shareState.lastOpenedSharedUrl = null;
    args.connectionState.lastError = null;
    await args.persistState();
    await args.connect();
    if (
      args.connectionState.connected &&
      args.roomSessionState.pendingJoinRoomCode &&
      args.roomSessionState.pendingJoinToken &&
      !args.roomSessionState.pendingJoinRequestSent
    ) {
      sendJoinRequest(
        args.roomSessionState.pendingJoinRoomCode,
        args.roomSessionState.pendingJoinToken,
      );
    }
  }

  async function requestLeaveRoom(): Promise<void> {
    args.log(
      "background",
      `Popup requested leave for ${args.roomSessionState.roomCode ?? "none"}`,
    );
    if (args.connectionState.connected) {
      args.sendToServer({
        type: "room:leave",
        payload: args.roomSessionState.memberToken
          ? { memberToken: args.roomSessionState.memberToken }
          : undefined,
      });
    }
    args.roomSessionState.roomCode = null;
    args.roomSessionState.joinToken = null;
    args.roomSessionState.memberToken = null;
    args.roomSessionState.memberId = null;
    args.roomSessionState.roomState = null;
    args.roomSessionState.pendingJoinRoomCode = null;
    args.roomSessionState.pendingJoinToken = null;
    args.roomSessionState.pendingJoinRequestSent = false;
    args.resetRoomLifecycleTransientState("leave-room", "leave room requested");
    args.shareState.lastOpenedSharedUrl = null;
    args.roomSessionState.pendingCreateRoom = false;
    args.disconnectSocket();
    await args.persistState();
    args.notifyAll();
  }

  return {
    sendJoinRequest,
    waitForJoinAttemptResult,
    handleServerMessage,
    clearCurrentRoomContext,
    requestCreateRoom,
    requestJoinRoom,
    requestLeaveRoom,
  };
}
