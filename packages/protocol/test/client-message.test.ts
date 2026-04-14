import test from "node:test";
import assert from "node:assert/strict";
import { isClientMessage } from "../src/index.js";

const VALID_TOKEN = "valid-member-token-123";
const DISPLAY_NAME_MAX_LENGTH = 32;
const TITLE_MAX_LENGTH = 128;
const URL_MAX_LENGTH = 512;

function createBilibiliUrlWithExactLength(targetLength: number): string {
  const baseUrl = "https://www.bilibili.com/video/BV1xx411c7mD?from=test&pad=";
  const paddingLength = targetLength - baseUrl.length;

  assert.ok(
    paddingLength >= 0,
    `target length ${targetLength} must be at least ${baseUrl.length}`,
  );

  return `${baseUrl}${"a".repeat(paddingLength)}`;
}

test("accepts a valid room:create message", () => {
  assert.equal(
    isClientMessage({
      type: "room:create",
      payload: {
        displayName: "Alice",
      },
    }),
    true,
  );
});

test("rejects room:create when payload displayName has an invalid type", () => {
  assert.equal(
    isClientMessage({
      type: "room:create",
      payload: {
        displayName: 123,
      },
    }),
    false,
  );
});

test("rejects room:create when displayName is too long", () => {
  assert.equal(
    isClientMessage({
      type: "room:create",
      payload: {
        displayName: "a".repeat(33),
      },
    }),
    false,
  );
});

test("accepts room:create when displayName is exactly 32 characters", () => {
  assert.equal(
    isClientMessage({
      type: "room:create",
      payload: {
        displayName: "a".repeat(DISPLAY_NAME_MAX_LENGTH),
      },
    }),
    true,
  );
});

test("rejects room:join without payload", () => {
  assert.equal(
    isClientMessage({
      type: "room:join",
    }),
    false,
  );
});

test("rejects room:join without joinToken", () => {
  assert.equal(
    isClientMessage({
      type: "room:join",
      payload: {
        roomCode: "ABC123",
        displayName: "Alice",
      },
    }),
    false,
  );
});

test("rejects room:join when roomCode has an invalid format", () => {
  assert.equal(
    isClientMessage({
      type: "room:join",
      payload: {
        roomCode: "abc123",
        joinToken: VALID_TOKEN,
        displayName: "Alice",
      },
    }),
    false,
  );
});

test("rejects room:join when joinToken is too short", () => {
  assert.equal(
    isClientMessage({
      type: "room:join",
      payload: {
        roomCode: "ABC123",
        joinToken: "short-token",
        displayName: "Alice",
      },
    }),
    false,
  );
});

test("accepts room:join with an optional memberToken for reconnect", () => {
  assert.equal(
    isClientMessage({
      type: "room:join",
      payload: {
        roomCode: "ABC123",
        joinToken: VALID_TOKEN,
        memberToken: VALID_TOKEN,
        displayName: "Alice",
      },
    }),
    true,
  );
});

test("accepts room:join when displayName is exactly 32 characters", () => {
  assert.equal(
    isClientMessage({
      type: "room:join",
      payload: {
        roomCode: "ABC123",
        joinToken: VALID_TOKEN,
        displayName: "a".repeat(DISPLAY_NAME_MAX_LENGTH),
      },
    }),
    true,
  );
});

test("accepts a valid profile:update message", () => {
  assert.equal(
    isClientMessage({
      type: "profile:update",
      payload: {
        memberToken: VALID_TOKEN,
        displayName: "Alice",
      },
    }),
    true,
  );
});

test("rejects profile:update when displayName is too long", () => {
  assert.equal(
    isClientMessage({
      type: "profile:update",
      payload: {
        memberToken: VALID_TOKEN,
        displayName: "a".repeat(33),
      },
    }),
    false,
  );
});

test("accepts profile:update when displayName is exactly 32 characters", () => {
  assert.equal(
    isClientMessage({
      type: "profile:update",
      payload: {
        memberToken: VALID_TOKEN,
        displayName: "a".repeat(DISPLAY_NAME_MAX_LENGTH),
      },
    }),
    true,
  );
});

