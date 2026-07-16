import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AuthContext } from "../src/auth/auth-context.js";
import type { AuthContextValue } from "../src/auth/auth-context.js";
import { createAuthValue } from "./helpers.js";
import { AppLayout } from "../src/layout/app-layout.js";

function createLayoutAuthValue(
  overrides: Partial<AuthContextValue> = {},
): AuthContextValue {
  return createAuthValue({
    token: "token-1",
    me: { id: "admin-1", username: "ops", role: "operator" },
    ...overrides,
  });
}

function renderLayout(authValue: AuthContextValue) {
  return render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter initialEntries={["/overview"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/overview" element={<div>overview-content</div>} />
          </Route>
          <Route path="/login" element={<div>login-page</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("AppLayout", () => {
  it("renders navigation, user info and the active page content", () => {
    renderLayout(createLayoutAuthValue());

    for (const label of [
      "概览",
      "房间管理",
      "运行事件",
      "审计日志",
      "配置摘要",
    ]) {
      // 当前激活页的标签会同时出现在侧边菜单和页头标题里。
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("ops")).toBeTruthy();
    expect(screen.getByText("operator")).toBeTruthy();
    expect(screen.getByText("overview-content")).toBeTruthy();
  });

  it("signs out and navigates to login", async () => {
    const user = userEvent.setup({ delay: null });
    const authValue = createLayoutAuthValue();
    renderLayout(authValue);

    await user.click(screen.getByRole("button", { name: /退\s*出/ }));

    await waitFor(() => {
      expect(authValue.signOut).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText("login-page")).toBeTruthy();
  });
});
