import test from "node:test";
import assert from "node:assert/strict";
import { isClientMessage } from "../src/index";

test("accepts a valid room:create message", () => {
  assert.equal(
    isClientMessage({
      type: "room:create",
      payload: {
        displayName: "Alice"
      }
    }),
    true
  );
});

test("rejects room:create when payload displayName has an invalid type", () => {
  assert.equal(
    isClientMessage({
      type: "room:create",
      payload: {
        displayName: 123
      }
    }),
    false
  );
});

test("rejects room:join without payload", () => {
  assert.equal(
    isClientMessage({
      type: "room:join"
    }),
    false
  );
});

test("rejects room:join without roomCode", () => {
  assert.equal(
    isClientMessage({
      type: "room:join",
      payload: {
        displayName: "Alice"
      }
    }),
    false
  );
});

test("rejects room:join when roomCode has an invalid type", () => {
  assert.equal(
    isClientMessage({
      type: "room:join",
      payload: {
        roomCode: 10001,
        displayName: "Alice"
      }
    }),
    false
  );
});

test("rejects video:share when required fields are missing", () => {
  assert.equal(
    isClientMessage({
      type: "video:share",
      payload: {
        url: "https://www.bilibili.com/video/BV1xx411c7mD",
        title: "Video"
      }
    }),
    false
  );
});

test("rejects video:share when field types are invalid", () => {
  assert.equal(
    isClientMessage({
      type: "video:share",
      payload: {
        videoId: "BV1xx411c7mD",
        url: 42,
        title: "Video"
      }
    }),
    false
  );
});

test("rejects playback:update with an invalid play state", () => {
  assert.equal(
    isClientMessage({
      type: "playback:update",
      payload: {
        url: "https://www.bilibili.com/video/BV1xx411c7mD",
        currentTime: 12,
        playState: "stopped",
        playbackRate: 1,
        updatedAt: 1,
        serverTime: 1,
        actorId: "member-1",
        seq: 1
      }
    }),
    false
  );
});

test("rejects playback:update with non-finite numeric fields", () => {
  assert.equal(
    isClientMessage({
      type: "playback:update",
      payload: {
        url: "https://www.bilibili.com/video/BV1xx411c7mD",
        currentTime: Number.NaN,
        playState: "playing",
        playbackRate: 1,
        updatedAt: 1,
        serverTime: 1,
        actorId: "member-1",
        seq: 1
      }
    }),
    false
  );
});

test("rejects sync:ping without clientSendTime", () => {
  assert.equal(
    isClientMessage({
      type: "sync:ping",
      payload: {}
    }),
    false
  );
});

test("accepts a valid playback:update message", () => {
  assert.equal(
    isClientMessage({
      type: "playback:update",
      payload: {
        url: "https://www.bilibili.com/video/BV1xx411c7mD",
        currentTime: 12,
        playState: "playing",
        playbackRate: 1,
        updatedAt: 1,
        serverTime: 1,
        actorId: "member-1",
        seq: 1
      }
    }),
    true
  );
});
