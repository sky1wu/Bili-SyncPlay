import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION,
  type RoomState,
  type ServerMessage,
} from "@bili-syncplay/protocol";
import { createBackgroundRuntimeState } from "../src/background/runtime-state";
import { createRoomSessionController } from "../src/background/room-session-controller";
import { getActivePendingLocalShareUrl } from "../src/background/room-state";
import { setLocaleForTests } from "../src/shared/i18n";

function createControllerHarness(options?: {
  bootstrapRoomStateTimeoutMs?: number;
  persistState?: (callCount: number) => Promise<void> | void;
  getMonotonicNow?: () => number;
  getActivePendingLocalShareUrl?: () => string | null;
  onEnsureSharedVideoOpen?: () => void;
  getJoinRetryDelayMs?: (attempt: number) => number;
}) {
  const runtimeState = createBackgroundRuntimeState();
  const sendToServerCalls: Array<unknown> = [];
  const notifyContentMessages: Array<unknown> = [];
  const persistReasons: string[] = [];
  const logs: string[] = [];
  const ensureSharedVideoOpenCalls: RoomState[] = [];
  const clearPendingLocalShareReasons: string[] = [];
  const compensateCalls: Array<{
    state: RoomState;
    anchorAtMs: number | undefined;
  }> = [];
  const arrivalMarks: Array<{
    currentTime: number | undefined;
    atMs: number;
    persistCallsSoFar: number;
  }> = [];
  const roomLifecycleResets: Array<{ action: string; reason: string }> = [];
  let connectCalls = 0;
  let disconnectCalls = 0;
  let notifyAllCalls = 0;
  let resetReconnectCalls = 0;

  const controller = createRoomSessionController({
    connectionState: runtimeState.connection,
    roomSessionState: runtimeState.room,
    shareState: runtimeState.share,
    log: (_scope, message) => {
      logs.push(message);
    },
    notifyAll: () => {
      notifyAllCalls += 1;
    },
    persistState: async () => {
      persistReasons.push("persisted");
      await options?.persistState?.(persistReasons.length);
    },
    sendToServer: (message) => {
      sendToServerCalls.push(message);
    },
    connect: async () => {
      connectCalls += 1;
      runtimeState.connection.connected = true;
    },
    disconnectSocket: () => {
      disconnectCalls += 1;
    },
    resetReconnectState: () => {
      resetReconnectCalls += 1;
    },
    resetRoomLifecycleTransientState: (action, reason) => {
      roomLifecycleResets.push({ action, reason });
    },
    flushPendingShare: () => {
      logs.push("flushed-pending-share");
    },
    ensureSharedVideoOpen: async (state) => {
      ensureSharedVideoOpenCalls.push(state);
      options?.onEnsureSharedVideoOpen?.();
    },
    notifyContentScripts: async (message) => {
      notifyContentMessages.push(message);
    },
    compensateRoomState: (state, anchorAtMs) => {
      compensateCalls.push({ state, anchorAtMs });
      return state;
    },
    markPlaybackArrival: (playback, atMs) => {
      arrivalMarks.push({
        currentTime: playback?.currentTime,
        atMs,
        persistCallsSoFar: persistReasons.length,
      });
    },
    clearPendingLocalShare: (reason) => {
      clearPendingLocalShareReasons.push(reason);
      runtimeState.share.pendingLocalShareUrl = null;
      runtimeState.share.pendingLocalShareExpiresAt = null;
    },
    expirePendingLocalShareIfNeeded: () => {},
    // Stands in for the share controller, which owns the marker's clock. The
    // default reproduces the wall-clock expiry the older tests below set up; a
    // test that cares which clock answers overrides it.
    getActivePendingLocalShareUrl:
      options?.getActivePendingLocalShareUrl ??
      (() =>
        getActivePendingLocalShareUrl({
          pendingLocalShareUrl: runtimeState.share.pendingLocalShareUrl,
          pendingLocalShareExpiresAt:
            runtimeState.share.pendingLocalShareExpiresAt,
          now: Date.now(),
        })),
    normalizeUrl: (url) => url?.trim() ?? null,
    logServerError: (code, message) => {
      logs.push(`server-error:${code}:${message}`);
    },
    shareToastTtlMs: 8_000,
    getMonotonicNow: options?.getMonotonicNow,
    bootstrapRoomStateTimeoutMs: options?.bootstrapRoomStateTimeoutMs,
    getJoinRetryDelayMs: options?.getJoinRetryDelayMs,
  });

  return {
    runtimeState,
    controller,
    sendToServerCalls,
    notifyContentMessages,
    persistReasons,
    logs,
    ensureSharedVideoOpenCalls,
    clearPendingLocalShareReasons,
    compensateCalls,
    arrivalMarks,
    roomLifecycleResets,
    get connectCalls() {
      return connectCalls;
    },
    get disconnectCalls() {
      return disconnectCalls;
    },
    get notifyAllCalls() {
      return notifyAllCalls;
    },
    get resetReconnectCalls() {
      return resetReconnectCalls;
    },
  };
}

test("room session controller sends create request with protocolVersion", async () => {
  const harness = createControllerHarness();
  harness.runtimeState.room.displayName = "Bob";

  await harness.controller.requestCreateRoom();

  assert.equal(harness.connectCalls, 1);
  assert.equal(harness.runtimeState.room.pendingCreateRoom, false);
  assert.equal(harness.sendToServerCalls.length, 1);
  assert.deepEqual(harness.sendToServerCalls[0], {
    type: "room:create",
    payload: {
      displayName: "Bob",
      protocolVersion: PROTOCOL_VERSION,
    },
  });
});

test("room session controller clears pending join on unsupported_protocol_version error", async () => {
  const harness = createControllerHarness();
  harness.runtimeState.room.pendingJoinRoomCode = "ROOM-PV";
  harness.runtimeState.room.pendingJoinToken = "join-token-pv";
  harness.runtimeState.room.pendingJoinRequestGeneration = 0;

  const resultPromise = harness.controller.waitForJoinAttemptResult(50);
  await harness.controller.handleServerMessage({
    type: "error",
    payload: {
      code: "unsupported_protocol_version",
      message: "Your extension version is too old.",
    },
  } satisfies ServerMessage);

  assert.equal(await resultPromise, "failed");
  assert.equal(harness.runtimeState.room.pendingJoinRoomCode, null);
  assert.equal(harness.runtimeState.room.pendingJoinToken, null);
  assert.equal(harness.runtimeState.room.pendingJoinRequestGeneration, null);
  assert.equal(harness.runtimeState.room.roomCode, null);
});

