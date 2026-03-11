import type { RoomState } from "@bili-syncplay/protocol";

export type IncomingRoomStateDecision =
  | {
      kind: "ignore-stale";
    }
  | {
      kind: "apply";
      previousSharedUrl: string | null;
      confirmedPendingLocalShare: boolean;
    };

export function decideIncomingRoomState(args: {
  currentRoomState: RoomState | null;
  nextState: RoomState;
  normalizedPendingLocalShareUrl: string | null;
  normalizedIncomingSharedUrl: string | null;
}): IncomingRoomStateDecision {
  const {
    currentRoomState,
    nextState,
    normalizedPendingLocalShareUrl,
    normalizedIncomingSharedUrl
  } = args;

  if (normalizedPendingLocalShareUrl && normalizedIncomingSharedUrl !== normalizedPendingLocalShareUrl) {
    return { kind: "ignore-stale" };
  }

  return {
    kind: "apply",
    previousSharedUrl: currentRoomState?.sharedVideo?.url ?? null,
    confirmedPendingLocalShare:
      normalizedPendingLocalShareUrl !== null && normalizedIncomingSharedUrl === normalizedPendingLocalShareUrl
  };
}

export function isSharedVideoChange(previousSharedUrl: string | null, nextState: RoomState): boolean {
  return previousSharedUrl !== (nextState.sharedVideo?.url ?? null);
}
