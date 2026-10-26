import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Announcement } from "@bili-syncplay/protocol";
import {
  ANNOUNCEMENT_BADGE_COLORS,
  applyActionBadge,
  createAnnouncementController,
  type AnnouncementBadge,
} from "../src/background/announcement-controller";
import {
  DISMISSED_ANNOUNCEMENT_LIMIT,
  type AnnouncementView,
} from "../src/shared/announcement";

// `receive` arms a real expiry timer otherwise, which would hold the run open.
beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  mock.timers.reset();
});

function makeAnnouncement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    id: "a1",
    level: "warning",
    message: "今晚 04:30 维护",
    expiresInMs: 60_000,
    ...overrides,
  };
}

function createHarness(
  options: {
    dismissedIds?: string[];
    loadFails?: boolean;
    saveFails?: boolean;
  } = {},
) {
  const state = {
    roomCode: "ROOM01" as string | null,
    serverUrl: "ws://a.example",
    nowMs: 1_000,
  };
  const badges: Array<AnnouncementBadge | null> = [];
  const pushes: Array<AnnouncementView | null> = [];
  const saved: string[][] = [];
  const logs: string[] = [];
  let notifyAllCount = 0;
  const controller = createAnnouncementController({
    getRoomCode: () => state.roomCode,
    getServerUrl: () => state.serverUrl,
    loadDismissedIds: async () => {
      if (options.loadFails) {
        throw new Error("storage unavailable");
      }
      return options.dismissedIds ?? [];
    },
    saveDismissedIds: async (ids) => {
      if (options.saveFails) {
        throw new Error("quota");
      }
      saved.push([...ids]);
    },
    setBadge: (badge) => badges.push(badge),
    notifyContentScripts: (announcement) => pushes.push(announcement),
    notifyAll: () => {
      notifyAllCount += 1;
      controller.refresh();
    },
    log: (message) => logs.push(message),
    getMonotonicNow: () => state.nowMs,
  });
  return {
    controller,
    /** From a socket opened for the configured server, unless told otherwise. */
    receive: (
      announcement: Announcement | null,
      sourceServerUrl = state.serverUrl,
    ) => controller.receive(announcement, sourceServerUrl),
    state,
    badges,
    pushes,
    saved,
    logs,
    get notifyAllCount() {
      return notifyAllCount;
    },
  };
}

test("a received announcement is shown, badged by level and pushed once", async () => {
  const harness = createHarness();
  await harness.controller.hydrate();

  harness.receive(makeAnnouncement({ scheduledAt: 5_000 }));
  harness.controller.refresh();

  assert.deepEqual(harness.controller.getVisible(), {
    id: "a1",
    level: "warning",
    message: "今晚 04:30 维护",
    scheduledAt: 5_000,
  });
  assert.deepEqual(harness.badges, [
    { text: "!", color: ANNOUNCEMENT_BADGE_COLORS.warning },
  ]);
  assert.equal(harness.pushes.length, 1);
  assert.equal(harness.pushes[0]?.id, "a1");
});

test("an info announcement gets the info colour", async () => {
  const harness = createHarness();
  harness.receive(makeAnnouncement({ level: "info" }));

  assert.deepEqual(harness.badges.at(-1), {
    text: "!",
    color: ANNOUNCEMENT_BADGE_COLORS.info,
  });
});

test("the same announcement resent does not push it again", () => {
  const harness = createHarness();
  harness.receive(makeAnnouncement());
  harness.receive(makeAnnouncement({ expiresInMs: 50_000 }));

  assert.equal(harness.pushes.length, 1);
  assert.equal(harness.badges.length, 1);
});

test("a withdrawal hides it and clears the badge", () => {
  const harness = createHarness();
  harness.receive(makeAnnouncement());
  harness.receive(null);

  assert.equal(harness.controller.getVisible(), null);
  assert.deepEqual(harness.badges.at(-1), null);
  assert.deepEqual(harness.pushes.at(-1), null);
});

test("leaving the room hides it without anyone clearing it", () => {
  const harness = createHarness();
  harness.receive(makeAnnouncement());

  harness.state.roomCode = null;
  harness.controller.refresh();

  assert.equal(harness.controller.getVisible(), null);
  assert.deepEqual(harness.badges.at(-1), null);
});

test("an announcement from the previous server is not shown on a new one", () => {
  const harness = createHarness();
  harness.receive(makeAnnouncement());

  harness.state.serverUrl = "ws://b.example";

  assert.equal(harness.controller.getVisible(), null);
});

test("one delivered by the old server during a server change is not shown as the new one's", () => {
  const harness = createHarness();
  // The configuration moves to B before A's socket is closed.
  harness.state.serverUrl = "ws://b.example";

  harness.receive(makeAnnouncement(), "ws://a.example");

  assert.equal(harness.controller.getVisible(), null);
  assert.deepEqual(harness.badges, [null]);
});

