import assert from "node:assert/strict";
import test from "node:test";
import {
  isActiveVideoResponse,
  isBackgroundPopupStateMessage,
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
    retryAttemptMax: 5,
    clockOffsetMs: null,
    rttMs: null,
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