test("rejects video:share when required fields are missing", () => {
  assert.equal(
    isClientMessage({
      type: "video:share",
      payload: {
        memberToken: VALID_TOKEN,
        video: {
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "Video",
        },
      },
    }),
    false,
  );
});

test("rejects video:share without memberToken", () => {
  assert.equal(
    isClientMessage({
      type: "video:share",
      payload: {
        video: {
          videoId: "BV1xx411c7mD",
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "Video",
        },
      },
    }),
    false,
  );
});

test("rejects video:share when title is too long", () => {
  assert.equal(
    isClientMessage({
      type: "video:share",
      payload: {
        memberToken: VALID_TOKEN,
        video: {
          videoId: "BV1xx411c7mD",
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "x".repeat(129),
        },
      },
    }),
    false,
  );
});

test("accepts video:share when title is exactly 128 characters", () => {
  assert.equal(
    isClientMessage({
      type: "video:share",
      payload: {
        memberToken: VALID_TOKEN,
        video: {
          videoId: "BV1xx411c7mD",
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "x".repeat(TITLE_MAX_LENGTH),
        },
      },
    }),
    true,
  );
});

test("accepts video:share when url is exactly 512 characters", () => {
  const exactBoundaryUrl = createBilibiliUrlWithExactLength(URL_MAX_LENGTH);

  assert.equal(exactBoundaryUrl.length, URL_MAX_LENGTH);
  assert.equal(
    isClientMessage({
      type: "video:share",
      payload: {
        memberToken: VALID_TOKEN,
        video: {
          videoId: "BV1xx411c7mD",
          url: exactBoundaryUrl,
          title: "Video",
        },
      },
    }),
    true,
  );
});

test("accepts video:share with an initial playback state", () => {
  assert.equal(
    isClientMessage({
      type: "video:share",
      payload: {
        memberToken: VALID_TOKEN,
        video: {
          videoId: "BV1xx411c7mD",
          url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
          title: "Video",
        },
        playback: {
          url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
          currentTime: 12,
          playState: "playing",
          syncIntent: "explicit-seek",
          playbackRate: 1,
          updatedAt: 1,
          serverTime: 0,
          actorId: "member-1",
          seq: 1,
        },
      },
    }),
    true,
  );
});

test("accepts video:share with a bangumi video id and valid actor identifiers", () => {
  assert.equal(
    isClientMessage({
      type: "video:share",
      payload: {
        memberToken: VALID_TOKEN,
        video: {
          videoId: "ep508404:p2",
          url: "https://www.bilibili.com/bangumi/play/ep508404?p=2",
          title: "Bangumi",
          sharedByMemberId: "member_01:host",
        },
        playback: {
          url: "https://www.bilibili.com/bangumi/play/ep508404?p=2",
          currentTime: 12,
          playState: "playing",
          playbackRate: 1,
          updatedAt: 1,
          serverTime: 0,
          actorId: "member_01:host",
          seq: 1,
        },
      },
    }),
    true,
  );
});

test("rejects playback:update with an invalid play state", () => {
  assert.equal(
    isClientMessage({
      type: "playback:update",
      payload: {
        memberToken: VALID_TOKEN,
        playback: {
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          currentTime: 12,
          playState: "stopped",
          playbackRate: 1,
          updatedAt: 1,
          serverTime: 1,
          actorId: "member-1",
          seq: 1,
        },
      },
    }),
    false,
  );
});

test("rejects playback:update with non-finite numeric fields", () => {
  assert.equal(
    isClientMessage({
      type: "playback:update",
      payload: {
        memberToken: VALID_TOKEN,
        playback: {
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          currentTime: Number.NaN,
          playState: "playing",
          playbackRate: 1,
          updatedAt: 1,
          serverTime: 1,
          actorId: "member-1",
          seq: 1,
        },
      },
    }),
    false,
  );
});

test("rejects sync:request without memberToken", () => {
  assert.equal(
    isClientMessage({
      type: "sync:request",
      payload: {},
    }),
    false,
  );
});

test("rejects sync:ping without clientSendTime", () => {
  assert.equal(
    isClientMessage({
      type: "sync:ping",
      payload: {},
    }),
    false,
  );
});

