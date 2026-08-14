import assert from "node:assert/strict";
import test from "node:test";
import { createFestivalBridgeController } from "../src/content/festival-bridge";
import { installClockStubs } from "./clock-stubs";

interface PageBridgeDetail {
  epId?: string | number;
  bvid?: string;
  cid?: string | number;
  title?: string;
}

interface DeferredPageBridgeDetail {
  deferred: PageBridgeDetail;
}

function installBridgeDomStub(
  details: Array<PageBridgeDetail | DeferredPageBridgeDetail | null>,
): {
  flushDeferred: () => void;
  getPostMessageCount: () => number;
  restore: () => void;
} {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const listeners = new Set<EventListener>();
  const pendingTimeouts = new Map<number, boolean>();
  let timeoutSeq = 0;
  let deferredResponse: (() => void) | null = null;
  let postMessageCount = 0;

  const windowStub = {
    setTimeout(callback: () => void) {
      const id = (timeoutSeq += 1);
      pendingTimeouts.set(id, true);
      queueMicrotask(() => {
        if (pendingTimeouts.get(id)) {
          callback();
        }
      });
      return id;
    },
    clearTimeout(id: number) {
      pendingTimeouts.set(id, false);
    },
    addEventListener(_type: string, nextListener: EventListener) {
      listeners.add(nextListener);
    },
    removeEventListener(_type: string, nextListener: EventListener) {
      listeners.delete(nextListener);
    },
    postMessage(message: { requestId?: string }) {
      postMessageCount += 1;
      const response = details.shift();
      if (!response || listeners.size === 0) {
        return;
      }
      const detail = "deferred" in response ? response.deferred : response;
      const dispatch = () => {
        for (const listener of [...listeners]) {
          listener({
            source: windowStub,
            data: {
              type: "bili-syncplay:festival-video",
              requestId: message.requestId,
              detail,
            },
          } as MessageEvent);
        }
      };
      if ("deferred" in response) {
        deferredResponse = dispatch;
        return;
      }
      dispatch();
    },
  };

  Object.assign(globalThis, {
    window: windowStub,
    document: {
      querySelector() {
        return null;
      },
      createElement() {
        return { dataset: {} };
      },
      head: {
        appendChild() {
          return undefined;
        },
      },
      documentElement: {
        appendChild() {
          return undefined;
        },
      },
    },
    chrome: {
      runtime: {
        getURL(path: string) {
          return path;
        },
      },
    },
  });

  return {
    getPostMessageCount: () => postMessageCount,
    flushDeferred() {
      if (!deferredResponse) {
        throw new Error("No deferred page-bridge response is pending");
      }
      const dispatch = deferredResponse;
      deferredResponse = null;
      dispatch();
    },
    restore() {
      Object.assign(globalThis, {
        window: originalWindow,
        document: originalDocument,
        chrome: originalChrome,
      });
    },
  };
}

test("festival bridge does not reuse cached bangumi snapshot on festival page", async () => {
  const dom = installBridgeDomStub([
    {
      epId: 508404,
      cid: 987654,
      title: "第46话",
    },
    null,
  ]);
  const controller = createFestivalBridgeController();

  try {
    const bangumiSnapshot = await controller.refreshSnapshot({
      pathname: "/bangumi/play/ss357",
      pageUrl: "https://www.bilibili.com/bangumi/play/ss357",
      maxAgeMs: 0,
    });
    assert.equal(bangumiSnapshot?.videoId, "ep508404");

    const festivalSnapshot = await controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl: "https://www.bilibili.com/festival/demo",
      maxAgeMs: 60_000,
    });

    assert.equal(festivalSnapshot, null);
  } finally {
    dom.restore();
  }
});

test("festival bridge reuses cached festival snapshot for the same festival page", async () => {
  const dom = installBridgeDomStub([
    {
      bvid: "BVfestival",
      cid: 123,
      title: "Festival Episode",
    },
  ]);
  const controller = createFestivalBridgeController();

  try {
    const firstSnapshot = await controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl: "https://www.bilibili.com/festival/demo",
      maxAgeMs: 0,
    });
    const cachedSnapshot = await controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl: "https://www.bilibili.com/festival/demo",
      maxAgeMs: 60_000,
    });

    assert.deepEqual(cachedSnapshot, {
      videoId: firstSnapshot?.videoId,
      url: firstSnapshot?.url,
      title: firstSnapshot?.title,
    });
  } finally {
    dom.restore();
  }
});

