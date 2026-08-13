import type { RoomState, SharedVideo } from "@bili-syncplay/protocol";
import type { SharedVideoToastPayload } from "../shared/messages";
import type { ContentRuntimeState } from "./runtime-state";
import { setRoomMembership } from "./runtime-state";
import type { ToastCoordinatorState } from "./toast";
import {
  createToastPresenter,
  getRoomStateToastMessages,
  getSharedVideoToastMessage,
} from "./toast";

export interface RoomStateController {
  isCurrentPageShowingSharedVideo(state: RoomState): boolean;
  notifyRoomStateToasts(state: RoomState): void;
  maybeShowSharedVideoToast(
    toast: SharedVideoToastPayload | null | undefined,
    state: RoomState,
  ): void;
  handleSyncStatus(payload: {
    roomCode: string | null;
    connected: boolean;
    memberId: string | null;
    rttMs: number | null;
  }): void;
}

export function createRoomStateController(args: {
  runtimeState: ContentRuntimeState;
  toastState: ToastCoordinatorState;
  toastPresenter: ReturnType<typeof createToastPresenter>;
  getSharedVideo: () => SharedVideo | null;
  normalizeUrl: (url: string | undefined | null) => string | null;
  debugLog: (message: string) => void;
  resetPlaybackSyncState: (reason: string) => void;
  scheduleHydrationRetry: (delayMs?: number) => void;
  resetHydrationRetry: () => void;
}): RoomStateController {
  let lastWaitingRoomStateLogRoomCode: string | null = null;

  function isCurrentPageShowingSharedVideo(state: RoomState): boolean {
    const currentVideo = args.getSharedVideo();
    if (!currentVideo || !state.sharedVideo) {
      return false;
    }

    return (
      args.normalizeUrl(currentVideo.url) ===
      args.normalizeUrl(state.sharedVideo.url)
    );
  }

  function notifyRoomStateToasts(state: RoomState): void {
    // Monotonic: every timing decision downstream is an interval measured on
    // this machine, and none of them may move when a clock is adjusted.
    const now = performance.now();
    const plan = getRoomStateToastMessages({
      previousState: args.toastState.lastRoomState,
      nextState: state,
      localMemberId: args.runtimeState.localMemberId,
      pendingRoomStateHydration: args.runtimeState.pendingRoomStateHydration,
      isCurrentPageShowingSharedVideo: isCurrentPageShowingSharedVideo(state),
      now,
      elapsedSincePreviousStateMs:
        args.toastState.lastRoomStateAtMs === null
          ? 0
          : now - args.toastState.lastRoomStateAtMs,
      lastSeekToastByActor: args.toastState.lastSeekToastByActor,
    });
    args.toastState.lastRoomState = state;
    args.toastState.lastRoomStateAtMs = now;
    args.toastState.lastSeekToastByActor = plan.nextSeekToastByActor;
    for (const message of plan.messages) {
      args.toastPresenter.show(message);
    }
  }

  function maybeShowSharedVideoToast(
    toast: SharedVideoToastPayload | null | undefined,
    state: RoomState,
  ): void {
    const plan = getSharedVideoToastMessage({
      toast,
      state,
      localMemberId: args.runtimeState.localMemberId,
      lastSharedVideoToastKey: args.toastState.lastSharedVideoToastKey,
      normalizedToastUrl: args.normalizeUrl(toast?.videoUrl),
      normalizedSharedUrl: args.normalizeUrl(state.sharedVideo?.url),
      localAutoShareTargetUrl: args.runtimeState.pendingAutoShareTargetUrl,
    });
    args.toastState.lastSharedVideoToastKey = plan.nextSharedVideoToastKey;
    if (plan.message) {
      args.toastPresenter.show(plan.message);
    }
  }

  function clearRoomScopedSharedVideoState(): void {
    args.runtimeState.activeSharedUrl = null;
    args.runtimeState.activeSharedByMemberId = null;
    args.runtimeState.pendingAutoShareTargetUrl = null;
    args.runtimeState.resolvedSharedVideoUrl = null;
    args.runtimeState.explicitNonSharedPlaybackUrl = null;
    args.runtimeState.suppressedLocalEndPauseUrl = null;
    args.runtimeState.suppressedLocalEndPauseUntil = 0;
    args.runtimeState.sharedVideoNaturalEndUrl = null;
    args.runtimeState.sharedVideoNaturalEndAt = 0;
    args.runtimeState.nonSharerAutoplayHoldUrl = null;
    args.runtimeState.lastNonSharedGuardUrl = null;
    args.runtimeState.postNavigationAnchorSharedUrl = null;
    args.runtimeState.postNavigationAnchorSetAt = 0;
  }

  function handleSyncStatus(payload: {
    roomCode: string | null;
    connected: boolean;
    memberId: string | null;
    rttMs: number | null;
  }): void {
    const previousRoomCode = args.runtimeState.activeRoomCode;
    setRoomMembership(args.runtimeState, payload.roomCode, payload.memberId);
    args.runtimeState.rttMs = payload.rttMs;
    const roomChanged = Boolean(
      previousRoomCode &&
      payload.roomCode &&
      previousRoomCode !== payload.roomCode,
    );

    if (roomChanged) {
      args.resetPlaybackSyncState(
        `room changed ${previousRoomCode} -> ${payload.roomCode}`,
      );
      // The hydration retry's backoff streaks measure how long the *previous*
      // room's wait had been failing. Carrying them over would either stretch
      // the 150ms bootstrap retry below to the ceiling, or have the old room's
      // still-armed timer refuse it outright via the single-timer guard.
      args.resetHydrationRetry();
      args.toastState.lastRoomState = null;
      args.runtimeState.hasReceivedInitialRoomState = false;
      args.runtimeState.pendingRoomStateHydration = true;
      clearRoomScopedSharedVideoState();
    }

    if (payload.roomCode && !args.runtimeState.hasReceivedInitialRoomState) {
      args.runtimeState.pendingRoomStateHydration = true;
      args.runtimeState.hydrationReady = false;
      if (lastWaitingRoomStateLogRoomCode !== payload.roomCode) {
        args.debugLog(`Waiting for initial room state of ${payload.roomCode}`);
        lastWaitingRoomStateLogRoomCode = payload.roomCode;
      }
      args.scheduleHydrationRetry(150);
    }

    if (!payload.roomCode) {
      if (previousRoomCode) {
        args.resetPlaybackSyncState(`room cleared from ${previousRoomCode}`);
      }
      // Leaving is the other half of a room switch, and the common one:
      // `roomChanged` above needs both codes non-null, but leaving then joining
      // reports `ROOM01 -> null -> ROOM02`, so neither call satisfies it and the
      // retry state would survive into the new room untouched.
      args.resetHydrationRetry();
      clearRoomScopedSharedVideoState();
      args.toastState.lastRoomState = null;
      args.runtimeState.pendingRoomStateHydration = false;
      args.runtimeState.hasReceivedInitialRoomState = false;
      args.runtimeState.hydrationReady = false;
      lastWaitingRoomStateLogRoomCode = null;
    }
  }

  return {
    isCurrentPageShowingSharedVideo,
    notifyRoomStateToasts,
    maybeShowSharedVideoToast,
    handleSyncStatus,
  };
}