test("accepts a valid playback:update message", () => {
  assert.equal(
    isClientMessage({
      type: "playback:update",
      payload: {
        memberToken: VALID_TOKEN,
        playback: {
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          currentTime: 12,
          playState: "playing",
          syncIntent: "explicit-seek",
          playbackRate: 1,
          updatedAt: 1,
          serverTime: 1,
          actorId: "member-1",
          seq: 1,
        },
      },
    }),
    true,
  );
});

test("accepts playback:update when url is exactly 512 characters", () => {
  const exactBoundaryUrl = createBilibiliUrlWithExactLength(URL_MAX_LENGTH);

  assert.equal(exactBoundaryUrl.length, URL_MAX_LENGTH);
  assert.equal(
    isClientMessage({
      type: "playback:update",
      payload: {
        memberToken: VALID_TOKEN,
        playback: {
          url: exactBoundaryUrl,
          currentTime: 12,
          playState: "playing",
          playbackRate: 1,
          updatedAt: 1,
          serverTime: 1,
          actorId: "member-1",
          seq: 1,
        },
      },
    }),
    true,
  );
});

test("rejects video:share with an invalid bilibili url", () => {
  assert.equal(
    isClientMessage({
      type: "video:share",
      payload: {
        memberToken: VALID_TOKEN,
        video: {
          videoId: "BV1xx411c7mD",
          url: "https://example.com/video/BV1xx411c7mD",
          title: "Video",
        },
      },
    }),
    false,
  );
});

test("rejects video:share with an invalid videoId format", () => {
  assert.equal(
    isClientMessage({
      type: "video:share",
      payload: {
        memberToken: VALID_TOKEN,
        video: {
          videoId: "BV1xx411c7mD/part-1",
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "Video",
        },
      },
    }),
    false,
  );
});

test("rejects playback:update with an invalid actorId format", () => {
  assert.equal(
    isClientMessage({
      type: "playback:update",
      payload: {
        memberToken: VALID_TOKEN,
        playback: {
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          currentTime: 12,
          playState: "playing",
          playbackRate: 1,
          updatedAt: 1,
          serverTime: 1,
          actorId: "member 1",
          seq: 1,
        },
      },
    }),
    false,
  );
});

test("rejects video:share with an invalid sharedByMemberId format", () => {
  assert.equal(
    isClientMessage({
      type: "video:share",
      payload: {
        memberToken: VALID_TOKEN,
        video: {
          videoId: "BV1xx411c7mD",
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "Video",
          sharedByMemberId: "member 1",
        },
      },
    }),
    false,
  );
});

test("rejects video:share with an invalid paged videoId format", () => {
  assert.equal(
    isClientMessage({
      type: "video:share",
      payload: {
        memberToken: VALID_TOKEN,
        video: {
          videoId: "BV1xx411c7mD:p0",
          url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
          title: "Video",
        },
      },
    }),
    false,
  );
});

test("accepts playback:update with explicit-ratechange sync intent", () => {
  assert.equal(
    isClientMessage({
      type: "playback:update",
      payload: {
        memberToken: VALID_TOKEN,
        playback: {
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          currentTime: 12,
          playState: "playing",
          syncIntent: "explicit-ratechange",
          playbackRate: 1.5,
          updatedAt: 1,
          serverTime: 1,
          actorId: "member-1",
          seq: 1,
        },
      },
    }),
    true,
  );
});

test("rejects playback:update with an invalid sync intent", () => {
  assert.equal(
    isClientMessage({
      type: "playback:update",
      payload: {
        memberToken: VALID_TOKEN,
        playback: {
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          currentTime: 12,
          playState: "playing",
          syncIntent: "follow",
          playbackRate: 1,
          updatedAt: 1,
          serverTime: 1,
          actorId: "member-1",
          seq: 1,
        },
      },
    }),
    false,
  );
});

test("accepts a valid room:join message", () => {
  assert.equal(
    isClientMessage({
      type: "room:join",
      payload: {
        roomCode: "ABC123",
        joinToken: VALID_TOKEN,
        displayName: "Alice",
      },
    }),
    true,
  );
});
