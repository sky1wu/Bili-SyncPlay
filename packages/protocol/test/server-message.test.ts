import assert from "node:assert/strict";
import test from "node:test";
import { isServerMessage } from "../src/index.js";

const VALID_TOKEN = "valid-member-token-123";

test("accepts a valid room:created message", () => {
  assert.equal(
    isServerMessage({
      type: "room:created",
      payload: {
        roomCode: "ABC123",
        memberId: "member-1",
        joinToken: VALID_TOKEN,
        memberToken: VALID_TOKEN,
      },
    }),
    true,
  );
});

test("accepts a valid room:state message", () => {
  assert.equal(
    isServerMessage({
      type: "room:state",
      payload: {
        roomCode: "ABC123",
        sharedVideo: {
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
          serverTime: 1,
          actorId: "member-1",
          seq: 1,
        },
        members: [{ id: "member-1", name: "Alice" }],
      },
    }),
    true,
  );
});

test("accepts room:state when member ids use UUIDs", () => {
  assert.equal(
    isServerMessage({
      type: "room:state",
      payload: {
        roomCode: "ABC123",
        sharedVideo: {
          videoId: "BV1xx411c7mD",
          url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
          title: "Video",
          sharedByMemberId: "123e4567-e89b-12d3-a456-426614174000",
        },
        playback: {
          url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
          currentTime: 12,
          playState: "playing",
          playbackRate: 1,
          updatedAt: 1,
          serverTime: 1,
          actorId: "123e4567-e89b-12d3-a456-426614174000",
          seq: 1,
        },
        members: [
          {
            id: "123e4567-e89b-12d3-a456-426614174000",
            name: "Alice",
          },
        ],
      },
    }),
    true,
  );
});

test("accepts room:state when playback sync intent is explicit-ratechange", () => {
  assert.equal(
    isServerMessage({
      type: "room:state",
      payload: {
        roomCode: "ABC123",
        sharedVideo: {
          videoId: "BV1xx411c7mD",
          url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
          title: "Video",
        },
        playback: {
          url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
          currentTime: 12,
          playState: "playing",
          syncIntent: "explicit-ratechange",
          playbackRate: 1.5,
          updatedAt: 1,
          serverTime: 1,
          actorId: "member-1",
          seq: 1,
        },
        members: [{ id: "member-1", name: "Alice" }],
      },
    }),
    true,
  );
});

test("accepts room:joined when memberId uses max-compatible actor format", () => {
  assert.equal(
    isServerMessage({
      type: "room:joined",
      payload: {
        roomCode: "ABC123",
        memberId: "member_01:host",
        memberToken: VALID_TOKEN,
      },
    }),
    true,
  );
});

test("rejects room:created when memberId format is invalid", () => {
  assert.equal(
    isServerMessage({
      type: "room:created",
      payload: {
        roomCode: "ABC123",
        memberId: "member 1",
        joinToken: VALID_TOKEN,
        memberToken: VALID_TOKEN,
      },
    }),
    false,
  );
});

test("rejects room:state when playback sync intent is invalid", () => {
  assert.equal(
    isServerMessage({
      type: "room:state",
      payload: {
        roomCode: "ABC123",
        sharedVideo: {
          videoId: "BV1xx411c7mD",
          url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
          title: "Video",
        },
        playback: {
          url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
          currentTime: 12,
          playState: "playing",
          syncIntent: "follow",
          playbackRate: 1,
          updatedAt: 1,
          serverTime: 1,
          actorId: "member-1",
          seq: 1,
        },
        members: [{ id: "member-1", name: "Alice" }],
      },
    }),
    false,
  );
});

test("accepts room:state when sharedByDisplayName is set on the shared video", () => {
  assert.equal(
    isServerMessage({
      type: "room:state",
      payload: {
        roomCode: "ABC123",
        sharedVideo: {
          videoId: "BV1xx411c7mD",
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "Video",
          sharedByMemberId: "member-1",
          sharedByDisplayName: "Alice",
        },
        playback: null,
        members: [{ id: "member-1", name: "Alice" }],
      },
    }),
    true,
  );
});

