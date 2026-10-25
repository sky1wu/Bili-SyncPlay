import assert from "node:assert/strict";
import test from "node:test";
import type { ServerMessage } from "@bili-syncplay/protocol";
import {
  parseStoredAnnouncement,
  toWireAnnouncement,
  type AnnouncementSnapshot,
  type StoredAnnouncement,
} from "../src/announcement.js";
import {
  ANNOUNCEMENT_PROTOCOL_VERSION,
  createAnnouncementBroadcaster,
} from "../src/announcement-broadcaster.js";
import { createInMemoryRoomStore } from "../src/room-store.js";
import type { AttachedSession, Session } from "../src/types.js";

const STORED: StoredAnnouncement = {
  id: "announcement-1",
  level: "warning",
  message: "今晚 04:30 维护，预计中断 5 分钟",
  scheduledAt: 1_792_900_000_000,
  publishedAt: 1_792_800_000_000,
};

function snapshot(
  overrides: Partial<StoredAnnouncement> = {},
  remainingMs = 60_000,
): AnnouncementSnapshot {
  return { announcement: { ...STORED, ...overrides }, remainingMs };
}

type FakeSocket = { id: string };

function createSession(
  id: string,
  protocolVersion: number | undefined,
  attached = true,
): Session {
  const base = {
    id,
    remoteAddress: "127.0.0.1",
    origin: "chrome-extension://allowed-extension",
    roomCode: "ROOM01",
    memberId: id,
    displayName: id,
    memberToken: `token-${id}`,
    protocolVersion,
    joinedAt: 1_000,
    invalidMessageCount: 0,
    rateLimitState: {
      roomCreate: { windowStart: 0, count: 0 },
      roomJoin: { windowStart: 0, count: 0 },
      videoShare: { windowStart: 0, count: 0 },
      playbackUpdate: { tokens: 0, lastRefillAt: 0 },
      syncRequest: { windowStart: 0, count: 0 },
      syncPing: { tokens: 0, lastRefillAt: 0 },
    },
  };
  if (!attached) {
    return { ...base, connectionState: "detached", socket: null };
  }
  const socket: FakeSocket = { id };
  return {
    ...base,
    connectionState: "attached",
    // The broadcaster only hands the socket back to `send`; the fake is never
    // used as a socket.
    socket: socket as unknown as AttachedSession["socket"],
  };
}

function createHarness(
  options: {
    sessions?: Session[];
    read?: () => Promise<AnnouncementSnapshot | null>;
  } = {},
) {
  let reply: AnnouncementSnapshot | null = null;
  let clock = 1_000;
  const sent: Array<{ to: string; message: ServerMessage }> = [];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const broadcaster = createAnnouncementBroadcaster({
    readAnnouncement: options.read ?? (async () => reply),
    listRoomSessions: () => options.sessions ?? [],
    send: (socket, message) => {
      sent.push({ to: (socket as unknown as FakeSocket).id, message });
    },
    logEvent: (event, data) => {
      events.push({ event, data });
    },
    monotonicNow: () => clock,
  });
  return {
    broadcaster,
    sent,
    events,
    setReply(value: AnnouncementSnapshot | null) {
      reply = value;
    },
    advance(ms: number) {
      clock += ms;
    },
  };
}

function announcementOf(message: ServerMessage) {
  assert.equal(message.type, "server:announcement");
  return message.type === "server:announcement"
    ? message.payload.announcement
    : undefined;
}

test("parses a stored announcement back, with or without a schedule", () => {
  assert.deepEqual(parseStoredAnnouncement(JSON.stringify(STORED)), STORED);
  const unscheduled = { ...STORED, scheduledAt: null };
  assert.deepEqual(
    parseStoredAnnouncement(JSON.stringify(unscheduled)),
    unscheduled,
  );
});

test("refuses a stored body every receiver would refuse", () => {
  const bodies = [
    "not json",
    "null",
    JSON.stringify({ ...STORED, level: "critical" }),
    JSON.stringify({ ...STORED, message: "" }),
    JSON.stringify({ ...STORED, id: "has space" }),
    JSON.stringify({ ...STORED, scheduledAt: "04:30" }),
    JSON.stringify({ ...STORED, publishedAt: undefined }),
  ];
  for (const body of bodies) {
    assert.equal(parseStoredAnnouncement(body), null, body);
  }
});

test("the wire lifetime is what remains after the elapsed time", () => {
  assert.deepEqual(toWireAnnouncement(snapshot({}, 60_000), 15_000), {
    id: STORED.id,
    level: STORED.level,
    message: STORED.message,
    scheduledAt: STORED.scheduledAt,
    expiresInMs: 45_000,
  });
  const wire = toWireAnnouncement(snapshot({ scheduledAt: null }), 0);
  assert.equal(wire !== null && "scheduledAt" in wire, false);
});

test("an announcement whose lifetime ran out goes out as none", () => {
  assert.equal(toWireAnnouncement(snapshot({}, 10_000), 10_000), null);
  assert.equal(toWireAnnouncement(snapshot({}, 10_000), 20_000), null);
});

test("the in-memory store reports the remaining lifetime and lets it lapse", async () => {
  let now = 5_000;
  const store = createInMemoryRoomStore({ now: () => now });
  assert.equal(await store.getAnnouncement(), null);

  await store.setAnnouncement(STORED, 30_000);
  now += 10_000;
  assert.deepEqual(await store.getAnnouncement(), {
    announcement: STORED,
    remainingMs: 20_000,
  });

  now += 20_000;
  assert.equal(await store.getAnnouncement(), null);

  await store.setAnnouncement(STORED, 30_000);
  await store.clearAnnouncement();
  assert.equal(await store.getAnnouncement(), null);
});

