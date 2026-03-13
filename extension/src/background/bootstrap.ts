import type { RoomState } from "@bili-syncplay/protocol";
import type { DebugLogEntry } from "../shared/messages";
import { resolvePersistedServerUrl } from "./server-url";
import type { PersistedBackgroundSnapshot } from "./storage-manager";

export interface BootstrapMutableState {
  roomCode: string | null;
  joinToken: string | null;
  memberToken: string | null;
  memberId: string | null;
  displayName: string | null;
  roomState: RoomState | null;
  serverUrl: string;
  lastError: string | null;
  sharedTabId: number | null;
}

export async function bootstrapBackground(args: {
  state: BootstrapMutableState;
  loadPersistedBackgroundSnapshot: () => Promise<PersistedBackgroundSnapshot>;
  connect: () => void;
  log: (scope: DebugLogEntry["scope"], message: string) => void;
  broadcastPopupState: () => void;
  addTabRemovedListener: (listener: (tabId: number) => void) => void;
}): Promise<void> {
  const persisted = await args.loadPersistedBackgroundSnapshot();
  args.state.roomCode = persisted.roomCode;
  args.state.joinToken = persisted.joinToken;
  args.state.memberToken = persisted.memberToken;
  args.state.memberId = persisted.memberId;
  args.state.displayName = persisted.displayName;
  args.state.roomState = persisted.roomState;

  const persistedServerUrl = resolvePersistedServerUrl(persisted.serverUrl);
  args.state.serverUrl = persistedServerUrl.serverUrl;
  args.state.lastError = persistedServerUrl.lastError;
  if (args.state.roomCode && persistedServerUrl.shouldAutoConnect) {
    args.connect();
  } else if (args.state.roomCode && persistedServerUrl.lastError) {
    args.log("background", `Skipped reconnect because persisted server URL is invalid: ${args.state.serverUrl}`);
  }

  args.addTabRemovedListener((tabId) => {
    if (args.state.sharedTabId === tabId) {
      args.state.sharedTabId = null;
      args.log("background", `Cleared shared tab binding for closed tab ${tabId}`);
      args.broadcastPopupState();
    }
  });
}