test("festival bridge reuses cached festival snapshot across trailing slash path variants", async () => {
  const dom = installBridgeDomStub([
    {
      bvid: "BVfestival",
      cid: 123,
      title: "Festival Episode",
    },
  ]);
  const controller = createFestivalBridgeController();

  try {
    const firstSnapshot = await controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl: "https://www.bilibili.com/festival/demo",
      maxAgeMs: 0,
    });
    const cachedSnapshot = await controller.refreshSnapshot({
      pathname: "/festival/demo/",
      pageUrl: "https://www.bilibili.com/festival/demo/",
      maxAgeMs: 60_000,
    });

    assert.deepEqual(cachedSnapshot, {
      videoId: firstSnapshot?.videoId,
      url: firstSnapshot?.url,
      title: firstSnapshot?.title,
    });
  } finally {
    dom.restore();
  }
});

test("festival bridge resolves the cached video url for the matching festival page", async () => {
  const dom = installBridgeDomStub([
    {
      bvid: "BVfestival",
      cid: 123,
      title: "Festival Episode",
    },
  ]);
  const controller = createFestivalBridgeController();

  try {
    // No snapshot yet.
    assert.equal(
      controller.resolveVideoUrlForPage(
        "/festival/demo",
        "https://www.bilibili.com/festival/demo",
      ),
      null,
    );

    await controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl: "https://www.bilibili.com/festival/demo",
      maxAgeMs: 0,
    });

    // Same page (incl. trailing-slash variant) resolves to the snapshot url.
    assert.equal(
      controller.resolveVideoUrlForPage(
        "/festival/demo",
        "https://www.bilibili.com/festival/demo",
      ),
      "https://www.bilibili.com/festival/demo?bvid=BVfestival&cid=123",
    );
    assert.equal(
      controller.resolveVideoUrlForPage(
        "/festival/demo/",
        "https://www.bilibili.com/festival/demo/",
      ),
      "https://www.bilibili.com/festival/demo?bvid=BVfestival&cid=123",
    );
    // A different festival page or a non-festival page does not match.
    assert.equal(
      controller.resolveVideoUrlForPage(
        "/festival/other",
        "https://www.bilibili.com/festival/other",
      ),
      null,
    );
    assert.equal(
      controller.resolveVideoUrlForPage(
        "/video/BVx",
        "https://www.bilibili.com/video/BVx",
      ),
      null,
    );

    controller.clearSnapshot();
    assert.equal(
      controller.resolveVideoUrlForPage(
        "/festival/demo",
        "https://www.bilibili.com/festival/demo",
      ),
      null,
    );
  } finally {
    dom.restore();
  }
});

test("festival bridge treats a stale cached snapshot as unresolved when a max age is given", async () => {
  const dom = installBridgeDomStub([
    {
      bvid: "BVfestival",
      cid: 123,
      title: "Festival Episode",
    },
  ]);
  const controller = createFestivalBridgeController();

  try {
    await controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl: "https://www.bilibili.com/festival/demo",
      maxAgeMs: 0,
    });

    const url =
      "https://www.bilibili.com/festival/demo?bvid=BVfestival&cid=123";
    // Within the freshness bound (and with no bound) the snapshot resolves.
    assert.equal(
      controller.resolveVideoUrlForPage(
        "/festival/demo",
        "https://www.bilibili.com/festival/demo",
        60_000,
      ),
      url,
    );
    assert.equal(
      controller.resolveVideoUrlForPage(
        "/festival/demo",
        "https://www.bilibili.com/festival/demo",
      ),
      url,
    );
    // Older than the bound: treated as stale so a possibly-left video is not
    // reported as the trustworthy current one.
    assert.equal(
      controller.resolveVideoUrlForPage(
        "/festival/demo",
        "https://www.bilibili.com/festival/demo",
        0,
      ),
      null,
    );
  } finally {
    dom.restore();
  }
});

