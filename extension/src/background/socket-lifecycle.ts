export function disconnectSocket(args: {
  connectionState: {
    socket: WebSocket | null;
    connected: boolean;
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

  if (!args.connectionState.socket) {
    args.connectionState.connected = false;
    return;
  }

  const currentSocket = args.connectionState.socket;
  args.connectionState.socket = null;
  args.connectionState.connected = false;
  currentSocket.close();
}
