import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntdApp } from "antd";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type {
  RoomDetail,
  RoomListResult,
  RoomSummary,
} from "../src/api/types.js";
import { AuthContext } from "../src/auth/auth-context.js";
import type { AuthContextValue } from "../src/auth/auth-context.js";
import { RoomsPage } from "../src/pages/rooms/rooms-page.js";
import { createAuthValue, createStubApi } from "./helpers.js";

function makeRoom(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    roomCode: "ROOM1",
    createdAt: Date.now() - 3_600_000,
    ownerMemberId: "member-1",
    ownerDisplayName: "阿伟",
    lastActiveAt: Date.now() - 60_000,
    expiresAt: null,
    sharedVideo: {
      videoId: "BV1xx411c7mD",
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
      title: "测试视频",
    },
    playback: null,
    memberCount: 2,
    isActive: true,
    instanceIds: ["node-a"],
    ...overrides,
  };
}

function makeListResult(items: RoomSummary[]): RoomListResult {
  return {
    items,
    pagination: { page: 1, pageSize: 20, total: items.length },
  };
}

function makeDetail(room: RoomSummary): RoomDetail {
  return {
    room,
    members: [
      {
        sessionId: "session-1",
        memberId: "member-1",
        displayName: "阿伟",
        joinedAt: Date.now() - 3_000_000,
        remoteAddress: "1.2.3.4",
        origin: "chrome-extension://abc",
      },
      {
        sessionId: "session-2",
        memberId: "member-2",
        displayName: "小明",
        joinedAt: Date.now() - 1_000_000,
        remoteAddress: "5.6.7.8",
        origin: "chrome-extension://def",
      },
    ],
    recentEvents: [
      {
        id: "event-1",
        timestamp: new Date().toISOString(),
        event: "room_joined",
        roomCode: room.roomCode,
        sessionId: "session-2",
        remoteAddress: "5.6.7.8",
        origin: null,
        result: "ok",
        details: {},
      },
    ],
  };
}

function renderRooms(authValue: AuthContextValue, initialEntry = "/rooms") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <AuthContext.Provider value={authValue}>
      <QueryClientProvider client={queryClient}>
        <AntdApp>
          <MemoryRouter initialEntries={[initialEntry]}>
            <Routes>
              <Route path="/rooms" element={<RoomsPage />} />
              <Route path="/rooms/:roomCode" element={<RoomsPage />} />
            </Routes>
          </MemoryRouter>
        </AntdApp>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

function createOperatorAuth(api: Partial<AuthContextValue["api"]>) {
  return createAuthValue({
    token: "token-1",
    me: { id: "admin-1", username: "ops", role: "operator" },
    api: createStubApi(api),
  });
}

describe("RoomsPage", () => {
  it("renders rooms with status, video and owner", async () => {
    renderRooms(
      createOperatorAuth({
        listRooms: vi.fn().mockResolvedValue(
          makeListResult([
            makeRoom(),
            makeRoom({
              roomCode: "ROOM2",
              isActive: false,
              memberCount: 0,
              sharedVideo: null,
            }),
          ]),
        ),
      }),
    );

    expect(await screen.findByText("ROOM1")).toBeTruthy();
    expect(screen.getByText("活跃 · 2 人")).toBeTruthy();
    // “空闲”同时出现在状态筛选器里。
    expect(screen.getAllByText("空闲").length).toBeGreaterThan(1);
    expect(screen.getByText("测试视频")).toBeTruthy();
    expect(screen.getByText("未共享视频")).toBeTruthy();
    expect(screen.getAllByText("阿伟").length).toBeGreaterThan(0);
  });

  it("passes URL search params through to the rooms query", async () => {
    const listRooms = vi.fn().mockResolvedValue(makeListResult([]));
    renderRooms(
      createOperatorAuth({ listRooms }),
      "/rooms?status=active&keyword=abc&includeExpired=true",
    );

    await waitFor(() => {
      expect(listRooms).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "active",
          keyword: "abc",
          includeExpired: true,
        }),
      );
    });
  });

  it("runs the close-room governance flow with a reason", async () => {
    const closeRoom = vi.fn().mockResolvedValue({});
    const user = userEvent.setup();
    renderRooms(
      createOperatorAuth({
        listRooms: vi.fn().mockResolvedValue(makeListResult([makeRoom()])),
        closeRoom,
      }),
    );

    await user.click(await screen.findByRole("button", { name: /治\s*理/ }));
    await user.click(await screen.findByText("关闭房间"));

    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByPlaceholderText(/操作原因/),
      "违规内容",
    );
    await user.click(within(dialog).getByRole("button", { name: /确认执行/ }));

    await waitFor(() => {
      expect(closeRoom).toHaveBeenCalledWith("ROOM1", "违规内容");
    });
  });

  it("disables early-expire for active rooms", async () => {
    const user = userEvent.setup();
    renderRooms(
      createOperatorAuth({
        listRooms: vi.fn().mockResolvedValue(makeListResult([makeRoom()])),
      }),
    );

    await user.click(await screen.findByRole("button", { name: /治\s*理/ }));
    const expireItem = await screen.findByText("提前过期");
    expect(
      expireItem.closest(
        '[aria-disabled="true"], .ant-dropdown-menu-item-disabled',
      ),
    ).not.toBeNull();
  });

  it("hides governance actions for viewers", async () => {
    renderRooms(
      createAuthValue({
        token: "token-1",
        me: { id: "admin-2", username: "watcher", role: "viewer" },
        api: createStubApi({
          listRooms: vi.fn().mockResolvedValue(makeListResult([makeRoom()])),
        }),
      }),
    );

    expect(await screen.findByText("ROOM1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /治\s*理/ })).toBeNull();
  });

  it("opens the detail drawer from the route and kicks a member", async () => {
    const room = makeRoom();
    const kickMember = vi.fn().mockResolvedValue({});
    const user = userEvent.setup();
    renderRooms(
      createOperatorAuth({
        listRooms: vi.fn().mockResolvedValue(makeListResult([room])),
        getRoomDetail: vi.fn().mockResolvedValue(makeDetail(room)),
        kickMember,
      }),
      "/rooms/ROOM1",
    );

    expect(await screen.findByText("小明")).toBeTruthy();
    // “房主”同时是详情描述项的标签。
    expect(screen.getAllByText("房主").length).toBeGreaterThan(1);
    expect(screen.getByText("room_joined")).toBeTruthy();

    const memberRow = screen.getByText("小明").closest("tr");
    expect(memberRow).not.toBeNull();
    await user.click(
      within(memberRow as HTMLElement).getByRole("button", {
        name: /踢\s*出/,
      }),
    );

    // 抽屉与弹窗都是 role=dialog，直接用确认按钮定位。
    await user.click(await screen.findByRole("button", { name: /确认执行/ }));

    await waitFor(() => {
      expect(kickMember).toHaveBeenCalledWith("ROOM1", "member-2", "");
    });
  });
});
