import { DEFAULT_SERVER_URL } from "./runtime-state";
import type {
  ConnectionState,
  RoomSessionState,
  ShareState,
} from "./runtime-state";
import { validateServerUrl } from "./server-url";
import { shouldClearPendingLocalShareOnServerUrlChange } from "./room-state";

export function createServerUrlController(args: {
  connectionState: ConnectionState;
  roomSessionState: RoomSessionState;
  shareState: ShareState;
  persistProfileState: () => Promise<void>;
  notifyAll: () => void;
  connect: () => Promise<void>;
  resetReconnectState: () => void;
  stopClockSyncTimer: () => void;
  clearPendingLocalShare: (reason: string) => void;
  log: (scope: "background", message: string) => void;
  logInvalidServerUrl: (context: string, invalidUrl: string) => void;
}) {
  return {
    async updateServerUrl(nextServerUrl: string): Promise<void> {
      const serverUrlResult = validateServerUrl(nextServerUrl);
      if ("message" in serverUrlResult) {
        args.connectionState.lastError = serverUrlResult.message;
        args.logInvalidServerUrl(
          "update-server-url",
          nextServerUrl.trim() || DEFAULT_SERVER_URL,
        );
        args.notifyAll();
        return;
      }

      const normalized = serverUrlResult.normalizedUrl;
      if (normalized === args.connectionState.serverUrl) {
        return;
      }

      if (
        shouldClearPendingLocalShareOnServerUrlChange({
          currentServerUrl: args.connectionState.serverUrl,
          nextServerUrl: normalized,
          pendingLocalShareUrl: args.shareState.pendingLocalShareUrl,
        })
      ) {
        args.clearPendingLocalShare("server URL changed");
      }

      args.connectionState.serverUrl = normalized;
      args.connectionState.lastError = null;
      await args.persistProfileState();
      args.log(
        "background",
        `Server URL updated to ${args.connectionState.serverUrl}`,
      );

      if (args.connectionState.socket) {
        args.resetReconnectState();
        args.stopClockSyncTimer();
        const currentSocket = args.connectionState.socket;
        args.connectionState.socket = null;
        args.connectionState.connected = false;
        currentSocket.close();
      }

      if (
        args.roomSessionState.roomCode ||
        args.roomSessionState.pendingCreateRoom
      ) {
        await args.connect();
      }
      args.notifyAll();
    },
  };
}
