import type { RoomState, SharedVideo } from "@bili-syncplay/protocol";
import type { SharedVideoToastPayload } from "../shared/messages";
import type { ContentRuntimeState } from "./runtime-state";
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
}): RoomStateController {
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
    const plan = getRoomStateToastMessages({
      previousState: args.toastState.lastRoomState,
      nextState: state,
      localMemberId: args.runtimeState.localMemberId,
      pendingRoomStateHydration: args.runtimeState.pendingRoomStateHydration,
      isCurrentPageShowingSharedVideo: isCurrentPageShowingSharedVideo(state),
      now: Date.now(),
      lastSeekToastByActor: args.toastState.lastSeekToastByActor,
    });
    args.toastState.lastRoomState = state;
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
    });
    args.toastState.lastSharedVideoToastKey = plan.nextSharedVideoToastKey;
    if (plan.message) {
      args.toastPresenter.show(plan.message);
    }
  }

  function handleSyncStatus(payload: {
    roomCode: string | null;
    connected: boolean;
    memberId: string | null;
  }): void {
    const previousRoomCode = args.runtimeState.activeRoomCode;
    args.runtimeState.activeRoomCode = payload.roomCode;
    args.runtimeState.localMemberId = payload.memberId;
    const roomChanged = Boolean(
      previousRoomCode &&
      payload.roomCode &&
      previousRoomCode !== payload.roomCode,
    );

    if (roomChanged) {
      args.resetPlaybackSyncState(
        `room changed ${previousRoomCode} -> ${payload.roomCode}`,
      );
      args.toastState.lastRoomState = null;
      args.runtimeState.hasReceivedInitialRoomState = false;
      args.runtimeState.pendingRoomStateHydration = true;
    }

    if (payload.roomCode && !args.runtimeState.hasReceivedInitialRoomState) {
      args.runtimeState.pendingRoomStateHydration = true;
      args.debugLog(`Waiting for initial room state of ${payload.roomCode}`);
      args.scheduleHydrationRetry(150);
    }

    if (!payload.roomCode) {
      if (previousRoomCode) {
        args.resetPlaybackSyncState(`room cleared from ${previousRoomCode}`);
      }
      args.runtimeState.activeSharedUrl = null;
      args.toastState.lastRoomState = null;
      args.runtimeState.pendingRoomStateHydration = false;
      args.runtimeState.hasReceivedInitialRoomState = false;
    }
  }

  return {
    isCurrentPageShowingSharedVideo,
    notifyRoomStateToasts,
    maybeShowSharedVideoToast,
    handleSyncStatus,
  };
}
