import type {
  ErrorCode,
  RoomMember,
  RoomState,
  ServerMessage,
  ClientMessage,
} from "@bili-syncplay/protocol";
import { PROTOCOL_VERSION } from "@bili-syncplay/protocol";
import type { BackgroundToContentMessage } from "../shared/messages";
import {
  decideIncomingRoomState,
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
import { resolvePlaybackAnchorAtMs } from "./clock-sync";
import { getReconnectDelayMs } from "./socket-manager";

type JoinAttemptResult = "joined" | "failed" | "timeout";
type JoinErrorDisposition = "retry" | "retry-without-member-token" | "terminal";
const JOIN_ERROR_DISPOSITIONS = {
  origin_not_allowed: "terminal",
  room_not_found: "terminal",
  join_token_invalid: "terminal",
  member_token_invalid: "retry-without-member-token",
  not_in_room: "terminal",
  rate_limited: "retry",
  invalid_message: "terminal",
  payload_too_large: "terminal",
  room_full: "terminal",
  room_resolution_unconfirmed: "retry",
  unsupported_protocol_version: "terminal",
  internal_error: "retry",
} as const satisfies Record<ErrorCode, JoinErrorDisposition>;
type JoinRetryTarget = {
  source: "pending" | "stored";
  roomCode: string;
  joinToken: string;
};
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
  compensateRoomState: (state: RoomState, anchorAtMs?: number) => RoomState;
  markPlaybackArrival: (playback: RoomState["playback"], atMs: number) => void;
  clearPendingLocalShare: (reason: string) => void;
  expirePendingLocalShareIfNeeded: () => void;
  /**
   * Asked of the share controller rather than re-derived here: the marker's
   * deadline lives on a monotonic clock owned by that controller, and a second
   * copy of the comparison would be a second clock read that nothing keeps in
   * the same domain.
   */
  getActivePendingLocalShareUrl: () => string | null;
  normalizeUrl: (url: string | undefined | null) => string | null;
  logServerError: (code: string, message: string) => void;
  shareToastTtlMs: number;
  /**
   * Monotonic time source, shared with the clock controller: it stamps when a
   * `room:state` arrived so that neither the work before applying it nor the age
   * it already had on arrival is credited to nobody. See
   * `ClockController.compensateRoomState`.
   */
  getMonotonicNow?: () => number;
  bootstrapRoomStateTimeoutMs?: number;
  getJoinRetryDelayMs?: (attempt: number) => number;
}): RoomSessionController {
  let pendingJoinAttemptResolvers: Array<(result: JoinAttemptResult) => void> =
    [];
  let pendingMemberDeltas: PendingMemberDelta[] = [];
  let waitingForBootstrapRoomState = false;
  let bootstrapRoomStateGeneration = 0;
  let bootstrapRoomStateTimer: ReturnType<typeof globalThis.setTimeout> | null =
    null;
  let pendingJoinRetryTimer: ReturnType<typeof globalThis.setTimeout> | null =
    null;
  let pendingJoinRetryAttempt = 0;
  const bootstrapRoomStateTimeoutMs =
    args.bootstrapRoomStateTimeoutMs ?? DEFAULT_BOOTSTRAP_ROOM_STATE_TIMEOUT_MS;
  const monotonicNow = () => args.getMonotonicNow?.() ?? performance.now();
  const resolveJoinRetryDelayMs =
    args.getJoinRetryDelayMs ?? getReconnectDelayMs;

  function clearJoinRetryTimer(): void {
    if (pendingJoinRetryTimer !== null) {
      globalThis.clearTimeout(pendingJoinRetryTimer);
      pendingJoinRetryTimer = null;
    }
  }

  function resetJoinRetry(): void {
    pendingJoinRetryAttempt = 0;
    clearJoinRetryTimer();
  }

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
    if (!hasJoinRequestOnCurrentSocket()) {
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
    // Deliberately do NOT clear `awaitingFreshRoomState` here: this timeout only
    // bounds how long queued member deltas wait, not the authoritative room
    // state. If `room:state` is simply slow, releasing the guard would let a
    // deferred auto-share send against the pre-disconnect room snapshot/member
    // token and clobber whatever the room advanced to. Keep deferring until a
    // real `room:state` (or room teardown) lands.
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
    // As in `applyRoomMemberState`: the queued deltas only change membership, so
    // the playback snapshot — and its anchor — is the one that already arrived.
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
    args.roomSessionState.pendingJoinRequestGeneration =
      args.connectionState.socketGeneration;
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

  function hasJoinRequestOnCurrentSocket(): boolean {
    return (
      args.roomSessionState.pendingJoinRequestGeneration !== null &&
      args.roomSessionState.pendingJoinRequestGeneration ===
        args.connectionState.socketGeneration
    );
  }

  function getJoinRetryTarget(): JoinRetryTarget | null {
    if (
      args.roomSessionState.pendingJoinRoomCode &&
      args.roomSessionState.pendingJoinToken
    ) {
      return {
        source: "pending",
        roomCode: args.roomSessionState.pendingJoinRoomCode,
        joinToken: args.roomSessionState.pendingJoinToken,
      };
    }
    if (args.roomSessionState.roomCode && args.roomSessionState.joinToken) {
      return {
        source: "stored",
        roomCode: args.roomSessionState.roomCode,
        joinToken: args.roomSessionState.joinToken,
      };
    }
    return null;
  }

  function isCurrentJoinRetryTarget(target: JoinRetryTarget): boolean {
    const current = getJoinRetryTarget();
    return (
      current?.source === target.source &&
      current.roomCode === target.roomCode &&
      current.joinToken === target.joinToken
    );
  }

  function scheduleJoinRetryAfterTransientError(errorCode: ErrorCode): boolean {
    if (!hasJoinRequestOnCurrentSocket()) {
      return false;
    }
    const target = getJoinRetryTarget();
    if (!target) {
      return false;
    }

    // The server has answered this connection's attempt. Release its ownership;
    // the target was persisted before the first send, so either the timer, a
    // reconnect, or a restarted worker can issue the exact same join intent.
    args.roomSessionState.pendingJoinRequestGeneration = null;
    args.log(
      "background",
      `Retrying ${target.source} join for ${target.roomCode} after ${errorCode}`,
    );
    pendingJoinRetryAttempt += 1;
    const retryDelayMs = resolveJoinRetryDelayMs(pendingJoinRetryAttempt);
    args.log(
      "background",
      `Join retry for ${target.roomCode} scheduled in ${retryDelayMs}ms`,
    );
    // A reconnect can re-issue the intent before the previous timer fires. Its
    // next transient response replaces that schedule, so keep exactly one
    // retry timer for the intent.
    clearJoinRetryTimer();
    const retryTimer = globalThis.setTimeout(() => {
      pendingJoinRetryTimer = null;
      if (
        args.connectionState.connected &&
        !hasJoinRequestOnCurrentSocket() &&
        isCurrentJoinRetryTarget(target)
      ) {
        sendJoinRequest(target.roomCode, target.joinToken);
        args.notifyAll();
      }
    }, retryDelayMs);
    pendingJoinRetryTimer = retryTimer;
    const timerControls = retryTimer as {
      unref?: () => void;
    };
    timerControls?.unref?.();
    return true;
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
    // Stamped before anything can await: everything between the socket event and
    // here is synchronous, so this is when the message reached us.
    const receivedAtMs = monotonicNow();
    switch (message.type) {
      case "room:created":
        resetJoinRetry();
        clearPendingMemberDeltas();
        startWaitingForBootstrapRoomState();
        args.roomSessionState.pendingJoinRoomCode = null;
        args.roomSessionState.pendingJoinToken = null;
        args.roomSessionState.pendingJoinRequestGeneration = null;
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
        resetJoinRetry();
        clearPendingMemberDeltasExceptRoom(message.payload.roomCode);
        startWaitingForBootstrapRoomState();
        args.roomSessionState.roomCode = message.payload.roomCode;
        args.roomSessionState.joinToken =
          args.roomSessionState.pendingJoinToken ??
          args.roomSessionState.joinToken;
        args.roomSessionState.memberToken = message.payload.memberToken;
        args.roomSessionState.memberId = message.payload.memberId;
        args.roomSessionState.pendingJoinRequestGeneration = null;
        args.roomSessionState.pendingJoinRoomCode = null;
        args.roomSessionState.pendingJoinToken = null;
        args.connectionState.lastError = null;
        settlePendingJoinAttempt("joined");
        syncProfileAfterRoomEstablished();
        await args.persistState();
        args.flushPendingShare();
        args.notifyAll();
        return;
      case "room:state": {
        // `playbackAgeMs` is stripped here rather than carried inside: it is only
        // true at the instant the server sent it, and the room state travels on
        // into storage and into member-delta rewraps where a stale age would read
        // as a fresh one.
        const { playbackAgeMs, ...state } = message.payload;
        await handleRoomStateMessage(
          state,
          resolvePlaybackAnchorAtMs(receivedAtMs, playbackAgeMs),
        );
        return;
      }
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
      case "error": {
        args.connectionState.lastError = localizeServerError(
          message.payload.code,
          message.payload.message,
        );
        const joinErrorDisposition = hasJoinRequestOnCurrentSocket()
          ? JOIN_ERROR_DISPOSITIONS[message.payload.code]
          : null;
        if (joinErrorDisposition === "retry-without-member-token") {
          // The durable room/join intent is still valid; only the reconnect
          // identity was rejected. Drop that credential before the retry so the
          // server can issue a fresh member identity, including after restart.
          args.roomSessionState.memberToken = null;
          await args.persistState();
        }
        if (
          (joinErrorDisposition === "retry" ||
            joinErrorDisposition === "retry-without-member-token") &&
          scheduleJoinRetryAfterTransientError(message.payload.code)
        ) {
          args.logServerError(message.payload.code, message.payload.message);
          args.notifyAll();
          return;
        }
        if (
          joinErrorDisposition === "terminal" &&
          args.roomSessionState.pendingJoinRoomCode
        ) {
          resetJoinRetry();
          args.log(
            "background",
            `Join failed for room ${args.roomSessionState.pendingJoinRoomCode}`,
          );
          stopWaitingForBootstrapRoomState();
          settlePendingJoinAttempt("failed");
          args.roomSessionState.pendingJoinRequestGeneration = null;
          args.roomSessionState.pendingJoinRoomCode = null;
          args.roomSessionState.pendingJoinToken = null;
          args.roomSessionState.roomCode = null;
          args.roomSessionState.joinToken = null;
          args.roomSessionState.memberToken = null;
          args.roomSessionState.memberId = null;
          args.roomSessionState.roomState = null;
          await args.persistState();
          args.logServerError(message.payload.code, message.payload.message);
          args.notifyAll();
          return;
        }
        if (
          joinErrorDisposition === "terminal" &&
          args.roomSessionState.roomCode &&
          !args.roomSessionState.pendingJoinRoomCode
        ) {
          await clearCurrentRoomContext(
            `server rejected stored room context: ${message.payload.code}`,
            args.connectionState.lastError,
          );
          args.logServerError(message.payload.code, message.payload.message);
          return;
        }
        if (
          message.payload.code === "member_token_invalid" &&
          joinErrorDisposition !== "retry-without-member-token"
        ) {
          args.roomSessionState.memberToken = null;
          await args.persistState();
        }
        args.logServerError(message.payload.code, message.payload.message);
        args.notifyAll();
        return;
      }
      case "sync:pong":
        return;
    }
  }

  async function applyRoomMemberState(nextState: RoomState): Promise<void> {
    args.roomSessionState.roomState = nextState;
    args.roomSessionState.roomCode = nextState.roomCode;
    args.connectionState.lastError = null;

    await args.persistState();

    // Same hazard as `handleRoomStateMessage`: handlers do not serialize, so a
    // newer state can take over while this one awaits. This one carries the *older*
    // playback snapshot, and the content script's staleness check is per actor, so
    // pushing it would move playback backwards for real rather than being ignored.
    // The newer state carries the server's own member list, so nothing is lost by
    // dropping this delta — its join/leave toast comes from the content script
    // diffing that state.
    if (args.roomSessionState.roomState !== nextState) {
      args.log(
        "background",
        `Dropped superseded member state for ${nextState.roomCode}`,
      );
      return;
    }

    // No arrival stamp: a member delta carries the playback snapshot we already
    // have, and its anchor was established when that snapshot arrived at ingress.
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

  async function handleRoomStateMessage(
    nextState: RoomState,
    playbackAnchorAtMs: number,
  ): Promise<void> {
    args.expirePendingLocalShareIfNeeded();
    const decision = decideIncomingRoomState({
      currentRoomState: args.roomSessionState.roomState,
      normalizedPendingLocalShareUrl: args.normalizeUrl(
        args.getActivePendingLocalShareUrl(),
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
    // Anchored before the state becomes observable and before anything awaits:
    // from here a rehydrating content script can read it and a member delta can
    // rewrap it, and whichever of those compensates first must find the arrival
    // already recorded rather than anchoring the snapshot at its own moment.
    args.markPlaybackArrival(resolvedState.playback, playbackAnchorAtMs);
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

    // Handlers are started with `void handleServerMessage(...)` per socket message
    // and do not serialize, so a later state can take over while this one is
    // awaiting (`ensureSharedVideoOpen` may open a tab). Once that has happened
    // this handler has nothing left to deliver: the newer state is what the room
    // is, and its own handler applies and announces it.
    //
    // Pushing our snapshot anyway would move playback backwards. The content
    // script's staleness check is per actor
    // (`room-state-apply-controller` looks up `lastAppliedVersionByActor`), so an
    // older snapshot from a *different* member is not recognised as stale and gets
    // applied — the position is a real regression, not a dropped message. Even for
    // the same actor, compensating here would already have re-pointed the single
    // anchor at the older snapshot before the content script rejects it.
    if (args.roomSessionState.roomState !== resolvedState) {
      args.log(
        "background",
        `Dropped superseded room state for ${resolvedState.roomCode}`,
      );
      return;
    }

    // Anchored where the snapshot was actually current, not on reaching this
    // line: the awaits above can take a while and the room played on through
    // them. `resolvedState` and its own anchor, never a re-read of shared state —
    // a snapshot must only ever be paired with the anchor that belongs to it.
    const compensatedRoomState = args.compensateRoomState(
      resolvedState,
      playbackAnchorAtMs,
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
      now: monotonicNow(),
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
      now: monotonicNow(),
    });
    args.shareState.pendingShareToast = result.pendingShareToast;
    return result.shareToast;
  }

  async function clearCurrentRoomContext(
    reason: string,
    errorMessage: string | null = null,
  ): Promise<void> {
    resetJoinRetry();
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
    args.roomSessionState.pendingJoinRequestGeneration = null;
    args.shareState.lastOpenedSharedUrl = null;
    args.connectionState.lastError = errorMessage;
    args.resetReconnectState();
    args.resetRoomLifecycleTransientState("leave-room", reason);
    await args.persistState();
    args.notifyAll();
  }

  async function requestCreateRoom(): Promise<void> {
    resetJoinRetry();
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
    args.roomSessionState.pendingJoinRequestGeneration = null;
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
    resetJoinRetry();
    args.resetReconnectState();
    clearPendingMemberDeltas();
    stopWaitingForBootstrapRoomState();
    args.roomSessionState.pendingCreateRoom = false;
    args.roomSessionState.pendingJoinRoomCode = roomCode.trim().toUpperCase();
    args.roomSessionState.pendingJoinToken = joinToken.trim();
    args.roomSessionState.pendingJoinRequestGeneration = null;
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
      !hasJoinRequestOnCurrentSocket()
    ) {
      sendJoinRequest(
        args.roomSessionState.pendingJoinRoomCode,
        args.roomSessionState.pendingJoinToken,
      );
    }
  }

  async function requestLeaveRoom(): Promise<void> {
    resetJoinRetry();
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
    args.roomSessionState.pendingJoinRequestGeneration = null;
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