test("festival bridge does not fall back to a stale cached snapshot on read failure", async () => {
  const dom = installBridgeDomStub([
    {
      bvid: "BVfestival",
      cid: 123,
      title: "Festival Episode",
    },
    null,
  ]);
  const controller = createFestivalBridgeController();

  try {
    const firstSnapshot = await controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl: "https://www.bilibili.com/festival/demo",
      maxAgeMs: 0,
    });
    assert.equal(firstSnapshot?.videoId, "BVfestival:123");

    // Fast-path skipped (cache is older than maxAgeMs) and the fresh read fails;
    // the cache must not be resurrected for the authoritative target validation.
    const staleRead = await controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl: "https://www.bilibili.com/festival/demo",
      maxAgeMs: 0,
    });

    assert.equal(staleRead, null);
  } finally {
    dom.restore();
  }
});

test("festival bridge does not fall back to another festival page snapshot", async () => {
  const dom = installBridgeDomStub([
    {
      bvid: "BVfestival",
      cid: 123,
      title: "Festival Episode",
    },
    null,
  ]);
  const controller = createFestivalBridgeController();

  try {
    const firstSnapshot = await controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl: "https://www.bilibili.com/festival/demo",
      maxAgeMs: 0,
    });
    assert.equal(firstSnapshot?.videoId, "BVfestival:123");

    const nextSnapshot = await controller.refreshSnapshot({
      pathname: "/festival/other",
      pageUrl: "https://www.bilibili.com/festival/other",
      maxAgeMs: 0,
    });

    assert.equal(nextSnapshot, null);
  } finally {
    dom.restore();
  }
});

test("ages the cached snapshot on the monotonic clock", async () => {
  const dom = installBridgeDomStub([
    {
      bvid: "BVfestival",
      cid: 123,
      title: "Festival Episode",
    },
  ]);
  // This controller takes no clock, so the globals are the only way to drive it.
  const clock = installClockStubs({
    wall: 1_700_000_000_000,
    monotonic: 5_000,
  });
  const controller = createFestivalBridgeController();

  try {
    await controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl: "https://www.bilibili.com/festival/demo",
      maxAgeMs: 0,
    });

    // An NTP correction jumps the wall clock an hour forward while barely any
    // time has actually passed. The snapshot is 100ms old, not an hour old, and
    // discarding it would send the auto-share self-check back to the page bridge
    // for a video that has not changed.
    clock.clocks.wall += 3_600_000;
    clock.clocks.monotonic += 100;

    assert.equal(
      controller.resolveVideoUrlForPage(
        "/festival/demo",
        "https://www.bilibili.com/festival/demo",
        60_000,
      ),
      "https://www.bilibili.com/festival/demo?bvid=BVfestival&cid=123",
    );
  } finally {
    clock.restore();
    dom.restore();
  }
});

test("festival bridge does not let a pre-clear refresh repopulate the snapshot", async () => {
  const pageUrl = "https://www.bilibili.com/festival/demo";
  const dom = installBridgeDomStub([
    {
      deferred: {
        bvid: "BVstale",
        cid: 123,
        title: "Stale Visit",
      },
    },
  ]);
  const controller = createFestivalBridgeController();

  try {
    const pendingRefresh = controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl,
      maxAgeMs: 0,
    });
    controller.clearSnapshot();
    dom.flushDeferred();

    assert.equal(await pendingRefresh, null);
    assert.equal(controller.getSnapshot(), null);
    assert.equal(
      controller.resolveVideoUrlForPage("/festival/demo", pageUrl),
      null,
    );
  } finally {
    dom.restore();
  }
});

test("festival bridge does not let a cache hit cancel an in-flight fresh read", async () => {
  const pageUrl = "https://www.bilibili.com/festival/demo";
  const dom = installBridgeDomStub([
    {
      bvid: "BVcached",
      cid: 111,
      title: "Cached Visit",
    },
    {
      deferred: {
        bvid: "BVfresh",
        cid: 222,
        title: "Fresh Visit",
      },
    },
  ]);
  const controller = createFestivalBridgeController();

  try {
    await controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl,
      maxAgeMs: 0,
    });
    const pendingFreshRead = controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl,
      maxAgeMs: 0,
    });

    const cachedRead = controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl,
      maxAgeMs: 60_000,
    });
    dom.flushDeferred();
    const [cachedSnapshot, freshSnapshot] = await Promise.all([
      cachedRead,
      pendingFreshRead,
    ]);
    assert.equal(cachedSnapshot?.videoId, "BVcached:111");
    assert.equal(freshSnapshot?.videoId, "BVfresh:222");
    assert.equal(controller.getSnapshot()?.videoId, "BVfresh:222");
  } finally {
    dom.restore();
  }
});