test("it lapses after its lifetime on the local clock and re-broadcasts", () => {
  const harness = createHarness();
  harness.receive(makeAnnouncement({ expiresInMs: 60_000 }));
  const notifiesAfterReceive = harness.notifyAllCount;

  harness.state.nowMs += 59_999;
  assert.equal(harness.controller.getVisible()?.id, "a1");

  harness.state.nowMs += 1;
  mock.timers.tick(60_000);

  assert.equal(harness.controller.getVisible(), null);
  assert.equal(harness.notifyAllCount, notifiesAfterReceive + 1);
  assert.deepEqual(harness.badges.at(-1), null);
});

test("a lifetime beyond the timer limit does not lapse early", () => {
  const limitMs = 2 ** 31 - 1;
  // Like a browser: a delay past the signed 32-bit limit fires at once. The
  // mocked timers take any delay, which would hide exactly this mistake.
  const mockedSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((
    callback: () => void,
    delay?: number,
  ): ReturnType<typeof setTimeout> =>
    mockedSetTimeout(
      callback,
      (delay ?? 0) > limitMs ? 1 : delay,
    )) as typeof setTimeout;
  try {
    const harness = createHarness();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    harness.receive(makeAnnouncement({ expiresInMs: thirtyDaysMs }));
    const notifiesAfterReceive = harness.notifyAllCount;

    mock.timers.tick(1);
    assert.equal(harness.notifyAllCount, notifiesAfterReceive);

    // The first timer fires at the limit, well before the end.
    harness.state.nowMs += limitMs;
    mock.timers.tick(limitMs);
    assert.equal(harness.controller.getVisible()?.id, "a1");

    harness.state.nowMs += thirtyDaysMs - limitMs;
    mock.timers.tick(thirtyDaysMs - limitMs);
    assert.equal(harness.controller.getVisible(), null);
    assert.deepEqual(harness.badges.at(-1), null);
  } finally {
    globalThis.setTimeout = mockedSetTimeout;
  }
});

test("dismissing hides it everywhere and remembers the id", async () => {
  const harness = createHarness();
  await harness.controller.hydrate();
  harness.receive(makeAnnouncement());

  await harness.controller.dismiss("a1");

  assert.equal(harness.controller.getVisible(), null);
  assert.deepEqual(harness.badges.at(-1), null);
  assert.deepEqual(harness.pushes.at(-1), null);
  assert.deepEqual(harness.saved, [["a1"]]);

  harness.receive(makeAnnouncement());
  assert.equal(harness.controller.getVisible(), null);

  harness.receive(makeAnnouncement({ id: "a2" }));
  assert.equal(harness.controller.getVisible()?.id, "a2");
});

test("only the most recent dismissals are kept", async () => {
  const existing = Array.from(
    { length: DISMISSED_ANNOUNCEMENT_LIMIT },
    (_, index) => `old${index}`,
  );
  const harness = createHarness({ dismissedIds: existing });
  await harness.controller.hydrate();

  await harness.controller.dismiss("new");

  const last = harness.saved.at(-1) ?? [];
  assert.equal(last.length, DISMISSED_ANNOUNCEMENT_LIMIT);
  assert.equal(last.at(-1), "new");
  assert.equal(last.includes("old0"), false);
  assert.equal(last.includes("old1"), true);
});

test("a dismissal remembered from before is honoured", async () => {
  const harness = createHarness({ dismissedIds: ["a1"] });
  await harness.controller.hydrate();

  harness.receive(makeAnnouncement());

  assert.equal(harness.controller.getVisible(), null);
});

test("storage failures neither throw nor keep a dismissed one on screen", async () => {
  const harness = createHarness({ loadFails: true, saveFails: true });
  await harness.controller.hydrate();
  harness.receive(makeAnnouncement());

  await harness.controller.dismiss("a1");

  assert.equal(harness.controller.getVisible(), null);
  assert.equal(harness.logs.length, 2);
});

test("the first refresh writes the badge even with nothing to show", () => {
  // A restarted service worker has lost its announcement, but the browser
  // still shows the badge the previous one set.
  const harness = createHarness();

  harness.controller.refresh();

  assert.deepEqual(harness.badges, [null]);
  assert.deepEqual(harness.pushes, [null]);
});

test("a badge write never throws", () => {
  assert.doesNotThrow(() =>
    applyActionBadge(undefined, { text: "!", color: "#000" }),
  );
  assert.doesNotThrow(() =>
    applyActionBadge(
      {
        setBadgeText: () => {
          throw new Error("unsupported");
        },
        setBadgeBackgroundColor: () => Promise.resolve(),
      },
      { text: "!", color: "#000" },
    ),
  );
});
