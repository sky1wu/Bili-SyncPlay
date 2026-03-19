import type { BackgroundRuntimeState } from "./runtime-state";

export interface RuntimeSyncController {
  syncRuntimeStateStore(): BackgroundRuntimeState;
  persistState(): Promise<void>;
}

export function createRuntimeSyncController(args: {
  stateStore: {
    patch(patch: Partial<BackgroundRuntimeState>): BackgroundRuntimeState;
  };
  connectionState: BackgroundRuntimeState["connection"];
  roomSessionState: BackgroundRuntimeState["room"];
  shareState: BackgroundRuntimeState["share"];
  clockState: BackgroundRuntimeState["clock"];
  diagnosticsState: BackgroundRuntimeState["diagnostics"];
  persistBackgroundState: (state: BackgroundRuntimeState) => Promise<void>;
}): RuntimeSyncController {
  function syncRuntimeStateStore(): BackgroundRuntimeState {
    return args.stateStore.patch({
      connection: {
        socket: args.connectionState.socket,
        serverUrl: args.connectionState.serverUrl,
        connected: args.connectionState.connected,
        lastError: args.connectionState.lastError,
        connectProbe: args.connectionState.connectProbe,
        reconnectTimer: args.connectionState.reconnectTimer,
        reconnectAttempt: args.connectionState.reconnectAttempt,
        reconnectDeadlineMs: args.connectionState.reconnectDeadlineMs,
      },
      room: {
        roomCode: args.roomSessionState.roomCode,
        joinToken: args.roomSessionState.joinToken,
        memberToken: args.roomSessionState.memberToken,
        memberId: args.roomSessionState.memberId,
        displayName: args.roomSessionState.displayName,
        roomState: args.roomSessionState.roomState,
        pendingCreateRoom: args.roomSessionState.pendingCreateRoom,
        pendingJoinRoomCode: args.roomSessionState.pendingJoinRoomCode,
        pendingJoinToken: args.roomSessionState.pendingJoinToken,
        pendingJoinRequestSent: args.roomSessionState.pendingJoinRequestSent,
        pendingSharedVideo: args.roomSessionState.pendingSharedVideo,
        pendingSharedPlayback: args.roomSessionState.pendingSharedPlayback,
      },
      share: {
        sharedTabId: args.shareState.sharedTabId,
        lastOpenedSharedUrl: args.shareState.lastOpenedSharedUrl,
        openingSharedUrl: args.shareState.openingSharedUrl,
        pendingLocalShareUrl: args.shareState.pendingLocalShareUrl,
        pendingLocalShareExpiresAt: args.shareState.pendingLocalShareExpiresAt,
        pendingLocalShareTimer: args.shareState.pendingLocalShareTimer,
        pendingShareToast: args.shareState.pendingShareToast,
      },
      clock: {
        clockOffsetMs: args.clockState.clockOffsetMs,
        rttMs: args.clockState.rttMs,
        clockSyncTimer: args.clockState.clockSyncTimer,
      },
      diagnostics: {
        logs: args.diagnosticsState.logs,
        lastPopupStateLogKey: args.diagnosticsState.lastPopupStateLogKey,
      },
    });
  }

  async function persistState(): Promise<void> {
    await args.persistBackgroundState(syncRuntimeStateStore());
  }

  return {
    syncRuntimeStateStore,
    persistState,
  };
}