test("room session controller clears stored room on unsupported_protocol_version error", async () => {
  const harness = createControllerHarness();
  harness.runtimeState.room.roomCode = "ROOM-ST";
  harness.runtimeState.room.joinToken = "join-token-st";
  harness.runtimeState.room.memberToken = "member-token-st";
  harness.runtimeState.room.memberId = "member-st";
  harness.runtimeState.room.pendingJoinRequestGeneration = 0;
  setLocaleForTests("en-US");

  try {
    await harness.controller.handleServerMessage({
      type: "error",
      payload: {
        code: "unsupported_protocol_version",
        message: "Your extension version is too old.",
      },
    } satisfies ServerMessage);
  } finally {
    setLocaleForTests(null);
  }

  assert.equal(harness.runtimeState.room.roomCode, null);
  assert.equal(harness.runtimeState.room.joinToken, null);
  assert.equal(harness.runtimeState.room.memberToken, null);
  assert.equal(harness.runtimeState.room.memberId, null);
  assert.equal(harness.runtimeState.room.roomState, null);
  assert.equal(
    harness.runtimeState.connection.lastError,
    "Your extension version is too old. Please update Bili-SyncPlay to the latest version.",
  );
});

test("room session controller sends join request after connect and normalizes pending room data", async () => {
  const harness = createControllerHarness();
  harness.runtimeState.room.displayName = "Alice";
  harness.runtimeState.room.memberToken = "member-token-1";

  await harness.controller.requestJoinRoom(" room01 ", " token-1 ");

  assert.equal(harness.connectCalls, 1);
  assert.equal(harness.runtimeState.room.pendingJoinRoomCode, "ROOM01");
  assert.equal(harness.runtimeState.room.pendingJoinToken, "token-1");
  assert.equal(harness.runtimeState.room.pendingJoinRequestGeneration, 0);
  assert.equal(harness.sendToServerCalls.length, 1);
  assert.deepEqual(harness.sendToServerCalls[0], {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "token-1",
      displayName: "Alice",
      protocolVersion: PROTOCOL_VERSION,
    },
  });
  assert.equal(harness.persistReasons.length, 1);
  assert.deepEqual(harness.roomLifecycleResets, [
    { action: "join-room", reason: "join room requested" },
  ]);
});

test("room session controller resolves failed join attempts and clears stale room context on server error", async () => {
  const harness = createControllerHarness();
  harness.runtimeState.room.pendingJoinRoomCode = "ROOM02";
  harness.runtimeState.room.pendingJoinToken = "join-token-2";
  harness.runtimeState.room.pendingJoinRequestGeneration = 0;
  harness.runtimeState.room.roomCode = "ROOM02";
  harness.runtimeState.room.joinToken = "join-token-2";
  harness.runtimeState.room.memberToken = "member-token-2";
  harness.runtimeState.room.memberId = "member-2";

  const resultPromise = harness.controller.waitForJoinAttemptResult(50);
  await harness.controller.handleServerMessage({
    type: "error",
    payload: {
      code: "room_not_found",
      message: "The room was not found.",
    },
  } satisfies ServerMessage);

  assert.equal(await resultPromise, "failed");
  assert.equal(harness.runtimeState.room.pendingJoinRoomCode, null);
  assert.equal(harness.runtimeState.room.pendingJoinToken, null);
  assert.equal(harness.runtimeState.room.pendingJoinRequestGeneration, null);
  assert.equal(harness.runtimeState.room.roomCode, null);
  assert.equal(harness.runtimeState.room.memberToken, null);
  assert.equal(
    harness.runtimeState.connection.lastError,
    "The room was not found.",
  );
  assert.equal(harness.persistReasons.length, 1);
  assert.equal(harness.notifyAllCalls, 1);
});

test("room session controller treats room_full as terminal for pending and stored joins", async () => {
  const pending = createControllerHarness();
  pending.runtimeState.room.pendingJoinRoomCode = "ROOM02";
  pending.runtimeState.room.pendingJoinToken = "join-token-2";
  pending.runtimeState.room.pendingJoinRequestGeneration = 0;

  await pending.controller.handleServerMessage({
    type: "error",
    payload: {
      code: "room_full",
      message: "Room is full.",
    },
  } satisfies ServerMessage);

  assert.equal(pending.runtimeState.room.pendingJoinRoomCode, null);
  assert.equal(pending.runtimeState.room.pendingJoinToken, null);
  assert.equal(pending.runtimeState.room.pendingJoinRequestGeneration, null);
  assert.equal(pending.persistReasons.length, 1);

  const stored = createControllerHarness();
  stored.runtimeState.room.roomCode = "ROOM03";
  stored.runtimeState.room.joinToken = "join-token-3";
  stored.runtimeState.room.memberToken = "member-token-3";
  stored.runtimeState.room.pendingJoinRequestGeneration = 0;

  await stored.controller.handleServerMessage({
    type: "error",
    payload: {
      code: "room_full",
      message: "Room is full.",
    },
  } satisfies ServerMessage);

  assert.equal(stored.runtimeState.room.roomCode, null);
  assert.equal(stored.runtimeState.room.joinToken, null);
  assert.equal(stored.runtimeState.room.memberToken, null);
  assert.equal(stored.runtimeState.room.pendingJoinRequestGeneration, null);
  assert.equal(stored.persistReasons.length, 1);
});

