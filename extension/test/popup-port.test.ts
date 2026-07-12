import assert from "node:assert/strict";
import test from "node:test";
import {
  isActiveVideoResponse,
  isBackgroundPopupStateMessage,
  isPageShareButtonSettingsResponse,
  isShareContextResponse,
  isShareCurrentVideoResponse,
} from "../src/shared/messages";
import { sendPopupActiveVideoQuery } from "../src/popup/popup-port";

const validStateMessage = {
  type: "background:state",
  payload: {
    connected: true,
    roomCode: "ROOM01",
    joinToken: "join-token-123456",
    memberId: "member-1",
    displayName: "Alice",
    roomState: null,
    serverUrl: "ws://localhost:9999",
    error: null,
    pendingCreateRoom: false,
    pendingJoinRoomCode: null,
    retryInMs: null,
    retryAttempt: 0,
    clockOffsetMs: null,
    rttMs: null,
    pageShareButtonEnabled: true,
    logs: [],
  },
};

test("isBackgroundPopupStateMessage returns true for valid background:state message", () => {
  assert.ok(isBackgroundPopupStateMessage(validStateMessage));
});

test("isBackgroundPopupStateMessage returns false for null", () => {
  assert.equal(isBackgroundPopupStateMessage(null), false);
});

test("isBackgroundPopupStateMessage returns false for undefined", () => {
  assert.equal(isBackgroundPopupStateMessage(undefined), false);
});

test("isBackgroundPopupStateMessage returns false for wrong type field", () => {
  assert.equal(
    isBackgroundPopupStateMessage({ type: "background:popup-connected" }),
    false,
  );
});

test("isBackgroundPopupStateMessage returns false for non-object", () => {
  assert.equal(isBackgroundPopupStateMessage("background:state"), false);
  assert.equal(isBackgroundPopupStateMessage(42), false);
});

test("isBackgroundPopupStateMessage returns false for object without type", () => {
  assert.equal(isBackgroundPopupStateMessage({ payload: {} }), false);
});

test("isBackgroundPopupStateMessage returns false when payload is absent", () => {
  assert.equal(
    isBackgroundPopupStateMessage({ type: "background:state" }),
    false,
  );
});

test("isBackgroundPopupStateMessage returns false when payload is null", () => {
  assert.equal(
    isBackgroundPopupStateMessage({ type: "background:state", payload: null }),
    false,
  );
});

test("isBackgroundPopupStateMessage returns false when payload lacks required fields", () => {
  assert.equal(
    isBackgroundPopupStateMessage({ type: "background:state", payload: {} }),
    false,
  );
  assert.equal(
    isBackgroundPopupStateMessage({
      type: "background:state",
      payload: { connected: true },
    }),
    false,
  );
  assert.equal(
    isBackgroundPopupStateMessage({
      type: "background:state",
      payload: { serverUrl: "ws://localhost" },
    }),
    false,
  );
  assert.equal(
    isBackgroundPopupStateMessage({
      type: "background:state",
      payload: {
        connected: true,
        serverUrl: "ws://localhost",
        pageShareButtonEnabled: "yes",
      },
    }),
    false,
  );
});

const validSharedVideo = {
  videoId: "BV1xx411c7mD",
  url: "https://www.bilibili.com/video/BV1xx411c7mD",
  title: "Test video",
};

test("isActiveVideoResponse accepts ok response with payload", () => {
  assert.ok(
    isActiveVideoResponse({
      ok: true,
      payload: { video: validSharedVideo, playback: null },
      tabId: 7,
    }),
  );
});

test("isActiveVideoResponse accepts ok:false response with null payload", () => {
  assert.ok(
    isActiveVideoResponse({
      ok: false,
      payload: null,
      tabId: null,
      error: "no tab",
    }),
  );
});

test("isActiveVideoResponse rejects non-object and nullish values", () => {
  assert.equal(isActiveVideoResponse(null), false);
  assert.equal(isActiveVideoResponse(undefined), false);
  assert.equal(isActiveVideoResponse("ok"), false);
});

test("isActiveVideoResponse rejects response missing ok boolean", () => {
  assert.equal(isActiveVideoResponse({ payload: null, tabId: null }), false);
});

test("isActiveVideoResponse rejects ok:true with null payload", () => {
  assert.equal(
    isActiveVideoResponse({ ok: true, payload: null, tabId: 1 }),
    false,
  );
});

