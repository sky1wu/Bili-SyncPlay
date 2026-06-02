import assert from "node:assert/strict";
import test from "node:test";
import type { RoomState, ServerMessage } from "@bili-syncplay/protocol";
import { createBackgroundRuntimeState } from "../src/background/runtime-state";
import { createRoomSessionController } from "../src/background/room-session-controller";
import { setLocaleForTests } from "../src/shared/i18n";

function createControllerHarness(options?: {
  bootstrapRoomStateTimeoutMs?: number;
  persistState?: (callCount: number) => Promise<void> | void;
}) {
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
    bootstrapRoomStateTimeoutMs: options?.bootstrapRoomStateTimeoutMs,
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
      protocolVersion: 3,
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
    "Your extension version is too old. Please update SyncRoom to the latest version.",
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
      protocolVersion: 3,
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
  harness.runtimeState.room.pendingJoinRequestSent = true;
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
