import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AdminOverview, ReadyStatus } from "../src/api/types.js";
import { AuthContext } from "../src/auth/auth-context.js";
import type { AuthContextValue } from "../src/auth/auth-context.js";
import {
  createAuthValue as createTestAuthValue,
  createStubApi,
} from "./helpers.js";
import { OverviewPage } from "../src/pages/overview/overview-page.js";

function createOverviewFixture(
  overrides: Partial<AdminOverview["events"]["lastHour"]> = {},
): AdminOverview {
  const counts = {
    room_created: 3,
    room_joined: 7,
    rate_limited: 0,
    ws_connection_rejected: 0,
  };
  return {
    service: {
      instanceId: "node-a",
      name: "bili-syncplay-server",
      version: "1.2.4",
      startedAt: Date.now() - 3_600_000,
      uptimeMs: 3_600_000,
    },
    storage: { provider: "redis", redisConnected: true },
    runtime: {
      connectionCount: 42,
      activeRoomCount: 5,
      activeMemberCount: 12,
    },
    rooms: { totalNonExpired: 9, active: 5, idle: 4, orphanRuntimeCount: 0 },
    nodes: {
      total: 1,
      online: 1,
      stale: 0,
      offline: 0,
      items: [
        {
          instanceId: "node-a",
          version: "1.2.4",
          startedAt: Date.now() - 3_600_000,
          lastHeartbeatAt: Date.now(),
          staleAt: Date.now() + 30_000,
          expiresAt: Date.now() + 60_000,
          connectionCount: 42,
          activeRoomCount: 5,
          activeMemberCount: 12,
          health: "ok",
          currentRoomCount: 5,
          currentMemberCount: 12,
          roomCodes: ["ROOM1"],
        },
      ],
    },
    events: {
      lastMinute: { ...counts },
      lastHour: { ...counts, ...overrides },
      lastDay: { ...counts },
      totals: { ...counts },
    },
  };
}

const readyFixture: ReadyStatus = {
  status: "ready",
  checks: { httpServer: "ok", roomStore: "ok", redis: "ok" },
};

function createAuthValue(api: Partial<AuthContextValue["api"]>) {
  return createTestAuthValue({
    token: "token-1",
    me: { id: "admin-1", username: "ops", role: "admin" },
    api: createStubApi(api),
  });
}

function renderOverview(authValue: AuthContextValue) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <AuthContext.Provider value={authValue}>
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe("OverviewPage", () => {
  it("renders metrics, storage, events and nodes from the API", async () => {
    renderOverview(
      createAuthValue({
        getOverview: vi.fn().mockResolvedValue(createOverviewFixture()),
        getReady: vi.fn().mockResolvedValue(readyFixture),
      }),
    );

    // 连接数 42 同时出现在指标卡和节点表里。
    expect((await screen.findAllByText("42")).length).toBeGreaterThan(0);
    expect(screen.getByText("连接数")).toBeTruthy();
    expect(screen.getByText("总计 9 非过期")).toBeTruthy();
    expect(screen.getByText("已连接")).toBeTruthy();
    expect(screen.getByText("node-a")).toBeTruthy();
    expect(screen.getByText("最近一小时")).toBeTruthy();
    expect(screen.queryByText(/readyz 状态为|readyz 检查失败/)).toBeNull();
  });

  it("shows a degradation banner when readyz is not ready", async () => {
    renderOverview(
      createAuthValue({
        getOverview: vi.fn().mockResolvedValue(createOverviewFixture()),
        getReady: vi.fn().mockResolvedValue({
          status: "not_ready",
          checks: { httpServer: "ok", roomStore: "error", redis: "error" },
        } satisfies ReadyStatus),
      }),
    );

    expect(await screen.findByText(/readyz 状态为 not_ready/)).toBeTruthy();
  });

  it("shows a retryable error state when the overview request fails", async () => {
    const getOverview = vi
      .fn()
      .mockRejectedValueOnce(new Error("网络错误"))
      .mockResolvedValue(createOverviewFixture());
    const user = userEvent.setup();
    renderOverview(
      createAuthValue({
        getOverview,
        getReady: vi.fn().mockResolvedValue(readyFixture),
      }),
    );

    expect(await screen.findByText("概览数据加载失败")).toBeTruthy();
    expect(screen.getByText("网络错误")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /重\s*试/ }));
    expect(await screen.findByText("连接数")).toBeTruthy();
  });

  it("refetches when clicking manual refresh", async () => {
    const getOverview = vi.fn().mockResolvedValue(createOverviewFixture());
    const user = userEvent.setup();
    renderOverview(
      createAuthValue({
        getOverview,
        getReady: vi.fn().mockResolvedValue(readyFixture),
      }),
    );

    expect(await screen.findByText("连接数")).toBeTruthy();
    const callsBefore = getOverview.mock.calls.length;
    await user.click(screen.getByRole("button", { name: /刷\s*新/ }));

    await waitFor(() => {
      expect(getOverview.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});
