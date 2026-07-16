import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AdminConfigSummary } from "../src/api/types.js";
import { AuthContext } from "../src/auth/auth-context.js";
import type { AuthContextValue } from "../src/auth/auth-context.js";
import { ConfigPage } from "../src/pages/config/config-page.js";
import { createAuthValue, createStubApi } from "./helpers.js";

function makeConfig(
  overrides: Partial<AdminConfigSummary> = {},
): AdminConfigSummary {
  return {
    instanceId: "instance-1",
    persistence: {
      provider: "redis",
      emptyRoomTtlMs: 3_600_000,
      roomCleanupIntervalMs: 60_000,
      redisConfigured: true,
    },
    security: {
      allowedOrigins: ["chrome-extension://abc"],
      allowMissingOriginInDev: false,
      allowAnyFirefoxExtensionOrigin: true,
      trustedProxyAddresses: [],
      maxConnectionsPerIp: 20,
      connectionAttemptsPerMinute: 60,
      maxMembersPerRoom: 16,
      maxMessageBytes: 65536,
      invalidMessageCloseThreshold: 5,
      wsHeartbeatEnabled: true,
      wsHeartbeatIntervalMs: 30_000,
      rateLimits: { roomCreatePerMinute: 6, playbackUpdatePerSecond: 8 },
    },
    admin: {
      configured: true,
      username: "ops",
      role: "admin",
      sessionTtlMs: 43_200_000,
    },
    ...overrides,
  };
}

function renderConfig(authValue: AuthContextValue) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <AuthContext.Provider value={authValue}>
      <QueryClientProvider client={queryClient}>
        <ConfigPage />
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

function createAuth(api: Partial<AuthContextValue["api"]>) {
  return createAuthValue({
    token: "token-1",
    me: { id: "admin-1", username: "ops", role: "admin" },
    api: createStubApi(api),
  });
}

describe("ConfigPage", () => {
  it("renders instance, security and rate limit sections", async () => {
    renderConfig(
      createAuth({ getConfig: vi.fn().mockResolvedValue(makeConfig()) }),
    );

    expect(await screen.findByText("instance-1")).toBeTruthy();
    expect(screen.getByText("redis")).toBeTruthy();
    expect(screen.getByText("chrome-extension://abc")).toBeTruthy();
    expect(screen.getByText("建房 / 分钟")).toBeTruthy();
    expect(screen.getByText("ops")).toBeTruthy();
    expect(screen.queryByText(/全局后台进程/)).toBeNull();
  });

  it("warns when admin auth is not configured", async () => {
    renderConfig(
      createAuth({
        getConfig: vi
          .fn()
          .mockResolvedValue(makeConfig({ admin: { configured: false } })),
      }),
    );

    expect(await screen.findByText(/管理端认证未配置/)).toBeTruthy();
  });

  it("shows the global-admin scope hint for global instances", async () => {
    renderConfig(
      createAuth({
        getConfig: vi
          .fn()
          .mockResolvedValue(makeConfig({ instanceId: "global-admin-1" })),
      }),
    );

    expect(await screen.findByText(/全局后台进程/)).toBeTruthy();
  });

  it("shows a retryable error state on failure", async () => {
    const getConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error("配置读取失败"))
      .mockResolvedValue(makeConfig());
    const user = userEvent.setup({ delay: null });
    renderConfig(createAuth({ getConfig }));

    expect(await screen.findByText("配置摘要加载失败")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /重\s*试/ }));
    expect(await screen.findByText("instance-1")).toBeTruthy();
  });
});