test("the first poll is broadcast to every capable session in a room", async () => {
  const harness = createHarness({
    sessions: [
      createSession("current", ANNOUNCEMENT_PROTOCOL_VERSION),
      createSession("future", ANNOUNCEMENT_PROTOCOL_VERSION + 1),
      createSession("old", ANNOUNCEMENT_PROTOCOL_VERSION - 1),
      createSession("legacy", undefined),
      createSession("detached", ANNOUNCEMENT_PROTOCOL_VERSION, false),
    ],
  });
  harness.setReply(snapshot());
  await harness.broadcaster.pollNow();

  assert.deepEqual(
    harness.sent.map((entry) => entry.to),
    ["current", "future"],
  );
  assert.equal(announcementOf(harness.sent[0].message)?.id, STORED.id);
});

test("a first poll that finds nothing still goes out, to clear a stale notice", async () => {
  const harness = createHarness({
    sessions: [createSession("a", ANNOUNCEMENT_PROTOCOL_VERSION)],
  });
  await harness.broadcaster.pollNow();
  assert.equal(harness.sent.length, 1);
  assert.equal(announcementOf(harness.sent[0].message), null);
});

test("only a change of announcement is broadcast", async () => {
  const harness = createHarness({
    sessions: [createSession("a", ANNOUNCEMENT_PROTOCOL_VERSION)],
  });
  harness.setReply(snapshot());
  await harness.broadcaster.pollNow();
  await harness.broadcaster.pollNow();
  assert.equal(harness.sent.length, 1);

  harness.setReply(snapshot({ id: "announcement-2" }));
  await harness.broadcaster.pollNow();
  assert.equal(harness.sent.length, 2);
  assert.equal(announcementOf(harness.sent[1].message)?.id, "announcement-2");

  harness.setReply(null);
  await harness.broadcaster.pollNow();
  assert.equal(harness.sent.length, 3);
  assert.equal(announcementOf(harness.sent[2].message), null);
});

test("a failed poll keeps the last announcement instead of withdrawing it", async () => {
  let fail = false;
  const sessions = [createSession("a", ANNOUNCEMENT_PROTOCOL_VERSION)];
  const harness = createHarness({
    sessions,
    read: async () => {
      if (fail) {
        throw new Error("redis down");
      }
      return snapshot();
    },
  });
  await harness.broadcaster.pollNow();
  assert.equal(harness.sent.length, 1);

  fail = true;
  await harness.broadcaster.pollNow();
  assert.equal(harness.sent.length, 1);
  assert.equal(
    harness.events.some((entry) => entry.event === "announcement_poll_failed"),
    true,
  );

  // A session joining while Redis is down still gets the last known notice.
  const joiner = createSession("joiner", ANNOUNCEMENT_PROTOCOL_VERSION);
  harness.broadcaster.sendCurrentTo(joiner);
  assert.equal(harness.sent.length, 2);
  assert.equal(announcementOf(harness.sent[1].message)?.id, STORED.id);
});

test("a joining session gets nothing before the first poll answered", () => {
  const harness = createHarness();
  harness.broadcaster.sendCurrentTo(
    createSession("joiner", ANNOUNCEMENT_PROTOCOL_VERSION),
  );
  assert.equal(harness.sent.length, 0);
});

test("a joining session gets the current state, none included", async () => {
  const harness = createHarness();
  await harness.broadcaster.pollNow();
  harness.broadcaster.sendCurrentTo(
    createSession("joiner", ANNOUNCEMENT_PROTOCOL_VERSION),
  );
  assert.equal(harness.sent.length, 1);
  assert.equal(announcementOf(harness.sent[0].message), null);
});

test("a joining session below the announcement version gets nothing", async () => {
  const harness = createHarness();
  harness.setReply(snapshot());
  await harness.broadcaster.pollNow();
  harness.broadcaster.sendCurrentTo(
    createSession("old", ANNOUNCEMENT_PROTOCOL_VERSION - 1),
  );
  harness.broadcaster.sendCurrentTo(createSession("legacy", undefined));
  assert.equal(harness.sent.length, 0);
});

test("the lifetime sent to a joiner counts the time since the read began", async () => {
  const pending: { release: (() => void) | null } = { release: null };
  const harness = createHarness({
    read: () =>
      new Promise((resolve) => {
        pending.release = () => resolve(snapshot({}, 60_000));
      }),
  });
  const poll = harness.broadcaster.pollNow();
  // The round trip itself counts as elapsed: the lifetime can only err short.
  harness.advance(2_000);
  pending.release?.();
  await poll;
  harness.advance(8_000);

  harness.broadcaster.sendCurrentTo(
    createSession("joiner", ANNOUNCEMENT_PROTOCOL_VERSION),
  );
  assert.equal(
    announcementOf(harness.sent[0].message)?.expiresInMs,
    60_000 - 10_000,
  );

  // Past its lifetime the cached announcement goes out as none, even before
  // the next poll notices.
  harness.advance(60_000);
  harness.broadcaster.sendCurrentTo(
    createSession("late", ANNOUNCEMENT_PROTOCOL_VERSION),
  );
  assert.equal(announcementOf(harness.sent[1].message), null);
});
