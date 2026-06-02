import type { BackgroundToPopupMessage } from "../shared/messages";
import type { BackgroundRuntimeState } from "./runtime-state";

export function createPopupStateSnapshot(args: {
  state: BackgroundRuntimeState;
  retryInMs: number | null;
  retryAttemptMax: number;
}): BackgroundToPopupMessage {
  return {
    type: "background:state",
    payload: {
      connected: args.state.connection.connected,
      roomCode: args.state.room.roomCode,
      joinToken: args.state.room.joinToken,
      memberId: args.state.room.memberId,
      displayName: args.state.room.displayName,
      roomState: args.state.room.roomState,
      serverUrl: args.state.connection.serverUrl,
      error: args.state.connection.lastError,
      pendingCreateRoom: args.state.room.pendingCreateRoom,
      pendingJoinRoomCode: args.state.room.pendingJoinRoomCode,
      retryInMs: args.retryInMs,
      retryAttempt: args.state.connection.reconnectAttempt,
      retryAttemptMax: args.retryAttemptMax,
      clockOffsetMs: args.state.clock.clockOffsetMs,
      rttMs: args.state.clock.rttMs,
      voice: args.state.voice,
      logs: args.state.diagnostics.logs,
    },
  };
}
