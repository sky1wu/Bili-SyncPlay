import assert from "node:assert/strict";
import test from "node:test";
import {
  bindRoomActionButtons,
  createPageLoaders,
  createRoomActionConfig,
} from "../admin-ui/page-renderers.js";

function createButton(attributes: Record<string, string> = {}) {
  const listeners = new Map<string, (event?: unknown) => unknown>();
  return {
    addEventListener(type: string, handler: (event?: unknown) => unknown) {
      listeners.set(type, handler);
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
    async click() {
      return listeners.get("click")?.({
        preventDefault() {},
        currentTarget: this,
        target: this,
      });
    },
  };
}

function createDocumentStub({
  single = {},
  many = {},
}: {
  single?: Record<string, unknown>;
  many?: Record<string, unknown[]>;
} = {}) {
  return {
    querySelector(selector: string) {
      return single[selector] ?? null;
    },
    querySelectorAll(selector: string) {
      return many[selector] ?? [];
    },
  };
}

test("overview page toggles auto refresh and supports manual refresh binding", async () => {
  const refreshButton = createButton();
  const toggleButton = createButton();
  let rerenderCount = 0;
  const state = { overviewAutoRefresh: true, lastOverviewData: null };

  const pageLoaders = createPageLoaders({
    document: createDocumentStub({
      single: {
        "[data-refresh-overview]": refreshButton,
        "[data-toggle-overview-refresh]": toggleButton,
      },
    }),
    location: { search: "" },
    history: { replaceState() {} },
    state,
    api: {
      async getReady() {
        return { status: "ready", checks: { roomStore: "ok" } };
      },
      async getOverview() {
        return {
          service: {
            instanceId: "instance-1",
            name: "bili-syncplay-server",
            version: "1.0.0-test",
            uptimeMs: 12_345,
          },
          storage: { provider: "memory", redisConnected: false },
          runtime: {
            connectionCount: 3,
            activeRoomCount: 2,
            activeMemberCount: 5,
          },
          rooms: { totalNonExpired: 4, idle: 1 },
          events: {
            lastMinute: {
              room_created: 1,
              room_joined: 2,
              rate_limited: 0,
              ws_connection_rejected: 0,
            },
            totals: {
              room_created: 10,
              room_joined: 20,
              rate_limited: 1,
              ws_connection_rejected: 2,
            },
          },
        };
      },
    },
    routeHref(path: string) {
      return `/admin${path}`;
    },
    withDemoQuery(url: string) {
      return url;
    },
    serializeQuery() {
      return "";
    },
    navigate() {},
    navigateToUrl() {},
    rerender() {
      rerenderCount += 1;
    },
    canManage() {
      return true;
    },
    confirmAction() {},
    openReasonDialog() {},
  });

  const page = await pageLoaders.renderOverviewPage();
  assert.equal(page.html.includes("连接数"), true);
  assert.equal(page.html.includes("data-refresh-overview"), true);

  page.bind?.();
  await refreshButton.click();
  await toggleButton.click();

  assert.equal(rerenderCount, 2);
  assert.equal(state.overviewAutoRefresh, false);
});

test("rooms and events pages render direct admin ui tables", async () => {
  const pageLoaders = createPageLoaders({
    document: createDocumentStub(),
    location: { search: "" },
    history: { replaceState() {} },
    state: {
      overviewAutoRefresh: true,
      lastOverviewData: { instanceId: "instance-1" },
    },
    api: {
      async listRooms() {
        return {
          items: [
            {
              roomCode: "ROOM8A",
              isActive: true,
              ownerDisplayName: "Alice",
              ownerMemberId: "member-alice",
              memberCount: 3,
              sharedVideo: { title: "测试视频" },
              playback: { paused: false, currentTime: 12.3 },
              lastActiveAt: Date.now(),
              expiresAt: Date.now() + 60_000,
            },
          ],
          pagination: { total: 1 },
        };
      },
      async listEvents() {
        return {
          items: [
            {
              timestamp: Date.now(),
              event: "room_joined",
              roomCode: "ROOM8A",
              sessionId: "sess-1",
              origin: "https://www.bilibili.com",
              result: "ok",
              details: { memberId: "member-alice" },
            },
          ],
          total: 1,
        };
      },
    },
    routeHref(path: string) {
      return `/admin${path}`;
    },
    withDemoQuery(url: string) {
      return url;
    },
    serializeQuery() {
      return "";
    },
    navigate() {},
    navigateToUrl() {},
    rerender() {},
    canManage() {
      return true;
    },
    confirmAction() {},
    openReasonDialog() {},
  });

  const roomsPage = await pageLoaders.renderRoomsPage();
  const eventsPage = await pageLoaders.renderEventsPage();

  assert.equal(roomsPage.html.includes("ROOM8A"), true);
  assert.equal(roomsPage.html.includes("关闭房间"), true);
  assert.equal(eventsPage.html.includes("room_joined"), true);
  assert.equal(eventsPage.html.includes("data-view-json"), true);
});

test("danger room actions require confirmed config before execution", async () => {
  const roomActionButton = createButton({
    "data-room-action": "close",
    "data-room-code": "ROOM8A",
  });
  const apiCalls: Array<{ roomCode: string; reason: string }> = [];
  const confirmConfigs: Array<Record<string, unknown>> = [];

  bindRoomActionButtons({
    document: createDocumentStub({
      many: { "[data-room-action]": [roomActionButton] },
    }),
    api: {
      async closeRoom(roomCode: string, reason: string) {
        apiCalls.push({ roomCode, reason });
      },
    },
    confirmAction: async (config: Record<string, unknown>) => {
      confirmConfigs.push(config);
      await (config.onConfirm as (reason: string) => Promise<void>)("排查异常");
    },
    navigate() {},
    rerender() {},
    currentRoute() {
      return "/rooms";
    },
  });

  await roomActionButton.click();

  assert.equal(confirmConfigs.length, 1);
  assert.equal(confirmConfigs[0].title, "关闭房间 ROOM8A");
  assert.equal(confirmConfigs[0].confirmLabel, "确认关闭");
  assert.deepEqual(apiCalls, [{ roomCode: "ROOM8A", reason: "排查异常" }]);

  const config = createRoomActionConfig("close", {
    roomCode: "ROOM8A",
    api: {
      async closeRoom() {},
    },
    navigate() {},
    rerender() {},
    currentRoute() {
      return "/rooms/ROOM8A";
    },
  });
  assert.equal(config.successMessage, "房间 ROOM8A 已关闭。");
});
