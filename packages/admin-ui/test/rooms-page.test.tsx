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
import { RoomsFilter } from "../src/pages/rooms/rooms-filter.js";
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
    const user = userEvent.setup({ delay: null });
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
    const user = userEvent.setup({ delay: null });
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

  it("shows an error state with retry when the rooms request fails", async () => {
    const listRooms = vi
      .fn()
      .mockRejectedValueOnce(new Error("后端故障"))
      .mockResolvedValue(makeListResult([makeRoom()]));
    const user = userEvent.setup({ delay: null });
    renderRooms(createOperatorAuth({ listRooms }));

    expect(await screen.findByText("房间列表加载失败")).toBeTruthy();
    expect(screen.getByText("后端故障")).toBeTruthy();
    expect(screen.queryByText("没有符合条件的房间。")).toBeNull();

    await user.click(screen.getByRole("button", { name: /重\s*试/ }));
    expect(await screen.findByText("ROOM1")).toBeTruthy();
  });

  it("keeps URL sort when paginating", async () => {
    const listRooms = vi.fn().mockResolvedValue({
      items: [makeRoom()],
      pagination: { page: 1, pageSize: 20, total: 45 },
    });
    const user = userEvent.setup({ delay: null });
    renderRooms(
      createOperatorAuth({ listRooms }),
      "/rooms?sortBy=createdAt&sortOrder=asc",
    );

    expect(await screen.findByText("ROOM1")).toBeTruthy();
    await user.click(screen.getByTitle("2"));

    await waitFor(() => {
      expect(listRooms).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 2,
          sortBy: "createdAt",
          sortOrder: "asc",
        }),
      );
    });
  });

  it("drops the previous room's detail while switching rooms", async () => {
    const room1 = makeRoom();
    const room2 = makeRoom({ roomCode: "ROOM2" });
    const getRoomDetail = vi.fn((code: string) =>
      code === "ROOM1"
        ? Promise.resolve(makeDetail(room1))
        : new Promise<never>(() => {}),
    );
    const user = userEvent.setup({ delay: null });
    renderRooms(
      createOperatorAuth({
        listRooms: vi.fn().mockResolvedValue(makeListResult([room1, room2])),
        getRoomDetail: getRoomDetail as never,
      }),
      "/rooms/ROOM1",
    );

    expect(await screen.findByText("小明")).toBeTruthy();

    const room2Row = (await screen.findByText("ROOM2")).closest("tr");
    await user.click(
      within(room2Row as HTMLElement).getByRole("button", { name: /详\s*情/ }),
    );

    // ROOM2 的详情未返回前，不能继续展示 ROOM1 的成员，
    // 否则抽屉里的治理按钮会作用在错误房间上。
    await waitFor(() => {
      expect(screen.queryByText("小明")).toBeNull();
    });
  });

  it("opens the detail drawer from the route and kicks a member", async () => {
    const room = makeRoom();
    const kickMember = vi.fn().mockResolvedValue({});
    const user = userEvent.setup({ delay: null });
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

describe("RoomsPage batch governance", () => {
  function makeTwoRooms() {
    return [
      makeRoom({ isActive: false, memberCount: 0 }),
      makeRoom({ roomCode: "ROOM2", isActive: false, memberCount: 0 }),
    ];
  }

  it("closes all selected rooms and clears the selection on success", async () => {
    const closeRoom = vi.fn().mockResolvedValue({});
    const user = userEvent.setup({ delay: null });
    renderRooms(
      createOperatorAuth({
        listRooms: vi.fn().mockResolvedValue(makeListResult(makeTwoRooms())),
        closeRoom,
      }),
    );

    await screen.findByText("ROOM2");
    // 第一个 checkbox 是表头全选。
    // 页面里筛选区也有 checkbox（含已过期），全选框要在表格作用域内取。
    await user.click(
      within(screen.getByRole("table")).getAllByRole("checkbox")[0],
    );
    expect(await screen.findByText("已选 2 个房间")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /批量关闭/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByPlaceholderText(/操作原因/),
      "夜间清理",
    );
    await user.click(within(dialog).getByRole("button", { name: /确认执行/ }));

    await waitFor(() => {
      expect(closeRoom).toHaveBeenCalledWith("ROOM1", "夜间清理");
      expect(closeRoom).toHaveBeenCalledWith("ROOM2", "夜间清理");
    });
    expect(await screen.findByText("成功 2 个，失败 0 个。")).toBeTruthy();
    expect(screen.queryByText(/已选 \d+ 个房间/)).toBeNull();
  });

  it("keeps failed rooms selected and lists failures", async () => {
    const expireRoom = vi.fn((roomCode: string) =>
      roomCode === "ROOM2"
        ? Promise.reject(new Error("房间仍有在线成员"))
        : Promise.resolve({}),
    );
    const user = userEvent.setup({ delay: null });
    renderRooms(
      createOperatorAuth({
        listRooms: vi.fn().mockResolvedValue(makeListResult(makeTwoRooms())),
        expireRoom: expireRoom as never,
      }),
    );

    await screen.findByText("ROOM2");
    await user.click(
      within(screen.getByRole("table")).getAllByRole("checkbox")[0],
    );
    await user.click(screen.getByRole("button", { name: /批量过期/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /确认执行/ }));

    expect(
      await screen.findByText(/成功 1 个，失败 1 个。失败的房间保持勾选/),
    ).toBeTruthy();
    expect(screen.getByText("房间仍有在线成员")).toBeTruthy();
    // 失败的 ROOM2 保持勾选，可重试。
    expect(await screen.findByText("已选 1 个房间")).toBeTruthy();
  });

  it("hides row selection for viewers", async () => {
    renderRooms(
      createAuthValue({
        token: "token-1",
        me: { id: "admin-2", username: "watcher", role: "viewer" },
        api: createStubApi({
          listRooms: vi.fn().mockResolvedValue(makeListResult(makeTwoRooms())),
        }),
      }),
    );

    expect(await screen.findByText("ROOM2")).toBeTruthy();
    // viewer 仍能看到筛选区的 checkbox，但表格内不应有选择框。
    expect(
      within(screen.getByRole("table")).queryAllByRole("checkbox"),
    ).toHaveLength(0);
  });
});

describe("RoomsFilter", () => {
  it("syncs the keyword input when the routed query changes", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <RoomsFilter query={{ keyword: "abc" }} onChange={onChange} />,
    );
    const input = screen.getByPlaceholderText(/房间号/) as HTMLInputElement;
    expect(input.value).toBe("abc");

    rerender(<RoomsFilter query={{ keyword: "xyz" }} onChange={onChange} />);
    expect(input.value).toBe("xyz");
  });
});
