import type { RoomState } from "@bili-syncplay/protocol";

export interface PersistedState {
  roomCode: string | null;
  joinToken: string | null;
  memberToken: string | null;
  memberId: string | null;
  displayName: string | null;
  roomState: RoomState | null;
  serverUrl: string | null;
}

interface StoredSession {
  roomCode: string | null;
  joinToken: string | null;
  memberToken: string | null;
  memberId: string | null;
  roomState: RoomState | null;
}

interface StoredProfile {
  displayName: string | null;
  serverUrl: string | null;
}

const SESSION_KEY = "bili-syncplay-session";
const PROFILE_KEY = "bili-syncplay-profile";

export async function loadState(): Promise<PersistedState> {
  const [sessionResult, profileResult] = await Promise.all([
    chrome.storage.session.get<Record<string, StoredSession | undefined>>(
      SESSION_KEY,
    ),
    chrome.storage.local.get<Record<string, StoredProfile | undefined>>(
      PROFILE_KEY,
    ),
  ]);

  return {
    roomCode: sessionResult[SESSION_KEY]?.roomCode ?? null,
    joinToken: sessionResult[SESSION_KEY]?.joinToken ?? null,
    memberToken: sessionResult[SESSION_KEY]?.memberToken ?? null,
    memberId: sessionResult[SESSION_KEY]?.memberId ?? null,
    roomState: sessionResult[SESSION_KEY]?.roomState ?? null,
    displayName: profileResult[PROFILE_KEY]?.displayName ?? null,
    serverUrl: profileResult[PROFILE_KEY]?.serverUrl ?? null,
  };
}

export async function saveState(value: PersistedState): Promise<void> {
  await Promise.all([
    chrome.storage.session.set({
      [SESSION_KEY]: {
        roomCode: value.roomCode,
        joinToken: value.joinToken,
        memberToken: value.memberToken,
        memberId: value.memberId,
        roomState: value.roomState,
      },
    }),
    chrome.storage.local.set({
      [PROFILE_KEY]: {
        displayName: value.displayName,
        serverUrl: value.serverUrl,
      },
    }),
  ]);
}
