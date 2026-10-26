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

test("accepts room member delta messages", () => {
  assert.equal(
    isServerMessage({
      type: "room:member-joined",
      payload: {
        roomCode: "ABC123",
        member: { id: "member-1", name: "Alice" },
      },
    }),
    true,
  );
  assert.equal(
    isServerMessage({
      type: "room:member-left",
      payload: {
        roomCode: "ABC123",
        member: { id: "member-2", name: "Bob" },
      },
    }),
    true,
  );
});

test("rejects room member delta messages with invalid member payloads", () => {
  assert.equal(
    isServerMessage({
      type: "room:member-joined",
      payload: {
        roomCode: "ABC123",
        member: { id: "member 1", name: "Alice" },
      },
    }),
    false,
  );
  assert.equal(
    isServerMessage({
      type: "room:member-left",
      payload: {
        roomCode: "ABC123",
        member: { id: "member-2", name: "x".repeat(33) },
      },
    }),
    false,
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

test("accepts room:state when playback carries userInitiated:true", () => {
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
          playState: "paused",
          userInitiated: true,
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

test("rejects room:state when playback userInitiated is non-boolean", () => {
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
          playState: "paused",
          userInitiated: "yes",
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

test("accepts room:state when playback carries naturalEnd:true", () => {
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
          currentTime: 262.5,
          playState: "paused",
          naturalEnd: true,
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

test("rejects room:state when playback naturalEnd is non-boolean", () => {
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
          currentTime: 262.5,
          playState: "paused",
          naturalEnd: "yes",
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

function roomStatePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
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
      playbackRate: 1,
      updatedAt: 1,
      serverTime: 1,
      actorId: "member-1",
      seq: 1,
    },
    members: [{ id: "member-1", name: "Alice" }],
    ...overrides,
  };
}

test("accepts room:state carrying a playback age", () => {
  assert.equal(
    isServerMessage({
      type: "room:state",
      payload: roomStatePayload({ playbackAgeMs: 2_100 }),
    }),
    true,
  );
});

test("accepts room:state from a server that omits the playback age", () => {
  assert.equal(
    isServerMessage({ type: "room:state", payload: roomStatePayload() }),
    true,
  );
});

test("accepts a zero playback age", () => {
  assert.equal(
    isServerMessage({
      type: "room:state",
      payload: roomStatePayload({ playbackAgeMs: 0 }),
    }),
    true,
  );
});

test("rejects a negative playback age", () => {
  // A duration cannot be negative, and a receiver that had to interpret one
  // would be extrapolating a snapshot from the future.
  assert.equal(
    isServerMessage({
      type: "room:state",
      payload: roomStatePayload({ playbackAgeMs: -1 }),
    }),
    false,
  );
});

test("rejects a non-numeric playback age", () => {
  assert.equal(
    isServerMessage({
      type: "room:state",
      payload: roomStatePayload({ playbackAgeMs: "2100" }),
    }),
    false,
  );
});

test("rejects a non-finite playback age", () => {
  assert.equal(
    isServerMessage({
      type: "room:state",
      payload: roomStatePayload({ playbackAgeMs: Number.POSITIVE_INFINITY }),
    }),
    false,
  );
});

function announcementMessage(announcement: unknown) {
  return { type: "server:announcement", payload: { announcement } };
}

const VALID_ANNOUNCEMENT = {
  id: "0b6f0c2e-5d8a-4c1e-9f3a-2b7d6e1a9c40",
  level: "warning",
  message: "今晚 04:30 维护，预计中断 5 分钟",
  scheduledAt: 1_792_900_000_000,
  expiresInMs: 3_600_000,
};

test("accepts a server:announcement carrying an announcement", () => {
  assert.equal(isServerMessage(announcementMessage(VALID_ANNOUNCEMENT)), true);
  const { scheduledAt: _omitted, ...withoutSchedule } = VALID_ANNOUNCEMENT;
  assert.equal(isServerMessage(announcementMessage(withoutSchedule)), true);
  assert.equal(
    isServerMessage(
      announcementMessage({ ...VALID_ANNOUNCEMENT, level: "info" }),
    ),
    true,
  );
});

test("accepts a server:announcement withdrawing the announcement", () => {
  assert.equal(isServerMessage(announcementMessage(null)), true);
});

test("rejects a server:announcement without an announcement field", () => {
  assert.equal(
    isServerMessage({ type: "server:announcement", payload: {} }),
    false,
  );
});

test("rejects announcements that break a bound receivers rely on", () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["unknown level", { level: "critical" }],
    ["empty id", { id: "" }],
    ["id with spaces", { id: "has space" }],
    ["id too long", { id: "a".repeat(65) }],
    ["blank message", { message: "   " }],
    ["message too long", { message: "x".repeat(501) }],
    ["negative schedule", { scheduledAt: -1 }],
    ["non-numeric schedule", { scheduledAt: "04:30" }],
    ["expired lifetime", { expiresInMs: 0 }],
    ["negative lifetime", { expiresInMs: -5 }],
    ["missing lifetime", { expiresInMs: undefined }],
    ["infinite lifetime", { expiresInMs: Number.POSITIVE_INFINITY }],
  ];
  for (const [label, override] of invalid) {
    assert.equal(
      isServerMessage(
        announcementMessage({ ...VALID_ANNOUNCEMENT, ...override }),
      ),
      false,
      label,
    );
  }
});

test("accepts announcements at the exact length bounds", () => {
  assert.equal(
    isServerMessage(
      announcementMessage({
        ...VALID_ANNOUNCEMENT,
        id: "a".repeat(64),
        message: "x".repeat(500),
      }),
    ),
    true,
  );
});