test("room session controller retries an unconfirmed pending join without discarding its intent", async () => {
  const harness = createControllerHarness({ getJoinRetryDelayMs: () => 0 });
  harness.runtimeState.connection.connected = true;
  harness.runtimeState.room.pendingJoinRoomCode = "ROOM05";
  harness.runtimeState.room.pendingJoinToken = "join-token-5";
  harness.runtimeState.room.pendingJoinRequestGeneration = 0;

  await harness.controller.handleServerMessage({
    type: "error",
    payload: {
      code: "room_resolution_unconfirmed",
      message: "Internal server error.",
    },
  } satisfies ServerMessage);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(harness.runtimeState.room.pendingJoinRoomCode, "ROOM05");
  assert.equal(harness.runtimeState.room.pendingJoinToken, "join-token-5");
  assert.equal(harness.runtimeState.room.pendingJoinRequestGeneration, 0);
  assert.deepEqual(harness.sendToServerCalls, [
    {
      type: "room:join",
      payload: {
        roomCode: "ROOM05",
        joinToken: "join-token-5",
        displayName: undefined,
        protocolVersion: PROTOCOL_VERSION,
      },
    },
  ]);
  assert.equal(harness.persistReasons.length, 0);
  assert.equal(harness.disconnectCalls, 0);
});

test("an old member-token error cannot schedule over a replacement socket join", async () => {
  let markPersistStarted!: () => void;
  let releasePersist!: () => void;
  const persistStarted = new Promise<void>((resolve) => {
    markPersistStarted = resolve;
  });
  const persistGate = new Promise<void>((resolve) => {
    releasePersist = resolve;
  });
  const harness = createControllerHarness({
    getJoinRetryDelayMs: () => 0,
    async persistState(callCount) {
      if (callCount === 1) {
        markPersistStarted();
        await persistGate;
      }
    },
  });
  harness.runtimeState.connection.connected = true;
  harness.runtimeState.room.pendingJoinRoomCode = "ROOM05";
  harness.runtimeState.room.pendingJoinToken = "join-token-5";
  harness.runtimeState.room.pendingJoinRequestGeneration = 0;
  harness.runtimeState.room.memberToken = "member-token-old";

  const handlingOldError = harness.controller.handleServerMessage({
    type: "error",
    payload: {
      code: "member_token_invalid",
      message: "Member token is invalid.",
    },
  } satisfies ServerMessage);
  await persistStarted;

  harness.runtimeState.connection.socketGeneration = 1;
  harness.controller.sendJoinRequest("ROOM05", "join-token-5");
  releasePersist();
  await handlingOldError;
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(harness.runtimeState.room.pendingJoinRequestGeneration, 1);
  assert.equal(harness.sendToServerCalls.length, 1);
});

test("an old member-token error cannot schedule over a newer popup join", async () => {
  let markPersistStarted!: () => void;
  let releasePersist!: () => void;
  const persistStarted = new Promise<void>((resolve) => {
    markPersistStarted = resolve;
  });
  const persistGate = new Promise<void>((resolve) => {
    releasePersist = resolve;
  });
  const harness = createControllerHarness({
    getJoinRetryDelayMs: () => 0,
    async persistState(callCount) {
      if (callCount === 1) {
        markPersistStarted();
        await persistGate;
      }
    },
  });
  harness.runtimeState.connection.connected = true;
  harness.runtimeState.room.pendingJoinRoomCode = "ROOM05";
  harness.runtimeState.room.pendingJoinToken = "join-token-5";
  harness.runtimeState.room.pendingJoinRequestGeneration = 0;
  harness.runtimeState.room.memberToken = "member-token-old";

  const handlingOldError = harness.controller.handleServerMessage({
    type: "error",
    payload: {
      code: "member_token_invalid",
      message: "Member token is invalid.",
    },
  } satisfies ServerMessage);
  await persistStarted;

  await harness.controller.requestJoinRoom("ROOM06", "join-token-6");
  releasePersist();
  await handlingOldError;
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(harness.runtimeState.room.pendingJoinRoomCode, "ROOM06");
  assert.equal(harness.runtimeState.room.pendingJoinToken, "join-token-6");
  assert.equal(harness.runtimeState.room.pendingJoinRequestGeneration, 0);
  assert.equal(harness.sendToServerCalls.length, 1);
});

test("room session controller keeps retrying when an unconfirmed join is rate limited", async () => {
  const harness = createControllerHarness({ getJoinRetryDelayMs: () => 0 });
  harness.runtimeState.connection.connected = true;
  harness.runtimeState.room.pendingJoinRoomCode = "ROOM05";
  harness.runtimeState.room.pendingJoinToken = "join-token-5";
  harness.runtimeState.room.pendingJoinRequestGeneration = 0;

  await harness.controller.handleServerMessage({
    type: "error",
    payload: {
      code: "room_resolution_unconfirmed",
      message: "Internal server error.",
    },
  } satisfies ServerMessage);
  await new Promise((resolve) => setTimeout(resolve, 5));

  await harness.controller.handleServerMessage({
    type: "error",
    payload: {
      code: "rate_limited",
      message: "Rate limit exceeded. Please retry later.",
    },
  } satisfies ServerMessage);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(harness.runtimeState.room.pendingJoinRoomCode, "ROOM05");
  assert.equal(harness.runtimeState.room.pendingJoinToken, "join-token-5");
  assert.equal(harness.runtimeState.room.pendingJoinRequestGeneration, 0);
  const expectedJoinRequest = {
    type: "room:join",
    payload: {
      roomCode: "ROOM05",
      joinToken: "join-token-5",
      displayName: undefined,
      protocolVersion: PROTOCOL_VERSION,
    },
  };
  assert.deepEqual(harness.sendToServerCalls, [
    expectedJoinRequest,
    expectedJoinRequest,
  ]);
  assert.equal(harness.persistReasons.length, 0);
  assert.equal(harness.disconnectCalls, 0);
});

