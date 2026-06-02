import assert from "node:assert/strict";
import test from "node:test";
import {
  applyIncomingPopupState,
  createPopupStateSyncState,
  getNextPopupRoomTrackingState,
} from "../src/popup/state-sync";
import type { BackgroundPopupState } from "../src/shared/messages";
import { createInitialVoiceRuntimeState } from "../src/shared/voice-state";

function createPopupState(
  roomCode: string | null,
  overrides: Partial<BackgroundPopupState> = {},
): BackgroundPopupState {
  return {
    connected: Boolean(roomCode),
    serverUrl: "ws://localhost:8787",
    error: null,
    roomCode,
    joinToken: roomCode ? `join-${roomCode}` : null,
    memberId: roomCode ? `member-${roomCode}` : null,
    displayName: null,
    roomState: roomCode
      ? {
          roomCode,
          sharedVideo: null,
          playback: null,
          members: [],
        }
      : null,
    pendingCreateRoom: false,
    pendingJoinRoomCode: null,
    retryInMs: null,
    retryAttempt: 0,
    retryAttemptMax: 5,
    clockOffsetMs: null,
    rttMs: null,
    voice: createInitialVoiceRuntimeState(),
    logs: [],
    ...overrides,
  };
}

test("query snapshot is ignored after a newer port snapshot has been received", () => {
  const state = createPopupStateSyncState();
  const newerState = createPopupState("ROOM02");
  const olderQueryState = createPopupState("ROOM01");

  assert.equal(applyIncomingPopupState(state, newerState, "port"), true);
  assert.equal(applyIncomingPopupState(state, olderQueryState, "query"), false);
  assert.equal(state.popupState?.roomCode, "ROOM02");
});

test("query snapshot is accepted as fallback before any port snapshot arrives", () => {
  const state = createPopupStateSyncState();
  const initialState = createPopupState("ROOM01");

  assert.equal(applyIncomingPopupState(state, initialState, "query"), true);
  assert.equal(state.popupState?.roomCode, "ROOM01");
  assert.equal(state.hasReceivedPortState, false);
});

test("room tracking does not start the leave guard for an already joined room", () => {
  const nextState = getNextPopupRoomTrackingState(
    {
      roomActionPending: false,
      localRoomEntryPending: false,
      lastKnownPendingCreateRoom: false,
      lastKnownPendingJoinRoomCode: null,
      lastKnownRoomCode: null,
      lastRoomEnteredAt: 0,
    },
    createPopupState("ROOM01"),
    1000,
  );

  assert.equal(nextState.lastKnownRoomCode, "ROOM01");
  assert.equal(nextState.lastRoomEnteredAt, 0);
});

test("room tracking starts the leave guard after a local join resolves", () => {
  const nextState = getNextPopupRoomTrackingState(
    {
      roomActionPending: false,
      localRoomEntryPending: false,
      lastKnownPendingCreateRoom: false,
      lastKnownPendingJoinRoomCode: "ROOM01",
      lastKnownRoomCode: null,
      lastRoomEnteredAt: 0,
    },
    createPopupState("ROOM01", { pendingJoinRoomCode: null }),
    1000,
  );

  assert.equal(nextState.lastKnownRoomCode, "ROOM01");
  assert.equal(nextState.lastKnownPendingJoinRoomCode, null);
  assert.equal(nextState.localRoomEntryPending, false);
  assert.equal(nextState.lastRoomEnteredAt, 1000);
});

test("room tracking keeps local create intent until the created room arrives", () => {
  const pendingState = getNextPopupRoomTrackingState(
    {
      roomActionPending: true,
      localRoomEntryPending: true,
      lastKnownPendingCreateRoom: false,
      lastKnownPendingJoinRoomCode: null,
      lastKnownRoomCode: null,
      lastRoomEnteredAt: 0,
    },
    createPopupState(null, { pendingCreateRoom: false }),
    1000,
  );

  assert.equal(pendingState.localRoomEntryPending, true);
  assert.equal(pendingState.lastKnownRoomCode, null);
  assert.equal(pendingState.lastRoomEnteredAt, 0);

  const enteredState = getNextPopupRoomTrackingState(
    {
      roomActionPending: false,
      localRoomEntryPending: pendingState.localRoomEntryPending,
      lastKnownPendingCreateRoom: pendingState.lastKnownPendingCreateRoom,
      lastKnownPendingJoinRoomCode: pendingState.lastKnownPendingJoinRoomCode,
      lastKnownRoomCode: pendingState.lastKnownRoomCode,
      lastRoomEnteredAt: pendingState.lastRoomEnteredAt,
    },
    createPopupState("ROOM01"),
    2000,
  );

  assert.equal(enteredState.localRoomEntryPending, false);
  assert.equal(enteredState.lastKnownRoomCode, "ROOM01");
  assert.equal(enteredState.lastRoomEnteredAt, 2000);
});
