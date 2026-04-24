import assert from "node:assert/strict";
import test from "node:test";
import type { RoomState, ServerMessage } from "@bili-syncplay/protocol";
import { createBackgroundRuntimeState } from "../src/background/runtime-state";
import { createRoomSessionController } from "../src/background/room-session-controller";
import { setLocaleForTests } from "../src/shared/i18n";

function createControllerHarness() {
  const runtimeState = createBackgroundRuntimeState();
  const sendToServerCalls: Array<unknown> = [];
  const notifyContentMessages: Array<unknown> = [];
  const persistReasons: string[] = [];
  const logs: string[] = [];
  const ensureSharedVideoOpenCalls: RoomState[] = [];
  const clearPendingLocalShareReasons: string[] = [];
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
    },
    notifyContentScripts: async (message) => {
      notifyContentMessages.push(message);
    },
    compensateRoomState: (state) => state,
    clearPendingLocalShare: (reason) => {
      clearPendingLocalShareReasons.push(reason);
      runtimeState.share.pendingLocalShareUrl = null;
      runtimeState.share.pendingLocalShareExpiresAt = null;
    },
    expirePendingLocalShareIfNeeded: () => {},
    normalizeUrl: (url) => url?.trim() ?? null,
    logServerError: (code, message) => {
      logs.push(`server-error:${code}:${message}`);
    },
    shareToastTtlMs: 8_000,
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
      protocolVersion: 1,
    },
  });
});

test("room session controller clears pending join on unsupported_protocol_version error", async () => {
  const harness = createControllerHarness();
  harness.runtimeState.room.pendingJoinRoomCode = "ROOM-PV";
  harness.runtimeState.room.pendingJoinToken = "join-token-pv";
  harness.runtimeState.room.pendingJoinRequestSent = true;

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
  assert.equal(harness.runtimeState.room.pendingJoinRequestSent, false);
  assert.equal(harness.runtimeState.room.roomCode, null);
});

test("room session controller clears stored room on unsupported_protocol_version error", async () => {
  const harness = createControllerHarness();
  harness.runtimeState.room.roomCode = "ROOM-ST";
  harness.runtimeState.room.joinToken = "join-token-st";
  harness.runtimeState.room.memberToken = "member-token-st";
  harness.runtimeState.room.memberId = "member-st";
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
  assert.equal(harness.runtimeState.room.pendingJoinRequestSent, true);
  assert.equal(harness.sendToServerCalls.length, 1);
  assert.deepEqual(harness.sendToServerCalls[0], {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "token-1",
      displayName: "Alice",
      protocolVersion: 1,
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
  harness.runtimeState.room.pendingJoinRequestSent = true;
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
  assert.equal(harness.runtimeState.room.pendingJoinRequestSent, false);
  assert.equal(harness.runtimeState.room.roomCode, null);
  assert.equal(harness.runtimeState.room.memberToken, null);
  assert.equal(
    harness.runtimeState.connection.lastError,
    "The room was not found.",
  );
  assert.equal(harness.persistReasons.length, 1);
  assert.equal(harness.notifyAllCalls, 1);
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
  assert.equal(harness.runtimeState.room.roomState, nextRoomState);
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
  assert.equal(
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