test("isActiveVideoResponse rejects response with malformed tabId", () => {
  assert.equal(
    isActiveVideoResponse({ ok: true, payload: null, tabId: "1" }),
    false,
  );
});

test("isActiveVideoResponse rejects response with non-string error", () => {
  assert.equal(
    isActiveVideoResponse({ ok: false, payload: null, tabId: 1, error: 42 }),
    false,
  );
});

test("isActiveVideoResponse rejects payload missing a valid SharedVideo", () => {
  assert.equal(
    isActiveVideoResponse({
      ok: true,
      payload: { video: { title: "no ids" }, playback: null },
      tabId: 1,
    }),
    false,
  );
});

test("isActiveVideoResponse rejects payload with malformed playback", () => {
  assert.equal(
    isActiveVideoResponse({
      ok: true,
      payload: { video: validSharedVideo, playback: { foo: 1 } },
      tabId: 1,
    }),
    false,
  );
});

test("isShareContextResponse accepts valid context responses", () => {
  assert.ok(
    isShareContextResponse({
      ok: true,
      roomCode: "ROOM01",
      memberCount: 3,
      sharedVideo: validSharedVideo,
    }),
  );
  assert.ok(
    isShareContextResponse({
      ok: true,
      roomCode: null,
      memberCount: null,
      sharedVideo: null,
    }),
  );
});

test("isShareContextResponse rejects malformed context responses", () => {
  assert.equal(isShareContextResponse(null), false);
  assert.equal(
    isShareContextResponse({
      ok: true,
      roomCode: 42,
      memberCount: 1,
      sharedVideo: null,
    }),
    false,
  );
  assert.equal(
    isShareContextResponse({
      ok: true,
      roomCode: "ROOM01",
      memberCount: 1,
      sharedVideo: { title: "missing id" },
    }),
    false,
  );
  assert.equal(
    isShareContextResponse({
      ok: true,
      roomCode: "ROOM01",
      memberCount: -1,
      sharedVideo: null,
    }),
    false,
  );
  assert.equal(
    isShareContextResponse({
      ok: true,
      roomCode: "ROOM01",
      sharedVideo: null,
    }),
    false,
  );
});

test("isShareCurrentVideoResponse validates share result responses", () => {
  assert.ok(isShareCurrentVideoResponse({ ok: true }));
  assert.ok(isShareCurrentVideoResponse({ ok: false, error: "failed" }));
  assert.equal(isShareCurrentVideoResponse(null), false);
  assert.equal(isShareCurrentVideoResponse({ ok: "yes" }), false);
  assert.equal(isShareCurrentVideoResponse({ ok: false, error: 42 }), false);
});

test("isPageShareButtonSettingsResponse validates settings responses", () => {
  assert.ok(isPageShareButtonSettingsResponse({ ok: true, enabled: true }));
  assert.ok(
    isPageShareButtonSettingsResponse({
      ok: false,
      enabled: false,
      error: "failed",
    }),
  );
  assert.equal(isPageShareButtonSettingsResponse(null), false);
  assert.equal(
    isPageShareButtonSettingsResponse({ ok: true, enabled: "yes" }),
    false,
  );
  assert.equal(
    isPageShareButtonSettingsResponse({ ok: false, enabled: false, error: 1 }),
    false,
  );
});

function installChromeSendMessageStub(response: unknown): { calls: unknown[] } {
  const calls: unknown[] = [];
  globalThis.chrome = {
    runtime: {
      async sendMessage(message: unknown): Promise<unknown> {
        calls.push(message);
        return response;
      },
    },
  } as unknown as typeof chrome;
  return { calls };
}

test("sendPopupActiveVideoQuery returns the response when guard passes", async () => {
  const response = {
    ok: true,
    payload: { video: validSharedVideo, playback: null },
    tabId: 3,
  };
  const { calls } = installChromeSendMessageStub(response);

  const resolved = await sendPopupActiveVideoQuery();

  assert.deepEqual(calls, [{ type: "popup:get-active-video" }]);
  assert.deepEqual(resolved, response);
});

test("sendPopupActiveVideoQuery throws when response shape is invalid", async () => {
  installChromeSendMessageStub({ ok: true, payload: { video: {} } });

  await assert.rejects(
    sendPopupActiveVideoQuery(),
    /Unexpected response to popup:get-active-video/,
  );
});
