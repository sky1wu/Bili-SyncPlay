import type { RoomState } from "@bili-syncplay/protocol";

export const PENDING_LOCAL_SHARE_TIMEOUT_MS = 10000;

export interface PendingLocalShareState {
  pendingLocalShareUrl: string | null;
  pendingLocalShareExpiresAt: number | null;
  pendingLocalShareTimer: number | null;
}

export interface PendingLocalShareCleanupPlan {
  nextState: PendingLocalShareState;
  hadPendingLocalShare: boolean;
  shouldCancelTimer: boolean;
}

export type RoomLifecycleAction = "create-room" | "join-room" | "leave-room";

export type IncomingRoomStateDecision =
  | {
      kind: "ignore-stale";
    }
  | {
      kind: "apply";
      previousSharedUrl: string | null;
      confirmedPendingLocalShare: boolean;
    };

export function createPendingLocalShareExpiry(
  now: number,
  timeoutMs = PENDING_LOCAL_SHARE_TIMEOUT_MS,
): number {
  return now + timeoutMs;
}

export function getActivePendingLocalShareUrl(args: {
  pendingLocalShareUrl: string | null;
  pendingLocalShareExpiresAt: number | null;
  now: number;
}): string | null {
  const { pendingLocalShareUrl, pendingLocalShareExpiresAt, now } = args;
  if (!pendingLocalShareUrl || pendingLocalShareExpiresAt === null) {
    return null;
  }
  return pendingLocalShareExpiresAt > now ? pendingLocalShareUrl : null;
}

export function shouldClearPendingLocalShareOnServerUrlChange(args: {
  currentServerUrl: string;
  nextServerUrl: string;
  pendingLocalShareUrl: string | null;
}): boolean {
  const { currentServerUrl, nextServerUrl, pendingLocalShareUrl } = args;
  return pendingLocalShareUrl !== null && currentServerUrl !== nextServerUrl;
}

export function clearPendingLocalShareState(): PendingLocalShareState {
  return {
    pendingLocalShareUrl: null,
    pendingLocalShareExpiresAt: null,
    pendingLocalShareTimer: null,
  };
}

export function preparePendingLocalShareCleanup(
  state: PendingLocalShareState,
): PendingLocalShareCleanupPlan {
  return {
    nextState: clearPendingLocalShareState(),
    hadPendingLocalShare:
      Boolean(state.pendingLocalShareUrl) ||
      state.pendingLocalShareExpiresAt !== null,
    shouldCancelTimer: state.pendingLocalShareTimer !== null,
  };
}

export function preparePendingLocalShareCleanupForRoomLifecycle(
  _action: RoomLifecycleAction,
  state: PendingLocalShareState,
): PendingLocalShareCleanupPlan {
  return preparePendingLocalShareCleanup(state);
}

export function decideIncomingRoomState(args: {
  currentRoomState: RoomState | null;
  normalizedPendingLocalShareUrl: string | null;
  normalizedIncomingSharedUrl: string | null;
}): IncomingRoomStateDecision {
  const {
    currentRoomState,
    normalizedPendingLocalShareUrl,
    normalizedIncomingSharedUrl,
  } = args;

  if (
    normalizedPendingLocalShareUrl &&
    normalizedIncomingSharedUrl !== normalizedPendingLocalShareUrl
  ) {
    return { kind: "ignore-stale" };
  }

  return {
    kind: "apply",
    previousSharedUrl: currentRoomState?.sharedVideo?.url ?? null,
    confirmedPendingLocalShare:
      normalizedPendingLocalShareUrl !== null &&
      normalizedIncomingSharedUrl === normalizedPendingLocalShareUrl,
  };
}

export function isSharedVideoChange(
  previousSharedUrl: string | null,
  nextState: RoomState,
): boolean {
  return previousSharedUrl !== (nextState.sharedVideo?.url ?? null);
}

export interface TransientShareLifecycleState {
  pendingLocalShareUrl: string | null;
  pendingLocalShareExpiresAt: number | null;
  pendingLocalShareTimer: number | null;
  pendingShareToast: unknown;
}

export interface TransientRoomSessionLifecycleState {
  pendingSharedVideo: unknown;
  pendingSharedPlayback: unknown;
}

export function resetRoomLifecycleTransientState(
  action: RoomLifecycleAction,
  reason: string,
  args: {
    shareState: TransientShareLifecycleState;
    roomSessionState: TransientRoomSessionLifecycleState;
    log: (message: string) => void;
  },
): void {
  const cleanup = preparePendingLocalShareCleanupForRoomLifecycle(action, {
    pendingLocalShareUrl: args.shareState.pendingLocalShareUrl,
    pendingLocalShareExpiresAt: args.shareState.pendingLocalShareExpiresAt,
    pendingLocalShareTimer: args.shareState.pendingLocalShareTimer,
  });
  if (cleanup.hadPendingLocalShare) {
    if (cleanup.shouldCancelTimer) {
      if (args.shareState.pendingLocalShareTimer !== null) {
        clearTimeout(args.shareState.pendingLocalShareTimer);
        args.shareState.pendingLocalShareTimer = null;
      }
    }
    args.log(`Cleared pending local share (${reason})`);
    args.shareState.pendingLocalShareUrl =
      cleanup.nextState.pendingLocalShareUrl;
    args.shareState.pendingLocalShareExpiresAt =
      cleanup.nextState.pendingLocalShareExpiresAt;
    args.shareState.pendingLocalShareTimer =
      cleanup.nextState.pendingLocalShareTimer;
  }
  args.shareState.pendingShareToast = null;
  args.roomSessionState.pendingSharedVideo = null;
  args.roomSessionState.pendingSharedPlayback = null;
}