test("festival bridge shares one fresh read between concurrent consumers on the same page visit", async () => {
  const pageUrl = "https://www.bilibili.com/bangumi/play/ss357";
  const dom = installBridgeDomStub([
    {
      deferred: {
        epId: 508404,
        cid: 987654,
        title: "第46话",
      },
    },
  ]);
  const controller = createFestivalBridgeController();

  try {
    const naturalEndRead = controller.refreshSnapshot({
      pathname: "/bangumi/play/ss357",
      pageUrl,
      maxAgeMs: 0,
    });
    const followupBroadcastRead = controller.refreshSnapshot({
      pathname: "/bangumi/play/ss357",
      pageUrl,
      maxAgeMs: 0,
    });

    assert.equal(dom.getPostMessageCount(), 1);
    dom.flushDeferred();
    const [naturalEndSnapshot, followupSnapshot] = await Promise.all([
      naturalEndRead,
      followupBroadcastRead,
    ]);
    assert.deepEqual(followupSnapshot, naturalEndSnapshot);
    assert.equal(naturalEndSnapshot?.videoId, "ep508404");
  } finally {
    dom.restore();
  }
});

test("festival bridge keeps different page visits on distinct fresh reads", async () => {
  const dom = installBridgeDomStub([
    {
      deferred: {
        epId: 508404,
        cid: 987654,
        title: "旧页面",
      },
    },
    {
      epId: 508405,
      cid: 987655,
      title: "新页面",
    },
  ]);
  const controller = createFestivalBridgeController();

  try {
    const oldVisitRead = controller.refreshSnapshot({
      pathname: "/bangumi/play/ss357",
      pageUrl: "https://www.bilibili.com/bangumi/play/ss357",
      maxAgeMs: 0,
    });
    const newVisitRead = controller.refreshSnapshot({
      pathname: "/bangumi/play/ss358",
      pageUrl: "https://www.bilibili.com/bangumi/play/ss358",
      maxAgeMs: 0,
    });

    assert.equal(dom.getPostMessageCount(), 2);
    const [oldVisitSnapshot, newVisitSnapshot] = await Promise.all([
      oldVisitRead,
      newVisitRead,
    ]);
    assert.equal(oldVisitSnapshot, null);
    assert.equal(newVisitSnapshot?.videoId, "ep508405");
    assert.equal(controller.getSnapshot()?.videoId, "ep508405");
  } finally {
    dom.restore();
  }
});

test("festival bridge delivers an event-owned old-visit result without replacing the newer cache", async () => {
  const dom = installBridgeDomStub([
    {
      deferred: {
        epId: 508404,
        cid: 987654,
        title: "自然结束的旧页面",
      },
    },
    {
      epId: 508405,
      cid: 987655,
      title: "已经开始读取的新页面",
    },
  ]);
  const controller = createFestivalBridgeController();

  try {
    const naturalEndRead = controller.refreshSnapshot({
      pathname: "/bangumi/play/ss357",
      pageUrl: "https://www.bilibili.com/bangumi/play/ss357",
      maxAgeMs: 0,
      allowSupersededResult: true,
    });
    const destinationRead = controller.refreshSnapshot({
      pathname: "/bangumi/play/ep508405",
      pageUrl: "https://www.bilibili.com/bangumi/play/ep508405",
      maxAgeMs: 0,
    });

    assert.equal(dom.getPostMessageCount(), 2);
    dom.flushDeferred();
    const [naturalEndSnapshot, destinationSnapshot] = await Promise.all([
      naturalEndRead,
      destinationRead,
    ]);

    assert.equal(naturalEndSnapshot?.videoId, "ep508404");
    assert.equal(destinationSnapshot?.videoId, "ep508405");
    assert.equal(controller.getSnapshot()?.videoId, "ep508405");
  } finally {
    dom.restore();
  }
});
