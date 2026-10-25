import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntdApp } from "antd";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import dayjs from "dayjs";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/http.js";
import type { AdminAnnouncement, AdminRole } from "../src/api/types.js";
import { AuthContext } from "../src/auth/auth-context.js";
import type { AuthContextValue } from "../src/auth/auth-context.js";
import { AnnouncementPage } from "../src/pages/announcement/announcement-page.js";
import { createAuthValue, createStubApi } from "./helpers.js";

function makeAnnouncement(
  overrides: Partial<AdminAnnouncement> = {},
): AdminAnnouncement {
  return {
    id: "announcement-1",
    level: "warning",
    message: "今晚 04:30 维护，预计中断 5 分钟",
    scheduledAt: null,
    publishedAt: Date.now() - 60_000,
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

function renderPage(
  api: Partial<AuthContextValue["api"]>,
  role: AdminRole = "operator",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const authValue = createAuthValue({
    token: "token-1",
    me: { id: "admin-1", username: "ops", role },
    api: createStubApi(api),
  });
  return render(
    <AntdApp>
      <AuthContext.Provider value={authValue}>
        <QueryClientProvider client={queryClient}>
          <AnnouncementPage />
        </QueryClientProvider>
      </AuthContext.Provider>
    </AntdApp>,
  );
}

async function pickExpiresAt(
  user: ReturnType<typeof userEvent.setup>,
  value: dayjs.Dayjs,
) {
  const input = screen.getByLabelText("到期时间");
  await user.click(input);
  await user.type(input, value.format("YYYY-MM-DD HH:mm:ss"));
  // 点面板的确定而不是回车：回车会顺带提交整个表单。弹层在入场动画期间
  // 不计入可访问树，按文案定位。
  await user.click(await screen.findByText(/^(OK|确\s*定)$/));
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("AnnouncementPage", () => {
  it("shows the current announcement read-only to a viewer", async () => {
    renderPage(
      {
        getAnnouncement: vi.fn().mockResolvedValue({
          announcement: makeAnnouncement({
            scheduledAt: Date.now() + 7_200_000,
          }),
        }),
      },
      "viewer",
    );

    expect(await screen.findByText(/今晚 04:30 维护/)).toBeTruthy();
    expect(screen.getByText("警告")).toBeTruthy();
    expect(screen.getByText("计划时间")).toBeTruthy();
    expect(screen.getByText(/剩余/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /撤\s*回/ })).toBeNull();
    expect(screen.queryByText("发布公告")).toBeNull();
  });

  it("says when there is no announcement", async () => {
    renderPage({
      getAnnouncement: vi.fn().mockResolvedValue({ announcement: null }),
    });

    expect(await screen.findByText("当前没有公告")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /撤\s*回/ })).toBeNull();
    expect(screen.getByRole("button", { name: /发布公告/ })).toBeTruthy();
  });

  it("publishes and shows the new announcement as current", async () => {
    const expiresAt = dayjs().add(2, "hour").startOf("second");
    const published = makeAnnouncement({
      id: "announcement-2",
      level: "info",
      message: "新版本已发布",
      expiresAt: expiresAt.valueOf(),
    });
    const publishAnnouncement = vi
      .fn()
      .mockResolvedValue({ announcement: published });
    const user = userEvent.setup({ delay: null });
    renderPage({
      getAnnouncement: vi.fn().mockResolvedValue({ announcement: null }),
      publishAnnouncement,
    });

    await screen.findByText("当前没有公告");
    await user.type(screen.getByLabelText("内容"), "  新版本已发布  ");
    await pickExpiresAt(user, expiresAt);
    await user.click(screen.getByRole("button", { name: /发布公告/ }));
    // 发布要先确认：表单里按回车也会提交，确认之前不能有请求。
    expect(await screen.findAllByText("发布公告？")).not.toHaveLength(0);
    expect(publishAnnouncement).not.toHaveBeenCalled();
    await user.click(screen.getByText("确认发布"));

    await waitFor(() => {
      expect(publishAnnouncement).toHaveBeenCalledWith({
        level: "info",
        message: "新版本已发布",
        scheduledAt: undefined,
        expiresAt: expiresAt.valueOf(),
      });
    });
    expect(publishAnnouncement).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("新版本已发布")).toBeTruthy();
    expect(screen.queryByText("当前没有公告")).toBeNull();
  });

  it("refuses to publish without content or expiry", async () => {
    const publishAnnouncement = vi.fn();
    const user = userEvent.setup({ delay: null });
    renderPage({
      getAnnouncement: vi.fn().mockResolvedValue({ announcement: null }),
      publishAnnouncement,
    });

    await screen.findByText("当前没有公告");
    await user.type(screen.getByLabelText("内容"), "   ");
    await user.click(screen.getByRole("button", { name: /发布公告/ }));

    expect(await screen.findByText("请填写公告内容")).toBeTruthy();
    expect(screen.getByText("请选择到期时间")).toBeTruthy();
    expect(publishAnnouncement).not.toHaveBeenCalled();
  });

  it("asks before replacing the current announcement", async () => {
    const expiresAt = dayjs().add(1, "day").startOf("second");
    const publishAnnouncement = vi.fn().mockResolvedValue({
      announcement: makeAnnouncement({ id: "announcement-2", message: "新的" }),
    });
    const user = userEvent.setup({ delay: null });
    renderPage({
      getAnnouncement: vi
        .fn()
        .mockResolvedValue({ announcement: makeAnnouncement() }),
      publishAnnouncement,
    });

    await screen.findByText(/今晚 04:30 维护/);
    await user.type(screen.getByLabelText("内容"), "新的");
    await pickExpiresAt(user, expiresAt);
    await user.click(
      screen.getByRole("button", { name: /发布并替换当前公告/ }),
    );

    // antd 的 confirm 弹窗在入场动画期间不计入可访问树，按文案定位。
    expect(
      await screen.findByText("新公告发布后，当前公告会立即失效。"),
    ).toBeTruthy();
    expect(publishAnnouncement).not.toHaveBeenCalled();
    await user.click(screen.getByText("发布并替换"));

    await waitFor(() => {
      expect(publishAnnouncement).toHaveBeenCalledTimes(1);
    });
  });

  it("shows the server's reason when publishing fails", async () => {
    const user = userEvent.setup({ delay: null });
    renderPage({
      getAnnouncement: vi.fn().mockResolvedValue({ announcement: null }),
      publishAnnouncement: vi
        .fn()
        .mockRejectedValue(
          new ApiError(
            "expires_at_in_past",
            "expiresAt must be in the future.",
            400,
          ),
        ),
    });

    await screen.findByText("当前没有公告");
    await user.type(screen.getByLabelText("内容"), "x");
    await pickExpiresAt(user, dayjs().add(1, "hour"));
    await user.click(screen.getByRole("button", { name: /发布公告/ }));
    await user.click(await screen.findByText("确认发布"));

    expect(
      await screen.findByText("expiresAt must be in the future."),
    ).toBeTruthy();
  });

  it("withdraws with a reason and shows nothing current", async () => {
    const withdrawAnnouncement = vi
      .fn()
      .mockResolvedValue({ withdrawnId: "announcement-1" });
    const user = userEvent.setup({ delay: null });
    renderPage({
      getAnnouncement: vi
        .fn()
        .mockResolvedValue({ announcement: makeAnnouncement() }),
      withdrawAnnouncement,
    });

    await user.click(await screen.findByRole("button", { name: /撤\s*回/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByPlaceholderText(/操作原因/),
      "维护提前结束",
    );
    await user.click(within(dialog).getByRole("button", { name: /确认执行/ }));

    await waitFor(() => {
      expect(withdrawAnnouncement).toHaveBeenCalledWith("维护提前结束");
    });
    expect(await screen.findByText("当前没有公告")).toBeTruthy();
  });
  it("keeps a withdrawal when an older refresh answers after it", async () => {
    const stale = deferred<{ announcement: AdminAnnouncement | null }>();
    const getAnnouncement = vi
      .fn()
      .mockResolvedValueOnce({ announcement: makeAnnouncement() })
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue({ announcement: null });
    const user = userEvent.setup({ delay: null });
    renderPage({
      getAnnouncement,
      withdrawAnnouncement: vi
        .fn()
        .mockResolvedValue({ withdrawnId: "announcement-1" }),
    });

    await screen.findByText(/今晚 04:30 维护/);
    // A refresh still in flight when the withdrawal lands.
    await user.click(screen.getByRole("button", { name: /刷\s*新/ }));
    await waitFor(() => {
      expect(getAnnouncement).toHaveBeenCalledTimes(2);
    });
    await user.click(screen.getByRole("button", { name: /撤\s*回/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /确认执行/ }));
    expect(await screen.findByText("当前没有公告")).toBeTruthy();

    stale.resolve({ announcement: makeAnnouncement() });
    await new Promise((settle) => setTimeout(settle, 50));
    expect(screen.getByText("当前没有公告")).toBeTruthy();
    expect(screen.queryByText(/今晚 04:30 维护/)).toBeNull();
  });

  it("keeps a publication when an older refresh answers after it", async () => {
    const stale = deferred<{ announcement: AdminAnnouncement | null }>();
    const published = makeAnnouncement({
      id: "announcement-2",
      message: "新版本已发布",
    });
    const getAnnouncement = vi
      .fn()
      .mockResolvedValueOnce({ announcement: null })
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue({ announcement: published });
    const user = userEvent.setup({ delay: null });
    renderPage({
      getAnnouncement,
      publishAnnouncement: vi
        .fn()
        .mockResolvedValue({ announcement: published }),
    });

    await screen.findByText("当前没有公告");
    await user.click(screen.getByRole("button", { name: /刷\s*新/ }));
    await waitFor(() => {
      expect(getAnnouncement).toHaveBeenCalledTimes(2);
    });
    await user.type(screen.getByLabelText("内容"), "新版本已发布");
    await pickExpiresAt(user, dayjs().add(1, "hour"));
    await user.click(screen.getByRole("button", { name: /发布公告/ }));
    await user.click(await screen.findByText("确认发布"));
    expect(await screen.findByText("新版本已发布")).toBeTruthy();

    stale.resolve({ announcement: null });
    await new Promise((settle) => setTimeout(settle, 50));
    expect(screen.getByText("新版本已发布")).toBeTruthy();
    expect(screen.queryByText("当前没有公告")).toBeNull();
  });
});
