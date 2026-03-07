import type { RoomState } from "@bili-syncplay/protocol";

export interface PersistedState {
  roomCode: string | null;
  memberId: string | null;
  displayName: string | null;
  roomState: RoomState | null;
  serverUrl: string | null;
}

const SESSION_KEY = "bili-syncplay-session";
const PROFILE_KEY = "bili-syncplay-profile";

export async function loadState(): Promise<PersistedState> {
  const [sessionResult, profileResult] = await Promise.all([
    chrome.storage.session.get(SESSION_KEY),
    chrome.storage.local.get(PROFILE_KEY)
  ]);

  return {
    roomCode: sessionResult[SESSION_KEY]?.roomCode ?? null,
    memberId: sessionResult[SESSION_KEY]?.memberId ?? null,
    roomState: sessionResult[SESSION_KEY]?.roomState ?? null,
    displayName: profileResult[PROFILE_KEY]?.displayName ?? null,
    serverUrl: profileResult[PROFILE_KEY]?.serverUrl ?? null
  };
}

export async function saveState(value: PersistedState): Promise<void> {
  await Promise.all([
    chrome.storage.session.set({
      [SESSION_KEY]: {
        roomCode: value.roomCode,
        memberId: value.memberId,
        roomState: value.roomState
      }
    }),
    chrome.storage.local.set({
      [PROFILE_KEY]: {
        displayName: value.displayName,
        serverUrl: value.serverUrl
      }
    })
  ]);
}
