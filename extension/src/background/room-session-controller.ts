import type {
  RoomMember,
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
type PendingMemberDelta = {
  type: "joined" | "left";
  roomCode: string;
  member: RoomMember;
};

const DEFAULT_BOOTSTRAP_ROOM_STATE_TIMEOUT_MS = 5_000;

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
  bootstrapRoomStateTimeoutMs?: number;
}): RoomSessionController {
  let pendingJoinAttemptResolvers: Array<(result: JoinAttemptResult) => void> =
    [];
  let pendingMemberDeltas: PendingMemberDelta[] = [];
  let waitingForBootstrapRoomState = false;
  let bootstrapRoomStateGeneration = 0;
  let bootstrapRoomStateTimer: ReturnType<typeof globalThis.setTimeout> | null =
    null;
  const bootstrapRoomStateTimeoutMs =
    args.bootstrapRoomStateTimeoutMs ?? DEFAULT_BOOTSTRAP_ROOM_STATE_TIMEOUT_MS;

  function clearPendingMemberDeltas(): void {
    pendingMemberDeltas = [];
  }

  function clearPendingMemberDeltasForRoom(roomCode: string): void {
    pendingMemberDeltas = pendingMemberDeltas.filter(
      (delta) => delta.roomCode !== roomCode,
    );
  }

  function clearPendingMemberDeltasExceptRoom(roomCode: string): void {
    pendingMemberDeltas = pendingMemberDeltas.filter(
      (delta) => delta.roomCode === roomCode,
    );
  }

  function queueMemberDelta(delta: PendingMemberDelta): void {
    pendingMemberDeltas.push(delta);
  }

  function hasPendingMemberDeltasForRoom(roomCode: string): boolean {
    return pendingMemberDeltas.some((delta) => delta.roomCode === roomCode);
  }

  function applyMemberDelta(
    currentState: RoomState,
    delta: PendingMemberDelta,
  ): RoomState {
    if (currentState.roomCode !== delta.roomCode) {
      return currentState;
    }

    if (delta.type === "left") {
      return {
        ...currentState,
        members: currentState.members.filter(
          (candidate) => candidate.id !== delta.member.id,
        ),
      };
    }

    const existingMemberIndex = currentState.members.findIndex(
      (candidate) => candidate.id === delta.member.id,
    );
    const members =
      existingMemberIndex === -1
        ? [...currentState.members, delta.member]
        : currentState.members.map((candidate, index) =>
            index === existingMemberIndex ? delta.member : candidate,
          );
    return {
      ...currentState,
      members,
    };
  }

  function consumePendingMemberDeltas(nextState: RoomState): RoomState {
    let resolvedState = nextState;
    const remainingDeltas: PendingMemberDelta[] = [];
    for (const delta of pendingMemberDeltas) {
      if (delta.roomCode === nextState.roomCode) {
        resolvedState = applyMemberDelta(resolvedState, delta);
      } else {
        remainingDeltas.push(delta);
      }
    }
    pendingMemberDeltas = remainingDeltas;
    return resolvedState;
  }

  function isAwaitingRoomBootstrapFor(roomCode: string): boolean {
    if (
      waitingForBootstrapRoomState &&
      args.roomSessionState.roomCode === roomCode
    ) {
      return true;
    }
    if (!args.roomSessionState.pendingJoinRequestSent) {
      return false;
    }
    return (
      args.roomSessionState.roomCode === roomCode ||
      args.roomSessionState.pendingJoinRoomCode === roomCode
    );
  }

  function stopWaitingForBootstrapRoomState(): void {
    waitingForBootstrapRoomState = false;
    args.roomSessionState.awaitingFreshRoomState = false;
    bootstrapRoomStateGeneration += 1;
    if (bootstrapRoomStateTimer !== null) {
      globalThis.clearTimeout(bootstrapRoomStateTimer);
      bootstrapRoomStateTimer = null;
    }
  }

  async function expireBootstrapRoomStateWait(
    generation: number,
  ): Promise<void> {
    if (
      !waitingForBootstrapRoomState ||
      generation !== bootstrapRoomStateGeneration
    ) {
      return;
    }

    waitingForBootstrapRoomState = false;
    // The bootstrap room state never arrived within the timeout. Stop blocking
    // auto-share-next on it; the room/member checks still guard correctness.
    args.roomSessionState.awaitingFreshRoomState = false;
    bootstrapRoomStateTimer = null;
    const roomCode = args.roomSessionState.roomCode;
    if (!roomCode) {
      clearPendingMemberDeltas();
      return;
    }
    if (!hasPendingMemberDeltasForRoom(roomCode)) {
      return;
    }

    const currentState = args.roomSessionState.roomState;
    if (!currentState || currentState.roomCode !== roomCode) {
      clearPendingMemberDeltasForRoom(roomCode);
      args.log(
        "background",
        `Dropped member deltas after bootstrap room state timeout for ${roomCode}`,
      );
      return;
    }

    const resolvedState = consumePendingMemberDeltas(currentState);
    if (
      generation !== bootstrapRoomStateGeneration ||
      args.roomSessionState.roomCode !== roomCode ||
      args.roomSessionState.roomState !== currentState
    ) {
      return;
    }

    args.log(
      "background",
      `Applied queued member deltas after bootstrap room state timeout for ${roomCode}`,
    );
    args.roomSessionState.roomState = resolvedState;
    args.roomSessionState.roomCode = resolvedState.roomCode;
    args.connectionState.lastError = null;
    await args.persistState();
    if (
      generation !== bootstrapRoomStateGeneration ||
      args.roomSessionState.roomState !== resolvedState
    ) {
      await args.persistState();
      return;
    }
    const compensatedRoomState = args.compensateRoomState(resolvedState);
    await args.notifyContentScripts({
      type: "background:apply-room-state",
      payload: compensatedRoomState,
      shareToast: null,
    });
    args.notifyAll();
  }

  function startWaitingForBootstrapRoomState(): void {
    stopWaitingForBootstrapRoomState();
    waitingForBootstrapRoomState = true;
    args.roomSessionState.awaitingFreshRoomState = true;
    bootstrapRoomStateGeneration += 1;
    const generation = bootstrapRoomStateGeneration;
    bootstrapRoomStateTimer = globalThis.setTimeout(() => {
      void expireBootstrapRoomStateWait(generation);
    }, bootstrapRoomStateTimeoutMs);
    const timerControls = bootstrapRoomStateTimer as {
      unref?: () => void;
    } | null;
    timerControls?.unref?.();
  }

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
        clearPendingMemberDeltas();
        startWaitingForBootstrapRoomState();
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
        clearPendingMemberDeltasExceptRoom(message.payload.roomCode);
        startWaitingForBootstrapRoomState();
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
      case "room:member-joined":
        await handleRoomMemberJoined(
          message.payload.roomCode,
          message.payload.member,
        );
        return;
      case "room:member-left":
        await handleRoomMemberLeft(
          message.payload.roomCode,
          message.payload.member,
        );
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
          stopWaitingForBootstrapRoomState();
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

  async function applyRoomMemberState(nextState: RoomState): Promise<void> {
    args.roomSessionState.roomState = nextState;
    args.roomSessionState.roomCode = nextState.roomCode;
    args.connectionState.lastError = null;

    await args.persistState();
    const compensatedRoomState = args.compensateRoomState(nextState);
    await args.notifyContentScripts({
      type: "background:apply-room-state",
      payload: compensatedRoomState,
      shareToast: null,
    });
    args.notifyAll();
  }

  async function handleRoomMemberJoined(
    roomCode: string,
    member: RoomMember,
  ): Promise<void> {
    const currentState = args.roomSessionState.roomState;
    if (isAwaitingRoomBootstrapFor(roomCode)) {
      queueMemberDelta({ type: "joined", roomCode, member });
      return;
    }
    if (!currentState || currentState.roomCode !== roomCode) {
      return;
    }

    await applyRoomMemberState(
      applyMemberDelta(currentState, { type: "joined", roomCode, member }),
    );
  }

  async function handleRoomMemberLeft(
    roomCode: string,
    member: RoomMember,
  ): Promise<void> {
    const currentState = args.roomSessionState.roomState;
    if (isAwaitingRoomBootstrapFor(roomCode)) {
      queueMemberDelta({ type: "left", roomCode, member });
      return;
    }
    if (!currentState || currentState.roomCode !== roomCode) {
      return;
    }

    await applyRoomMemberState(
      applyMemberDelta(currentState, { type: "left", roomCode, member }),
    );
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

    const resolvedState = consumePendingMemberDeltas(nextState);
    stopWaitingForBootstrapRoomState();
    args.roomSessionState.roomState = resolvedState;
    args.roomSessionState.roomCode = resolvedState.roomCode;
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
    clearPendingMemberDeltas();
    stopWaitingForBootstrapRoomState();
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
    clearPendingMemberDeltas();
    stopWaitingForBootstrapRoomState();
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
    clearPendingMemberDeltas();
    stopWaitingForBootstrapRoomState();
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
    clearPendingMemberDeltas();
    stopWaitingForBootstrapRoomState();
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