test("room session controller replaces an old retry timer after reconnect", async () => {
  const harness = createControllerHarness({
    getJoinRetryDelayMs: (attempt) => (attempt === 1 ? 10 : 100),
  });
  harness.runtimeState.connection.connected = true;
  harness.runtimeState.room.pendingJoinRoomCode = "ROOM05";
  harness.runtimeState.room.pendingJoinToken = "join-token-5";
  harness.runtimeState.room.pendingJoinRequestGeneration = 0;

  await harness.controller.handleServerMessage({
    type: "error",
    payload: {
      code: "room_resolution_unconfirmed",
      message: "Internal server error.",
    },
  } satisfies ServerMessage);

  // A replacement socket resends before the first timer expires, then receives
  // another transient response that owns a later backoff.
  harness.runtimeState.connection.socketGeneration = 1;
  harness.controller.sendJoinRequest("ROOM05", "join-token-5");
  await harness.controller.handleServerMessage({
    type: "error",
    payload: {
      code: "room_resolution_unconfirmed",
      message: "Internal server error.",
    },
  } satisfies ServerMessage);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(harness.sendToServerCalls.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(harness.sendToServerCalls.length, 2);
  assert.equal(harness.runtimeState.room.pendingJoinRequestGeneration, 1);
});

test("room session controller retries unconfirmed restoration of a stored room", async () => {
  const harness = createControllerHarness({ getJoinRetryDelayMs: () => 0 });
  harness.runtimeState.connection.connected = true;
  harness.runtimeState.room.roomCode = "ROOM06";
  harness.runtimeState.room.joinToken = "join-token-6";
  harness.runtimeState.room.memberToken = "member-token-6";
  harness.runtimeState.room.pendingJoinRequestGeneration = 0;

  await harness.controller.handleServerMessage({
    type: "error",
    payload: {
      code: "room_resolution_unconfirmed",
      message: "Internal server error.",
    },
  } satisfies ServerMessage);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(harness.runtimeState.room.roomCode, "ROOM06");
  assert.equal(harness.runtimeState.room.memberToken, "member-token-6");
  assert.equal(harness.runtimeState.room.pendingJoinRequestGeneration, 0);
  assert.deepEqual(harness.sendToServerCalls, [
    {
      type: "room:join",
      payload: {
        roomCode: "ROOM06",
        joinToken: "join-token-6",
        memberToken: "member-token-6",
        displayName: undefined,
        protocolVersion: PROTOCOL_VERSION,
      },
    },
  ]);
  assert.equal(harness.persistReasons.length, 0);
  assert.equal(harness.disconnectCalls, 0);
});

test("room session controller confirms pending local share and notifies content on matching room state", async () => {
  const harness = createControllerHarness();
  harness.runtimeState.share.pendingLocalShareUrl =
    "https://www.bilibili.com/video/BV1xx411c7mD?p=2";
  harness.runtimeState.share.pendingLocalShareExpiresAt = Date.now() + 5_000;

  const nextRoomState: RoomState = {
    roomCode: "ROOM03",
    sharedVideo: {
      videoId: "BV1xx411c7mD",
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
      title: "Shared Video",
      sharedByMemberId: "member-3",
    },
    playback: null,
    members: [{ id: "member-3", name: "Alice" }],
  };

  await harness.controller.handleServerMessage({
    type: "room:state",
    payload: nextRoomState,
  } satisfies ServerMessage);

  assert.deepEqual(harness.clearPendingLocalShareReasons, [
    "share confirmation received",
  ]);
  assert.equal(harness.runtimeState.room.roomCode, "ROOM03");
  // Not identity: the payload's `playbackAgeMs` is stripped before the state is
  // stored, so what is stored is a copy of everything else.
  assert.deepEqual(harness.runtimeState.room.roomState, nextRoomState);
  assert.equal(harness.ensureSharedVideoOpenCalls.length, 1);
  assert.equal(
    (
      harness.notifyContentMessages[0] as {
        type: string;
        payload: RoomState;
        shareToast: {
          title: string;
          videoUrl: string;
        } | null;
      }
    ).type,
    "background:apply-room-state",
  );
  assert.deepEqual(
    (
      harness.notifyContentMessages[0] as {
        payload: RoomState;
      }
    ).payload,
    nextRoomState,
  );
  assert.equal(
    (
      harness.notifyContentMessages[0] as {
        shareToast: {
          title: string;
          videoUrl: string;
        } | null;
      }
    ).shareToast?.title,
    "Shared Video",
  );
  assert.equal(
    (
      harness.notifyContentMessages[0] as {
        shareToast: {
          title: string;
          videoUrl: string;
        } | null;
      }
    ).shareToast?.videoUrl,
    "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
  );
  assert.equal(harness.notifyAllCalls, 1);
});

test("room session controller applies room member join and leave deltas", async () => {
  const harness = createControllerHarness();
  harness.runtimeState.room.roomState = {
    roomCode: "ROOM04",
    sharedVideo: null,
    playback: null,
    members: [{ id: "member-1", name: "Alice" }],
  };

  await harness.controller.handleServerMessage({
    type: "room:member-joined",
    payload: {
      roomCode: "ROOM04",
      member: { id: "member-2", name: "Bob" },
    },
  } satisfies ServerMessage);

  assert.deepEqual(harness.runtimeState.room.roomState.members, [
    { id: "member-1", name: "Alice" },
    { id: "member-2", name: "Bob" },
  ]);
  assert.equal(harness.persistReasons.length, 1);
  assert.equal(harness.notifyContentMessages.length, 1);

  await harness.controller.handleServerMessage({
    type: "room:member-left",
    payload: {
      roomCode: "ROOM04",
      member: { id: "member-2", name: "Bob" },
    },
  } satisfies ServerMessage);

  assert.deepEqual(harness.runtimeState.room.roomState.members, [
    { id: "member-1", name: "Alice" },
  ]);
  assert.equal(harness.persistReasons.length, 2);
  assert.equal(harness.notifyContentMessages.length, 2);
});

test("room session controller replays member deltas received before bootstrap state", async () => {
  const harness = createControllerHarness();

  await harness.controller.handleServerMessage({
    type: "room:created",
    payload: {
      roomCode: "ROOM04",
      joinToken: "join-token-4",
      memberToken: "member-token-4",
      memberId: "member-1",
    },
  } satisfies ServerMessage);

  await harness.controller.handleServerMessage({
    type: "room:member-joined",
    payload: {
      roomCode: "ROOM04",
      member: { id: "member-2", name: "Bob" },
    },
  } satisfies ServerMessage);
  await harness.controller.handleServerMessage({
    type: "room:member-left",
    payload: {
      roomCode: "ROOM04",
      member: { id: "member-1", name: "Alice" },
    },
  } satisfies ServerMessage);

  await harness.controller.handleServerMessage({
    type: "room:state",
    payload: {
      roomCode: "ROOM04",
      sharedVideo: null,
      playback: null,
      members: [{ id: "member-1", name: "Alice" }],
    },
  } satisfies ServerMessage);

  assert.deepEqual(harness.runtimeState.room.roomState?.members, [
    { id: "member-2", name: "Bob" },
  ]);
  assert.equal(harness.persistReasons.length, 2);
  assert.equal(harness.notifyContentMessages.length, 1);
});

test("room session controller releases queued reconnect deltas when bootstrap state times out", async () => {
  const harness = createControllerHarness({ bootstrapRoomStateTimeoutMs: 1 });
  harness.runtimeState.room.roomCode = "ROOM04";
  harness.runtimeState.room.roomState = {
    roomCode: "ROOM04",
    sharedVideo: {
      videoId: "BV1old",
      url: "https://www.bilibili.com/video/BV1old",
      title: "Old Video",
      sharedByMemberId: "member-1",
    },
    playback: null,
    members: [{ id: "member-1", name: "Alice" }],
  };

  await harness.controller.handleServerMessage({
    type: "room:joined",
    payload: {
      roomCode: "ROOM04",
      memberToken: "member-token-1",
      memberId: "member-1",
    },
  } satisfies ServerMessage);
  await harness.controller.handleServerMessage({
    type: "room:member-joined",
    payload: {
      roomCode: "ROOM04",
      member: { id: "member-2", name: "Bob" },
    },
  } satisfies ServerMessage);

  await new Promise((resolve) => globalThis.setTimeout(resolve, 10));

  assert.deepEqual(harness.runtimeState.room.roomState?.members, [
    { id: "member-1", name: "Alice" },
    { id: "member-2", name: "Bob" },
  ]);
  assert.equal(
    harness.runtimeState.room.roomState?.sharedVideo?.url,
    "https://www.bilibili.com/video/BV1old",
  );
  assert.equal(harness.persistReasons.length, 2);
  assert.equal(harness.notifyContentMessages.length, 1);

  await harness.controller.handleServerMessage({
    type: "room:member-left",
    payload: {
      roomCode: "ROOM04",
      member: { id: "member-2", name: "Bob" },
    },
  } satisfies ServerMessage);

  assert.deepEqual(harness.runtimeState.room.roomState?.members, [
    { id: "member-1", name: "Alice" },
  ]);
  assert.equal(harness.persistReasons.length, 3);
  assert.equal(harness.notifyContentMessages.length, 2);
});

test("room session controller does not let timeout replay overwrite a late bootstrap state", async () => {
  let resolveTimeoutPersistStarted: (() => void) | null = null;
  let releaseTimeoutPersist: (() => void) | null = null;
  const timeoutPersistStarted = new Promise<void>((resolve) => {
    resolveTimeoutPersistStarted = resolve;
  });
  const timeoutPersistRelease = new Promise<void>((resolve) => {
    releaseTimeoutPersist = resolve;
  });
  const harness = createControllerHarness({
    bootstrapRoomStateTimeoutMs: 1,
    async persistState(callCount) {
      if (callCount === 2) {
        resolveTimeoutPersistStarted?.();
        await timeoutPersistRelease;
      }
    },
  });
  harness.runtimeState.room.roomCode = "ROOM04";
  harness.runtimeState.room.roomState = {
    roomCode: "ROOM04",
    sharedVideo: {
      videoId: "BV1old",
      url: "https://www.bilibili.com/video/BV1old",
      title: "Old Video",
      sharedByMemberId: "member-1",
    },
    playback: null,
    members: [{ id: "member-1", name: "Alice" }],
  };

  await harness.controller.handleServerMessage({
    type: "room:joined",
    payload: {
      roomCode: "ROOM04",
      memberToken: "member-token-1",
      memberId: "member-1",
    },
  } satisfies ServerMessage);
  await harness.controller.handleServerMessage({
    type: "room:member-joined",
    payload: {
      roomCode: "ROOM04",
      member: { id: "member-2", name: "Bob" },
    },
  } satisfies ServerMessage);

  await Promise.race([
    timeoutPersistStarted,
    new Promise((_, reject) =>
      globalThis.setTimeout(
        () => reject(new Error("Timed out waiting for timeout persist")),
        50,
      ),
    ),
  ]);
  const freshBootstrapState: RoomState = {
    roomCode: "ROOM04",
    sharedVideo: {
      videoId: "BV1new",
      url: "https://www.bilibili.com/video/BV1new",
      title: "New Video",
      sharedByMemberId: "member-3",
    },
    playback: null,
    members: [
      { id: "member-1", name: "Alice" },
      { id: "member-3", name: "Carol" },
    ],
  };

  await harness.controller.handleServerMessage({
    type: "room:state",
    payload: freshBootstrapState,
  } satisfies ServerMessage);
  releaseTimeoutPersist?.();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

  assert.deepEqual(harness.runtimeState.room.roomState, freshBootstrapState);
  assert.equal(harness.notifyContentMessages.length, 1);
  assert.deepEqual(
    (
      harness.notifyContentMessages[0] as {
        payload: RoomState;
      }
    ).payload,
    freshBootstrapState,
  );
});

test("room session controller queues reconnect deltas until fresh bootstrap state", async () => {
  const harness = createControllerHarness();
  harness.runtimeState.room.roomCode = "ROOM04";
  harness.runtimeState.room.roomState = {
    roomCode: "ROOM04",
    sharedVideo: {
      videoId: "BV1old",
      url: "https://www.bilibili.com/video/BV1old",
      title: "Old Video",
      sharedByMemberId: "member-1",
    },
    playback: null,
    members: [{ id: "member-1", name: "Alice" }],
  };

  await harness.controller.handleServerMessage({
    type: "room:joined",
    payload: {
      roomCode: "ROOM04",
      memberToken: "member-token-1",
      memberId: "member-1",
    },
  } satisfies ServerMessage);
  await harness.controller.handleServerMessage({
    type: "room:member-joined",
    payload: {
      roomCode: "ROOM04",
      member: { id: "member-2", name: "Bob" },
    },
  } satisfies ServerMessage);

  assert.deepEqual(harness.runtimeState.room.roomState.members, [
    { id: "member-1", name: "Alice" },
  ]);
  assert.equal(
    harness.runtimeState.room.roomState.sharedVideo?.url,
    "https://www.bilibili.com/video/BV1old",
  );
  assert.equal(harness.persistReasons.length, 1);
  assert.equal(harness.notifyContentMessages.length, 0);

  await harness.controller.handleServerMessage({
    type: "room:state",
    payload: {
      roomCode: "ROOM04",
      sharedVideo: {
        videoId: "BV1new",
        url: "https://www.bilibili.com/video/BV1new",
        title: "New Video",
        sharedByMemberId: "member-2",
      },
      playback: null,
      members: [{ id: "member-1", name: "Alice" }],
    },
  } satisfies ServerMessage);

  assert.deepEqual(harness.runtimeState.room.roomState?.members, [
    { id: "member-1", name: "Alice" },
    { id: "member-2", name: "Bob" },
  ]);
  assert.equal(
    harness.runtimeState.room.roomState?.sharedVideo?.url,
    "https://www.bilibili.com/video/BV1new",
  );
  assert.equal(harness.persistReasons.length, 2);
  assert.equal(harness.notifyContentMessages.length, 1);
});

test("room session controller queues member deltas that arrive before room joined", async () => {
  const harness = createControllerHarness();
  harness.runtimeState.room.roomCode = "ROOM04";
  harness.runtimeState.room.pendingJoinRequestGeneration = 0;
  harness.runtimeState.room.roomState = {
    roomCode: "ROOM04",
    sharedVideo: {
      videoId: "BV1old",
      url: "https://www.bilibili.com/video/BV1old",
      title: "Old Video",
      sharedByMemberId: "member-1",
    },
    playback: null,
    members: [{ id: "member-1", name: "Alice" }],
  };

  await harness.controller.handleServerMessage({
    type: "room:member-joined",
    payload: {
      roomCode: "ROOM04",
      member: { id: "member-2", name: "Bob" },
    },
  } satisfies ServerMessage);

  assert.deepEqual(harness.runtimeState.room.roomState.members, [
    { id: "member-1", name: "Alice" },
  ]);
  assert.equal(
    harness.runtimeState.room.roomState.sharedVideo?.url,
    "https://www.bilibili.com/video/BV1old",
  );
  assert.equal(harness.persistReasons.length, 0);
  assert.equal(harness.notifyContentMessages.length, 0);

  await harness.controller.handleServerMessage({
    type: "room:joined",
    payload: {
      roomCode: "ROOM04",
      memberToken: "member-token-1",
      memberId: "member-1",
    },
  } satisfies ServerMessage);
  await harness.controller.handleServerMessage({
    type: "room:state",
    payload: {
      roomCode: "ROOM04",
      sharedVideo: {
        videoId: "BV1new",
        url: "https://www.bilibili.com/video/BV1new",
        title: "New Video",
        sharedByMemberId: "member-2",
      },
      playback: null,
      members: [{ id: "member-1", name: "Alice" }],
    },
  } satisfies ServerMessage);

  assert.deepEqual(harness.runtimeState.room.roomState?.members, [
    { id: "member-1", name: "Alice" },
    { id: "member-2", name: "Bob" },
  ]);
  assert.equal(
    harness.runtimeState.room.roomState?.sharedVideo?.url,
    "https://www.bilibili.com/video/BV1new",
  );
  assert.equal(harness.persistReasons.length, 2);
  assert.equal(harness.notifyContentMessages.length, 1);
});

test("room session controller syncs display name after room creation completes", async () => {
  const harness = createControllerHarness();
  harness.runtimeState.connection.connected = true;
  harness.runtimeState.room.displayName = "Alice";

  await harness.controller.handleServerMessage({
    type: "room:created",
    payload: {
      roomCode: "ROOM04",
      joinToken: "join-token-4",
      memberToken: "member-token-4",
      memberId: "member-4",
    },
  } satisfies ServerMessage);

  assert.deepEqual(harness.sendToServerCalls, [
    {
      type: "profile:update",
      payload: {
        memberToken: "member-token-4",
        displayName: "Alice",
      },
    },
  ]);
});

test("room session controller syncs display name after room join completes", async () => {
  const harness = createControllerHarness();
  harness.runtimeState.connection.connected = true;
  harness.runtimeState.room.displayName = "Alice";
  harness.runtimeState.room.pendingJoinToken = "join-token-5";

  await harness.controller.handleServerMessage({
    type: "room:joined",
    payload: {
      roomCode: "ROOM05",
      memberToken: "member-token-5",
      memberId: "member-5",
    },
  } satisfies ServerMessage);

  assert.deepEqual(harness.sendToServerCalls, [
    {
      type: "profile:update",
      payload: {
        memberToken: "member-token-5",
        displayName: "Alice",
      },
    },
  ]);
});

test("anchors an incoming room state on arrival, not after the work it triggers", async () => {
  // `handleRoomStateMessage` persists state and may open the shared video's tab
  // before the state is applied. The room keeps playing through that, so the
  // anchor has to be the arrival, or the receiver treats an already-stale
  // position as current and has to seek. Reported by Codex review on #210.
  let monotonicNow = 1_000;
  const harness = createControllerHarness({
    getMonotonicNow: () => monotonicNow,
    persistState: () => {
      monotonicNow += 300;
    },
    onEnsureSharedVideoOpen: () => {
      monotonicNow += 500;
    },
  });

  await harness.controller.handleServerMessage({
    type: "room:state",
    payload: {
      roomCode: "ROOM05",
      sharedVideo: null,
      playback: {
        actorId: "peer",
        seq: 1,
        url: "https://www.bilibili.com/video/BV1",
        playState: "playing",
        currentTime: 42,
        playbackRate: 1,
        serverTime: 1,
        updatedAt: 1,
      },
      members: [{ id: "member-1", name: "Alice" }],
    },
  } satisfies ServerMessage);

  assert.equal(harness.compensateCalls.length, 1);
  assert.equal(harness.compensateCalls[0]?.anchorAtMs, 1_000);
  // Paired with the snapshot this handler is responsible for.
  assert.equal(harness.compensateCalls[0]?.state.playback?.currentTime, 42);
  // Proof the stamp is not simply "now": the awaited work moved the clock on.
  assert.equal(monotonicNow, 1_800);
});

test("a snapshot the server reported as stale anchors before it arrived", async () => {
  // Joining a room mid-playback: the server hands over the last broadcast, which
  // was already one broadcast interval old. Anchoring at arrival would take that
  // position as current and start playback ~2.1s behind the room.
  const monotonicNow = 10_000;
  const harness = createControllerHarness({
    getMonotonicNow: () => monotonicNow,
  });

  await harness.controller.handleServerMessage({
    type: "room:state",
    payload: {
      roomCode: "ROOM12",
      sharedVideo: null,
      playback: {
        actorId: "peer",
        seq: 1,
        url: "https://www.bilibili.com/video/BV1",
        playState: "playing",
        currentTime: 42,
        playbackRate: 1,
        serverTime: 1,
        updatedAt: 1,
      },
      members: [{ id: "member-1", name: "Alice" }],
      playbackAgeMs: 2_100,
    },
  } satisfies ServerMessage);

  assert.equal(harness.arrivalMarks[0]?.atMs, 7_900);
  assert.equal(harness.compensateCalls[0]?.anchorAtMs, 7_900);
  // Never stored or forwarded: the age is only true at the instant it was sent,
  // and this state goes on to storage and to member-delta rewraps.
  assert.ok(
    !("playbackAgeMs" in (harness.runtimeState.room.roomState ?? {})),
    "playbackAgeMs must not survive into the stored room state",
  );
  assert.ok(
    !(
      "playbackAgeMs" in
      ((
        harness.notifyContentMessages[0] as { payload: Record<string, unknown> }
      ).payload ?? {})
    ),
    "playbackAgeMs must not be forwarded to content scripts",
  );
});

test("a room state without a playback age anchors at arrival", async () => {
  // Backward compatibility with a server predating #212.
  const monotonicNow = 10_000;
  const harness = createControllerHarness({
    getMonotonicNow: () => monotonicNow,
  });

  await harness.controller.handleServerMessage({
    type: "room:state",
    payload: {
      roomCode: "ROOM13",
      sharedVideo: null,
      playback: {
        actorId: "peer",
        seq: 1,
        url: "https://www.bilibili.com/video/BV1",
        playState: "playing",
        currentTime: 42,
        playbackRate: 1,
        serverTime: 1,
        updatedAt: 1,
      },
      members: [{ id: "member-1", name: "Alice" }],
    },
  } satisfies ServerMessage);

  assert.equal(harness.arrivalMarks[0]?.atMs, 10_000);
  assert.equal(harness.compensateCalls[0]?.anchorAtMs, 10_000);
});

test("member deltas keep the anchor of the snapshot that arrived", async () => {
  // A membership change carries the playback snapshot we already hold, so it must
  // not restamp the anchor — that would drop however long the room has played.
  let monotonicNow = 5_000;
  const harness = createControllerHarness({
    getMonotonicNow: () => monotonicNow,
  });
  harness.runtimeState.room.roomCode = "ROOM06";
  harness.runtimeState.room.roomState = {
    roomCode: "ROOM06",
    sharedVideo: null,
    playback: {
      actorId: "peer",
      seq: 1,
      url: "https://www.bilibili.com/video/BV1",
      playState: "playing",
      currentTime: 42,
      playbackRate: 1,
      serverTime: 1,
      updatedAt: 1,
    },
    members: [{ id: "member-1", name: "Alice" }],
  } satisfies RoomState;

  monotonicNow = 9_000;
  await harness.controller.handleServerMessage({
    type: "room:member-joined",
    payload: {
      roomCode: "ROOM06",
      member: { id: "member-2", name: "Bob" },
    },
  } satisfies ServerMessage);

  assert.equal(harness.compensateCalls.length, 1);
  assert.equal(harness.compensateCalls[0]?.anchorAtMs, undefined);
});

test("drops a room state that a later one superseded while it awaited", async () => {
  // The content script's staleness check is per actor, so pushing an overtaken
  // snapshot from another member moves playback backwards rather than being
  // ignored. Reported by Codex review on #210.
  const laterSnapshot = {
    roomCode: "ROOM08",
    sharedVideo: null,
    playback: {
      actorId: "peer-b",
      seq: 3,
      url: "https://www.bilibili.com/video/BV1",
      playState: "playing" as const,
      currentTime: 99,
      playbackRate: 1,
      serverTime: 9_000,
      updatedAt: 9_000,
    },
    members: [{ id: "member-1", name: "Alice" }],
  } satisfies RoomState;

  const harness = createControllerHarness({
    onEnsureSharedVideoOpen: () => {
      harness.runtimeState.room.roomState = laterSnapshot;
    },
  });

  await harness.controller.handleServerMessage({
    type: "room:state",
    payload: {
      roomCode: "ROOM08",
      sharedVideo: null,
      playback: {
        actorId: "peer-a",
        seq: 1,
        url: "https://www.bilibili.com/video/BV1",
        playState: "playing",
        currentTime: 42,
        playbackRate: 1,
        serverTime: 1_000,
        updatedAt: 1_000,
      },
      members: [{ id: "member-1", name: "Alice" }],
    },
  } satisfies ServerMessage);

  // Neither compensated (which would repoint the anchor) nor delivered.
  assert.deepEqual(harness.compensateCalls, []);
  assert.deepEqual(harness.notifyContentMessages, []);
  assert.ok(
    harness.logs.some((line) => line.includes("Dropped superseded room state")),
  );
});

test("marks the arrival before the state is observable or anything awaits", async () => {
  // From the moment the state is stored, a rehydrating content script can read it
  // and a member delta can rewrap it. Whichever compensates first must find the
  // arrival already recorded. Reported by Codex review on #210.
  let monotonicNow = 1_000;
  const harness = createControllerHarness({
    getMonotonicNow: () => monotonicNow,
    persistState: () => {
      monotonicNow += 300;
    },
  });

  await harness.controller.handleServerMessage({
    type: "room:state",
    payload: {
      roomCode: "ROOM09",
      sharedVideo: null,
      playback: {
        actorId: "peer",
        seq: 1,
        url: "https://www.bilibili.com/video/BV1",
        playState: "playing",
        currentTime: 42,
        playbackRate: 1,
        serverTime: 1_000,
        updatedAt: 1_000,
      },
      members: [{ id: "member-1", name: "Alice" }],
    },
  } satisfies ServerMessage);

  assert.equal(harness.arrivalMarks.length, 1);
  assert.equal(harness.arrivalMarks[0]?.atMs, 1_000);
  assert.equal(harness.arrivalMarks[0]?.currentTime, 42);
  // Before the first await, so before anything could observe the snapshot.
  assert.equal(harness.arrivalMarks[0]?.persistCallsSoFar, 0);
});

test("drops a member delta that a later room state superseded", async () => {
  // Mirror of the room-state path: this delta carries the *older* playback
  // snapshot, and a per-actor staleness check will not save the receiver from it.
  const laterSnapshot = {
    roomCode: "ROOM10",
    sharedVideo: null,
    playback: {
      actorId: "peer-b",
      seq: 5,
      url: "https://www.bilibili.com/video/BV1",
      playState: "playing" as const,
      currentTime: 99,
      playbackRate: 1,
      serverTime: 9_000,
      updatedAt: 9_000,
    },
    members: [{ id: "member-1", name: "Alice" }],
  } satisfies RoomState;

  const harness = createControllerHarness({
    persistState: (callCount) => {
      if (callCount === 1) {
        harness.runtimeState.room.roomState = laterSnapshot;
      }
    },
  });
  harness.runtimeState.room.roomCode = "ROOM10";
  harness.runtimeState.room.roomState = {
    roomCode: "ROOM10",
    sharedVideo: null,
    playback: {
      actorId: "peer-a",
      seq: 1,
      url: "https://www.bilibili.com/video/BV1",
      playState: "playing",
      currentTime: 42,
      playbackRate: 1,
      serverTime: 1_000,
      updatedAt: 1_000,
    },
    members: [{ id: "member-1", name: "Alice" }],
  } satisfies RoomState;

  await harness.controller.handleServerMessage({
    type: "room:member-joined",
    payload: {
      roomCode: "ROOM10",
      member: { id: "member-2", name: "Bob" },
    },
  } satisfies ServerMessage);

  assert.deepEqual(harness.compensateCalls, []);
  assert.deepEqual(harness.notifyContentMessages, []);
  assert.ok(
    harness.logs.some((line) =>
      line.includes("Dropped superseded member state"),
    ),
  );
});

test("takes the pending-share verdict from the share controller, not a wall-clock re-derivation", async () => {
  const pendingUrl = "https://www.bilibili.com/video/BVpending";
  const harness = createControllerHarness({
    // The share controller owns the marker and measures its deadline on a
    // monotonic clock, so it still reports the share as in flight.
    getActivePendingLocalShareUrl: () => pendingUrl,
  });
  harness.runtimeState.share.pendingLocalShareUrl = pendingUrl;
  // The wall-clock stamp says the opposite. It is the same field a second copy
  // of the liveness test would read, so re-deriving the verdict here instead of
  // asking the owner flips the answer.
  harness.runtimeState.share.pendingLocalShareExpiresAt = Date.now() - 60_000;

  await harness.controller.handleServerMessage({
    type: "room:state",
    payload: {
      roomCode: "ROOM11",
      sharedVideo: {
        videoId: "BVother",
        url: "https://www.bilibili.com/video/BVother",
        title: "Someone else's video",
        sharedByMemberId: "member-9",
      },
      playback: null,
      members: [{ id: "member-9", name: "Bob" }],
    },
  } satisfies ServerMessage);

  // Our own share is still in flight, so a room state showing a different video
  // is the pre-share snapshot and must not roll the room back onto it.
  assert.equal(harness.runtimeState.room.roomState, null);
  assert.deepEqual(harness.ensureSharedVideoOpenCalls, []);
  assert.deepEqual(harness.notifyContentMessages, []);
  assert.ok(
    harness.logs.some((line) => line.startsWith("Ignored stale room state")),
  );
});

test("expires the pending share toast on the monotonic clock", async () => {
  let monotonic = 5_000;
  const harness = createControllerHarness({
    getMonotonicNow: () => monotonic,
  });
  const sharedVideo = {
    videoId: "BVtoast",
    url: "https://www.bilibili.com/video/BVtoast",
    title: "Toast Video",
    sharedByMemberId: "member-1",
  };

  // Creates the pending toast with an 8s TTL (`shareToastTtlMs` in the harness).
  await harness.controller.handleServerMessage({
    type: "room:state",
    payload: {
      roomCode: "ROOM12",
      sharedVideo,
      playback: null,
      members: [{ id: "member-1", name: "Alice" }],
    },
  } satisfies ServerMessage);

  // A later state for the SAME shared video mints no new toast, so the pending
  // one is re-tested against its deadline. Still inside the TTL on the monotonic
  // clock, so it rides along again.
  monotonic = 9_000;
  await harness.controller.handleServerMessage({
    type: "room:state",
    payload: {
      roomCode: "ROOM12",
      sharedVideo,
      playback: null,
      members: [
        { id: "member-1", name: "Alice" },
        { id: "member-2", name: "Bob" },
      ],
    },
  } satisfies ServerMessage);

  assert.ok(
    (harness.notifyContentMessages[1] as { shareToast: unknown }).shareToast,
  );

  // Past it: the toast must be dropped. The wall clock is never touched in this
  // test, so an implementation reading it would still call this fresh.
  monotonic = 20_000;
  await harness.controller.handleServerMessage({
    type: "room:state",
    payload: {
      roomCode: "ROOM12",
      sharedVideo,
      playback: null,
      members: [
        { id: "member-1", name: "Alice" },
        { id: "member-2", name: "Bob" },
        { id: "member-3", name: "Carol" },
      ],
    },
  } satisfies ServerMessage);

  assert.equal(
    (harness.notifyContentMessages[2] as { shareToast: unknown }).shareToast,
    null,
  );
  assert.equal(harness.runtimeState.share.pendingShareToast, null);
});
