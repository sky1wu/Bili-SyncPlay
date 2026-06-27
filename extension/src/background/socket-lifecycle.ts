export function disconnectSocket(args: {
  connectionState: {
    socket: WebSocket | null;
    connected: boolean;
    connectEpoch: number;
  };
  memberTokenState: { memberToken: string | null };
  resetReconnectState: () => void;
  stopClockSyncTimer: () => void;
  clearPendingLocalShare: (reason: string) => void;
}): void {
  args.resetReconnectState();
  args.stopClockSyncTimer();
  args.clearPendingLocalShare("socket disconnected");
  args.memberTokenState.memberToken = null;
  // Abort any in-flight connect probe so a leave that races an awaiting
  // reconnect cannot open a room-less ghost connection after we tear down here.
  // Bump before the early return: a probe that has not created its socket yet
  // leaves `connectionState.socket` null, so the null check alone would miss it.
  args.connectionState.connectEpoch += 1;

  if (!args.connectionState.socket) {
    args.connectionState.connected = false;
    return;
  }

  const currentSocket = args.connectionState.socket;
  args.connectionState.socket = null;
  args.connectionState.connected = false;
  currentSocket.close();
}
