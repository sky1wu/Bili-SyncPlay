import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { AuditLogListResult, AuditLogRecord } from "../src/api/types.js";
import { AuthContext } from "../src/auth/auth-context.js";
import type { AuthContextValue } from "../src/auth/auth-context.js";
import { AuditLogsPage } from "../src/pages/audit/audit-page.js";
import { createAuthValue, createStubApi } from "./helpers.js";

function makeAuditRecord(
  overrides: Partial<AuditLogRecord> = {},
): AuditLogRecord {
  return {
    id: "audit-1",
    timestamp: new Date().toISOString(),
    actor: { adminId: "admin-1", username: "ops", role: "operator" },
    action: "close_room",
    targetType: "room",
    targetId: "ROOM1",
    request: { reason: "违规内容" },
    result: "ok",
    reason: "违规内容",
    ...overrides,
  };
}

function makeResult(items: AuditLogRecord[]): AuditLogListResult {
  return { items, total: items.length, pagination: { page: 1, pageSize: 20 } };
}

function renderAudit(
  authValue: AuthContextValue,
  initialEntry = "/audit-logs",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <AuthContext.Provider value={authValue}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/audit-logs" element={<AuditLogsPage />} />
          </Routes>
        </MemoryRouter>
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

describe("AuditLogsPage", () => {
  it("renders audit records with actor, action label, target and reason", async () => {
    renderAudit(
      createAuth({
        listAuditLogs: vi
          .fn()
          .mockResolvedValue(makeResult([makeAuditRecord()])),
      }),
    );

    expect(await screen.findByText("close_room")).toBeTruthy();
    expect(screen.getByText("关闭房间")).toBeTruthy();
    expect(screen.getByText("ops")).toBeTruthy();
    expect(screen.getByText("ROOM1")).toBeTruthy();
    expect(screen.getByText("成功")).toBeTruthy();
    expect(screen.getAllByText("违规内容").length).toBeGreaterThan(0);
  });

  it("falls back to request.reason when the top-level reason is absent", async () => {
    renderAudit(
      createAuth({
        listAuditLogs: vi.fn().mockResolvedValue(
          makeResult([
            makeAuditRecord({
              reason: undefined,
              request: { reason: "深夜清理空闲房间" },
            }),
          ]),
        ),
      }),
    );

    expect(await screen.findByText("深夜清理空闲房间")).toBeTruthy();
    expect(screen.queryByText("未填写")).toBeNull();
  });

  it("passes URL filters through to the audit query", async () => {
    const listAuditLogs = vi.fn().mockResolvedValue(makeResult([]));
    renderAudit(
      createAuth({ listAuditLogs }),
      "/audit-logs?actor=ops&targetType=room&result=rejected",
    );

    await waitFor(() => {
      expect(listAuditLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: "ops",
          targetType: "room",
          result: "rejected",
        }),
      );
    });
  });

  it("opens the request JSON modal", async () => {
    const user = userEvent.setup({ delay: null });
    renderAudit(
      createAuth({
        listAuditLogs: vi
          .fn()
          .mockResolvedValue(makeResult([makeAuditRecord()])),
      }),
    );

    await user.click(await screen.findByRole("button", { name: "JSON" }));
    expect(await screen.findByText(/"reason"/)).toBeTruthy();
  });

  it("shows an error state with retry on failure", async () => {
    const listAuditLogs = vi
      .fn()
      .mockRejectedValueOnce(new Error("审计存储不可用"))
      .mockResolvedValue(makeResult([makeAuditRecord()]));
    const user = userEvent.setup({ delay: null });
    renderAudit(createAuth({ listAuditLogs }));

    expect(await screen.findByText("审计日志加载失败")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /重\s*试/ }));
    expect(await screen.findByText("close_room")).toBeTruthy();
  });
});
