export function shouldReconnect(args: {
  connected: boolean;
  reconnectTimer: number | null;
  roomCode: string | null;
  pendingCreateRoom: boolean;
}): boolean {
  if (args.connected || args.reconnectTimer !== null) {
    return false;
  }
  return Boolean(args.roomCode) || args.pendingCreateRoom;
}

// Reconnects retry indefinitely while a room session exists: a user sitting in
// a room gains nothing from the client giving up (a server restart routinely
// outlasts any fixed attempt budget), so there is no attempt cap — only the
// backoff ceiling below bounds the retry pressure on the server.
export function getReconnectDelayMs(reconnectAttempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, reconnectAttempt - 1), 30000);
}

/**
 * Whether a `ClientMessage` can actually be written to the socket right now.
 *
 * `connectionState.connected` is only flipped to false by the socket's
 * `close`/`error` events, so during the micro-window where the socket has
 * already moved to CLOSING/CLOSED but the close event has not dispatched yet it
 * still reads true. The live `readyState` is the source of truth for
 * writability: `sendToServer` drops anything sent while it is not OPEN.
 */
export function isSocketWritable(socket: WebSocket | null): boolean {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}