test("rejects room:state when sharedByDisplayName exceeds the display-name bound", () => {
  assert.equal(
    isServerMessage({
      type: "room:state",
      payload: {
        roomCode: "ABC123",
        sharedVideo: {
          videoId: "BV1xx411c7mD",
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "Video",
          sharedByMemberId: "member-1",
          sharedByDisplayName: "x".repeat(33),
        },
        playback: null,
        members: [{ id: "member-1", name: "Alice" }],
      },
    }),
    false,
  );
});

test("rejects room:state when sharedByMemberId format is invalid", () => {
  assert.equal(
    isServerMessage({
      type: "room:state",
      payload: {
        roomCode: "ABC123",
        sharedVideo: {
          videoId: "BV1xx411c7mD",
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "Video",
          sharedByMemberId: "member 1",
        },
        playback: null,
        members: [{ id: "member-1", name: "Alice" }],
      },
    }),
    false,
  );
});

test("rejects room:state when shared video url is invalid", () => {
  assert.equal(
    isServerMessage({
      type: "room:state",
      payload: {
        roomCode: "ABC123",
        sharedVideo: {
          videoId: "BV1xx411c7mD",
          url: "https://example.com/video/BV1xx411c7mD",
          title: "Video",
        },
        playback: null,
        members: [{ id: "member-1", name: "Alice" }],
      },
    }),
    false,
  );
});

test("rejects room:state when playback actorId format is invalid", () => {
  assert.equal(
    isServerMessage({
      type: "room:state",
      payload: {
        roomCode: "ABC123",
        sharedVideo: null,
        playback: {
          url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
          currentTime: 12,
          playState: "playing",
          playbackRate: 1,
          updatedAt: 1,
          serverTime: 1,
          actorId: "member 1",
          seq: 1,
        },
        members: [{ id: "member-1", name: "Alice" }],
      },
    }),
    false,
  );
});

test("rejects room:state when members contain invalid items", () => {
  assert.equal(
    isServerMessage({
      type: "room:state",
      payload: {
        roomCode: "ABC123",
        sharedVideo: null,
        playback: null,
        members: [{ id: "member-1", name: 123 }],
      },
    }),
    false,
  );
});

test("rejects error when payload shape is invalid", () => {
  assert.equal(
    isServerMessage({
      type: "error",
      payload: {
        code: "room_not_found",
      },
    }),
    false,
  );
});

test("accepts a valid sync:pong message", () => {
  assert.equal(
    isServerMessage({
      type: "sync:pong",
      payload: {
        clientSendTime: 1,
        serverReceiveTime: 2,
        serverSendTime: 3,
      },
    }),
    true,
  );
});

test("accepts room:created with serverProtocolVersion", () => {
  assert.equal(
    isServerMessage({
      type: "room:created",
      payload: {
        roomCode: "ABC123",
        memberId: "member-1",
        joinToken: VALID_TOKEN,
        memberToken: VALID_TOKEN,
        serverProtocolVersion: 1,
      },
    }),
    true,
  );
});

test("accepts room:joined with serverProtocolVersion", () => {
  assert.equal(
    isServerMessage({
      type: "room:joined",
      payload: {
        roomCode: "ABC123",
        memberId: "member-1",
        memberToken: VALID_TOKEN,
        serverProtocolVersion: 1,
      },
    }),
    true,
  );
});

test("rejects room:created when serverProtocolVersion is not a positive integer", () => {
  assert.equal(
    isServerMessage({
      type: "room:created",
      payload: {
        roomCode: "ABC123",
        memberId: "member-1",
        joinToken: VALID_TOKEN,
        memberToken: VALID_TOKEN,
        serverProtocolVersion: 0,
      },
    }),
    false,
  );
});

test("rejects room:joined when serverProtocolVersion is negative", () => {
  assert.equal(
    isServerMessage({
      type: "room:joined",
      payload: {
        roomCode: "ABC123",
        memberId: "member-1",
        memberToken: VALID_TOKEN,
        serverProtocolVersion: -1,
      },
    }),
    false,
  );
});
