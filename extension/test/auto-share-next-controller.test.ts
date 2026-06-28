import assert from "node:assert/strict";
import test from "node:test";
import { createAutoShareNextController } from "../src/content/auto-share-next-controller";

function normalizeTestVideoPageUrl(url: string): string | null {
  return url.match(/https:\/\/www\.bilibili\.com\/video\/[^/?]+/)?.[0] ?? null;
}

function installWindowStub() {
  const originalWindow = globalThis.window;
  const timers = new Map<number, () => void>();
  let nextTimer = 1;

  Object.assign(globalThis, {
    window: {
      setTimeout(callback: () => void) {
        const timer = nextTimer;
        nextTimer += 1;
        timers.set(timer, callback);
        return timer;
      },
      clearTimeout(timer: number) {
        timers.delete(timer);
      },
    },
  });

  return {
    timers,
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) {
        callback();
      }
    },
    restore() {
      Object.assign(globalThis, { window: originalWindow });
    },
  };
}

test("auto-share next controller sends a request after the navigation settles", async () => {
  const windowHarness = installWindowStub();
  let currentUrl = "https://www.bilibili.com/video/BV1NextVideo";
  const sentMessages: unknown[] = [];
  const debugLogs: string[] = [];
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
    debugLog: (message) => {
      debugLogs.push(message);
    },
  });

  try {
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });

    assert.equal(windowHarness.timers.size, 1);
    windowHarness.runTimers();
    await Promise.resolve();

    assert.deepEqual(sentMessages, [
      {
        type: "content:auto-share-next-video",
        payload: {
          previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
          targetNormalizedUrl: "https://www.bilibili.com/video/BV1NextVideo",
        },
      },
    ]);
    // Diagnostic logs trace the full happy path: schedule → send → accepted.
    assert.deepEqual(debugLogs, [
      "Auto-share scheduled target=https://www.bilibili.com/video/BV1NextVideo from=https://www.bilibili.com/video/BV1OldVideo chained=false gen=1 delayMs=900",
      "Auto-share sending to background target=https://www.bilibili.com/video/BV1NextVideo from=https://www.bilibili.com/video/BV1OldVideo attempt=1/4 gen=1",
      "Auto-share accepted by background (ok=true) target=https://www.bilibili.com/video/BV1NextVideo from=https://www.bilibili.com/video/BV1OldVideo",
    ]);
  } finally {
    currentUrl = "";
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller re-anchors to its own confirmed previous step before sending", async () => {
  // A→B→C chained autoplay. B is sent first (room still on A), then B→C is
  // scheduled. B's room state confirms during C's settle window, so the live
  // shared video is now B. C must re-anchor to B (a video this chain already
  // sent), not the stale A, so the background stays "on-scheduled" and advances.
  const windowHarness = installWindowStub();
  const sentMessages: unknown[] = [];
  let currentUrl = "https://www.bilibili.com/video/BV1BVideo";
  let activeSharedUrl: string | null =
    "https://www.bilibili.com/video/BV1AVideo";
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    getActiveSharedUrl: () => activeSharedUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
    debugLog: () => {},
  });

  try {
    // A→B: fresh chain start, sent while the room is still on A.
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1AVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1BVideo",
      previousAutoShareTargetUrl: null,
    });
    windowHarness.runTimers();
    await Promise.resolve();

    // B→C: chained step, still anchored to A because B has not confirmed yet.
    currentUrl = "https://www.bilibili.com/video/BV1CVideo";
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1AVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1CVideo",
      previousAutoShareTargetUrl: "https://www.bilibili.com/video/BV1BVideo",
    });
    // B confirms during C's settle window.
    activeSharedUrl = "https://www.bilibili.com/video/BV1BVideo";
    windowHarness.runTimers();
    await Promise.resolve();

    assert.deepEqual(sentMessages, [
      {
        type: "content:auto-share-next-video",
        payload: {
          previousSharedUrl: "https://www.bilibili.com/video/BV1AVideo",
          targetNormalizedUrl: "https://www.bilibili.com/video/BV1BVideo",
        },
      },
      {
        type: "content:auto-share-next-video",
        payload: {
          previousSharedUrl: "https://www.bilibili.com/video/BV1BVideo",
          targetNormalizedUrl: "https://www.bilibili.com/video/BV1CVideo",
        },
      },
    ]);
  } finally {
    currentUrl = "";
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller does not re-anchor to an unrelated video the room moved to", async () => {
  // A→B auto-share queued (no prior chain step). During the settle window the
  // same member manually shares X from another tab and it confirms, so the live
  // shared video is now X. X is NOT our own previous chain step, so the request
  // must keep the scheduled anchor A — letting the background skip this stale
  // auto-share as moved-on rather than clobber the manual X with B.
  const windowHarness = installWindowStub();
  const sentMessages: unknown[] = [];
  let activeSharedUrl: string | null =
    "https://www.bilibili.com/video/BV1AVideo";
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    getCurrentPageUrl: () => "https://www.bilibili.com/video/BV1BVideo",
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    getActiveSharedUrl: () => activeSharedUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
    debugLog: () => {},
  });

  try {
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1AVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1BVideo",
      previousAutoShareTargetUrl: null,
    });
    // A manual share X confirms during the settle window.
    activeSharedUrl = "https://www.bilibili.com/video/BV1XVideo";
    windowHarness.runTimers();
    await Promise.resolve();

    assert.deepEqual(sentMessages, [
      {
        type: "content:auto-share-next-video",
        payload: {
          previousSharedUrl: "https://www.bilibili.com/video/BV1AVideo",
          targetNormalizedUrl: "https://www.bilibili.com/video/BV1BVideo",
        },
      },
    ]);
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller re-anchors to an earlier sent step that confirms across deeper lag", async () => {
  // A→B sent (room still on A). The page then rapidly advances B→C→D before B
  // confirms, so C is superseded and only D is ultimately sent. B (not the
  // immediately-prior page C) is the in-flight share that confirms during D's
  // settle window. Because B was actually sent by this chain, D must still
  // re-anchor to B — the immediately-prior target C would miss it.
  const windowHarness = installWindowStub();
  const sentMessages: unknown[] = [];
  let currentUrl = "https://www.bilibili.com/video/BV1BVideo";
  let activeSharedUrl: string | null =
    "https://www.bilibili.com/video/BV1AVideo";
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    getActiveSharedUrl: () => activeSharedUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
    debugLog: () => {},
  });

  try {
    // A→B: fresh chain, sent while the room is still on A.
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1AVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1BVideo",
      previousAutoShareTargetUrl: null,
    });
    windowHarness.runTimers();
    await Promise.resolve();

    // B→C then C→D before B confirms: C's pending timer is superseded by D, so
    // only D is ever sent. Both stay anchored to A (B unconfirmed at schedule).
    currentUrl = "https://www.bilibili.com/video/BV1CVideo";
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1AVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1CVideo",
      previousAutoShareTargetUrl: "https://www.bilibili.com/video/BV1BVideo",
    });
    currentUrl = "https://www.bilibili.com/video/BV1DVideo";
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1AVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1DVideo",
      previousAutoShareTargetUrl: "https://www.bilibili.com/video/BV1CVideo",
    });
    // B (the only step actually sent before D) confirms during D's settle window.
    activeSharedUrl = "https://www.bilibili.com/video/BV1BVideo";
    windowHarness.runTimers();
    await Promise.resolve();

    assert.deepEqual(sentMessages, [
      {
        type: "content:auto-share-next-video",
        payload: {
          previousSharedUrl: "https://www.bilibili.com/video/BV1AVideo",
          targetNormalizedUrl: "https://www.bilibili.com/video/BV1BVideo",
        },
      },
      {
        type: "content:auto-share-next-video",
        payload: {
          previousSharedUrl: "https://www.bilibili.com/video/BV1BVideo",
          targetNormalizedUrl: "https://www.bilibili.com/video/BV1DVideo",
        },
      },
    ]);
  } finally {
    currentUrl = "";
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller skips a settled request when the page moved again", async () => {
  const windowHarness = installWindowStub();
  let currentUrl = "https://www.bilibili.com/video/BV1NextVideo";
  const sentMessages: unknown[] = [];
  const debugLogs: string[] = [];
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
    debugLog: (message) => {
      debugLogs.push(message);
    },
  });

  try {
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });
    currentUrl = "https://www.bilibili.com/video/BV1OtherVideo";
    windowHarness.runTimers();
    await Promise.resolve();

    assert.deepEqual(sentMessages, []);
    // The schedule diagnostic plus the moved-page skip diagnostic.
    assert.equal(debugLogs.length, 2);
    assert.match(debugLogs[0], /^Auto-share scheduled /);
    assert.match(
      debugLogs[1],
      /^Skipped auto-share next video because page moved /,
    );
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller retries when the background reports the page is not ready", async () => {
  const windowHarness = installWindowStub();
  const sentMessages: unknown[] = [];
  const responses = [{ ok: false }, { ok: true }];
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    retryDelayMs: 300,
    maxAttempts: 4,
    getCurrentPageUrl: () => "https://www.bilibili.com/video/BV1NextVideo",
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      return responses.shift() ?? { ok: true };
    },
    debugLog: () => {},
  });

  try {
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });

    windowHarness.runTimers();
    await Promise.resolve();
    await Promise.resolve();
    // A retry timer should have been armed after the first failure.
    assert.equal(windowHarness.timers.size, 1);

    windowHarness.runTimers();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(sentMessages.length, 2);
    assert.deepEqual(sentMessages[1], {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
        targetNormalizedUrl: "https://www.bilibili.com/video/BV1NextVideo",
      },
    });
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller keeps retrying offline deferrals without consuming the attempt budget", async () => {
  const windowHarness = installWindowStub();
  const sentMessages: unknown[] = [];
  const responses = [
    { ok: false, deferred: true },
    { ok: false, deferred: true },
    { ok: false, deferred: true },
    { ok: true },
  ];
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    retryDelayMs: 300,
    maxAttempts: 2,
    getCurrentPageUrl: () => "https://www.bilibili.com/video/BV1NextVideo",
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      return responses.shift() ?? { ok: true };
    },
    debugLog: () => {},
  });

  try {
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });

    for (let i = 0; i < 5; i += 1) {
      windowHarness.runTimers();
      await Promise.resolve();
      await Promise.resolve();
    }

    // Despite maxAttempts=2, the three offline deferrals did not burn the
    // page-bridge attempt budget, so the eventual successful share still went
    // through once the sharer reconnected — 4 sends total.
    assert.equal(sentMessages.length, 4);
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller stops retrying after the maximum attempts", async () => {
  const windowHarness = installWindowStub();
  const sentMessages: unknown[] = [];
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    retryDelayMs: 300,
    maxAttempts: 3,
    getCurrentPageUrl: () => "https://www.bilibili.com/video/BV1NextVideo",
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      return { ok: false };
    },
    debugLog: () => {},
  });

  try {
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });

    for (let i = 0; i < 6; i += 1) {
      windowHarness.runTimers();
      await Promise.resolve();
      await Promise.resolve();
    }

    assert.equal(sentMessages.length, 3);
    assert.equal(windowHarness.timers.size, 0);
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller retry does not cancel a newer navigation's pending request", async () => {
  const windowHarness = installWindowStub();
  let currentUrl = "https://www.bilibili.com/video/BV1FirstVideo";
  const sentMessages: unknown[] = [];
  let resolveFirst: ((value: { ok: boolean }) => void) | null = null;
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    retryDelayMs: 300,
    maxAttempts: 4,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      if (sentMessages.length === 1) {
        return await new Promise<{ ok: boolean }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { ok: true };
    },
    debugLog: () => {},
  });

  try {
    // First navigation settles and starts an in-flight (awaiting) request.
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1FirstVideo",
    });
    windowHarness.runTimers();
    await Promise.resolve();
    assert.equal(sentMessages.length, 1);

    // A newer navigation arrives while the first request is still awaiting and
    // arms its own settle timer.
    currentUrl = "https://www.bilibili.com/video/BV1SecondVideo";
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1SecondVideo",
    });
    assert.equal(windowHarness.timers.size, 1);

    // The first (now stale) request fails. Its retry must not cancel the newer
    // navigation's pending timer.
    resolveFirst?.({ ok: false });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(windowHarness.timers.size, 1);

    // The surviving timer belongs to the second video and shares it.
    windowHarness.runTimers();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sentMessages.length, 2);
    assert.deepEqual(sentMessages[1], {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
        targetNormalizedUrl: "https://www.bilibili.com/video/BV1SecondVideo",
      },
    });
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller supersedes an in-flight request when a new navigation returns to the same target", async () => {
  const windowHarness = installWindowStub();
  let currentUrl = "https://www.bilibili.com/video/BV1FirstVideo";
  const sentMessages: unknown[] = [];
  let resolveFirst: ((value: { ok: boolean }) => void) | null = null;
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    retryDelayMs: 300,
    maxAttempts: 4,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      if (sentMessages.length === 1) {
        return await new Promise<{ ok: boolean }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { ok: true };
    },
    debugLog: () => {},
  });

  try {
    // Sharer autoplays A→B; B's request settles and starts an in-flight send.
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1FirstVideo",
    });
    windowHarness.runTimers();
    await Promise.resolve();
    assert.equal(sentMessages.length, 1);

    // The page autoplays on to C and then back to B while B's request is still
    // awaiting. The return-to-B navigation must NOT be dropped as a duplicate —
    // it supersedes the stale in-flight request with a fresh round.
    currentUrl = "https://www.bilibili.com/video/BV1SecondVideo";
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1SecondVideo",
    });
    currentUrl = "https://www.bilibili.com/video/BV1FirstVideo";
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1FirstVideo",
    });

    // The original B request resolves but is now stale and abandons itself.
    resolveFirst?.({ ok: false });
    await Promise.resolve();
    await Promise.resolve();

    // The freshest round (back to B) is the only pending timer and shares B.
    assert.equal(windowHarness.timers.size, 1);
    windowHarness.runTimers();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(sentMessages.length, 2);
    assert.deepEqual(sentMessages[1], {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
        targetNormalizedUrl: "https://www.bilibili.com/video/BV1FirstVideo",
      },
    });
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller re-sends the same target after a superseded request bails and the page moves on", async () => {
  const windowHarness = installWindowStub();
  let currentUrl = "https://www.bilibili.com/video/BV1FirstVideo";
  const sentMessages: unknown[] = [];
  let resolveFirst: ((value: { ok: boolean }) => void) | null = null;
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    retryDelayMs: 300,
    maxAttempts: 4,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      if (sentMessages.length === 1) {
        return await new Promise<{ ok: boolean }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { ok: true };
    },
    debugLog: () => {},
  });

  try {
    // First navigation to B settles and starts an in-flight request.
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1FirstVideo",
    });
    windowHarness.runTimers();
    await Promise.resolve();
    assert.equal(sentMessages.length, 1);

    // A newer navigation to C supersedes it (bumps the generation) and arms its
    // own settle timer.
    currentUrl = "https://www.bilibili.com/video/BV1SecondVideo";
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1SecondVideo",
    });

    // The stale B request resolves and abandons itself because its generation is
    // stale, leaving no trace that could suppress a future request for B.
    resolveFirst?.({ ok: true });
    await Promise.resolve();
    await Promise.resolve();

    // The page moves on again before the C request runs, so the superseding
    // request bails early without sending.
    currentUrl = "https://www.bilibili.com/video/BV1ThirdVideo";
    windowHarness.runTimers();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sentMessages.length, 1);

    // The room later returns to B and the sharer autoplays back into it. This
    // legitimate navigation must still schedule and send a fresh request.
    currentUrl = "https://www.bilibili.com/video/BV1FirstVideo";
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1FirstVideo",
    });
    assert.equal(windowHarness.timers.size, 1);
    windowHarness.runTimers();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(sentMessages.length, 2);
    assert.deepEqual(sentMessages[1], {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
        targetNormalizedUrl: "https://www.bilibili.com/video/BV1FirstVideo",
      },
    });
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller supersedes a pending request when the same target arrives from a different source video", async () => {
  const windowHarness = installWindowStub();
  const currentUrl = "https://www.bilibili.com/video/BV1NextVideo";
  const sentMessages: Array<{
    type: string;
    payload: { previousSharedUrl: string; targetNormalizedUrl: string };
  }> = [];
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(
        message as {
          type: string;
          payload: { previousSharedUrl: string; targetNormalizedUrl: string };
        },
      );
      return { ok: true };
    },
    debugLog: () => {},
  });

  try {
    // A→B is scheduled and its settle timer is still pending.
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1VideoA",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });
    assert.equal(windowHarness.timers.size, 1);

    // The room advanced A→C and the sharer autoplays C→B (same target B, new
    // source C). This must replace the pending A→B request, not be dropped as a
    // duplicate — otherwise the stale A→B would run and the background would
    // reject it (room no longer on A), leaving the room behind on C.
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1VideoC",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });
    assert.equal(windowHarness.timers.size, 1);

    windowHarness.runTimers();
    await Promise.resolve();

    assert.equal(sentMessages.length, 1);
    assert.equal(
      sentMessages[0].payload.previousSharedUrl,
      "https://www.bilibili.com/video/BV1VideoC",
    );
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller re-shares the same target after the previous request settled", async () => {
  const windowHarness = installWindowStub();
  const currentUrl = "https://www.bilibili.com/video/BV1NextVideo";
  const sentMessages: unknown[] = [];
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
    debugLog: () => {},
  });

  try {
    // The room is on A and the sharer autoplays A→B. The share completes.
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });
    windowHarness.runTimers();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sentMessages.length, 1);

    // Later the room returns to A and the sharer autoplays A→B again. The
    // settled dedup marker must not suppress this legitimate fresh request.
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });
    assert.equal(windowHarness.timers.size, 1);
    windowHarness.runTimers();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(sentMessages.length, 2);
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller deduplicates repeated requests for the same target", () => {
  const windowHarness = installWindowStub();
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    getCurrentPageUrl: () => "https://www.bilibili.com/video/BV1NextVideo",
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async () => ({ ok: true }),
    debugLog: () => {},
  });

  try {
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });

    assert.equal(windowHarness.timers.size, 1);
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller cancels a pending request when navigation is not autoplay", () => {
  const windowHarness = installWindowStub();
  const sentMessages: unknown[] = [];
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    getCurrentPageUrl: () => "https://www.bilibili.com/video/BV1NextVideo",
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
    debugLog: () => {},
  });

  try {
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });
    assert.equal(windowHarness.timers.size, 1);

    // A manual detour back to the same target cancels the pending settle timer
    // so it cannot fire and auto-share without the manual confirmation.
    controller.cancelPending();
    assert.equal(windowHarness.timers.size, 0);

    windowHarness.runTimers();
    assert.deepEqual(sentMessages, []);
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller invalidates an in-flight request after cancelPending", async () => {
  const windowHarness = installWindowStub();
  const sentMessages: unknown[] = [];
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    getCurrentPageUrl: () => "https://www.bilibili.com/video/BV1NextVideo",
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      // The page bridge is not ready: without cancellation this would schedule a
      // retry. cancelPending (a manual navigation) must abandon it instead.
      return { ok: false };
    },
    debugLog: () => {},
  });

  try {
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });
    windowHarness.runTimers();
    // Cancel while the request is in flight (before its response resolves).
    controller.cancelPending();
    await Promise.resolve();
    await Promise.resolve();

    // The stale request abandons itself: no retry timer is armed.
    assert.equal(sentMessages.length, 1);
    assert.equal(windowHarness.timers.size, 0);
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});
