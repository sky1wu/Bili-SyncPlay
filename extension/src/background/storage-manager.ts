import type { RoomState } from "@bili-syncplay/protocol";
import {
  loadState,
  saveProfileState,
  saveSessionState,
} from "../shared/storage";
import type { BackgroundRuntimeState } from "./runtime-state";

export interface PersistedBackgroundSnapshot {
  roomCode: string | null;
  joinToken: string | null;
  memberToken: string | null;
  memberId: string | null;
  displayName: string | null;
  roomState: RoomState | null;
  serverUrl: string | null;
}

export async function loadPersistedBackgroundSnapshot(): Promise<PersistedBackgroundSnapshot> {
  const persisted = await loadState();
  return {
    roomCode: persisted.roomCode,
    joinToken: persisted.joinToken,
    memberToken: persisted.memberToken,
    memberId: persisted.memberId,
    displayName: persisted.displayName,
    roomState: persisted.roomState,
    serverUrl: persisted.serverUrl ?? null,
  };
}

export async function persistBackgroundState(
  state: BackgroundRuntimeState,
): Promise<void> {
  await saveSessionState({
    roomCode: state.room.roomCode,
    joinToken: state.room.joinToken,
    memberToken: state.room.memberToken,
    memberId: state.room.memberId,
    roomState: state.room.roomState,
  });
}

export async function persistBackgroundProfile(
  state: BackgroundRuntimeState,
): Promise<void> {
  await saveProfileState({
    displayName: state.room.displayName,
    serverUrl: state.connection.serverUrl,
  });
}
