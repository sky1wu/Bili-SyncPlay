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

export interface PersistedSessionState {
  roomCode: string | null;
  joinToken: string | null;
  memberToken: string | null;
  memberId: string | null;
  roomState: RoomState | null;
}

export interface PersistedProfileState {
  displayName: string | null;
  serverUrl: string | null;
}

const SESSION_KEY = "bili-syncplay-session";
const PROFILE_KEY = "bili-syncplay-profile";

export async function loadState(): Promise<PersistedState> {
  const [session, profile] = await Promise.all([
    loadSessionState(),
    loadProfileState(),
  ]);

  return {
    roomCode: session.roomCode,
    joinToken: session.joinToken,
    memberToken: session.memberToken,
    memberId: session.memberId,
    roomState: session.roomState,
    displayName: profile.displayName,
    serverUrl: profile.serverUrl,
  };
}

export async function loadSessionState(): Promise<PersistedSessionState> {
  const sessionResult =
    await chrome.storage.session.get<Record<string, StoredSession | undefined>>(
      SESSION_KEY,
    );

  return {
    roomCode: sessionResult[SESSION_KEY]?.roomCode ?? null,
    joinToken: sessionResult[SESSION_KEY]?.joinToken ?? null,
    memberToken: sessionResult[SESSION_KEY]?.memberToken ?? null,
    memberId: sessionResult[SESSION_KEY]?.memberId ?? null,
    roomState: sessionResult[SESSION_KEY]?.roomState ?? null,
  };
}

export async function loadProfileState(): Promise<PersistedProfileState> {
  const profileResult =
    await chrome.storage.local.get<Record<string, StoredProfile | undefined>>(
      PROFILE_KEY,
    );

  return {
    displayName: profileResult[PROFILE_KEY]?.displayName ?? null,
    serverUrl: profileResult[PROFILE_KEY]?.serverUrl ?? null,
  };
}

export async function saveSessionState(
  value: PersistedSessionState,
): Promise<void> {
  await chrome.storage.session.set({
    [SESSION_KEY]: {
      roomCode: value.roomCode,
      joinToken: value.joinToken,
      memberToken: value.memberToken,
      memberId: value.memberId,
      roomState: value.roomState,
    },
  });
}

export async function saveProfileState(
  value: PersistedProfileState,
): Promise<void> {
  await chrome.storage.local.set({
    [PROFILE_KEY]: {
      displayName: value.displayName,
      serverUrl: value.serverUrl,
    },
  });
}
