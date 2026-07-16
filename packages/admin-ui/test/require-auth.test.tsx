import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AuthContext } from "../src/auth/auth-context.js";
import type { AuthContextValue } from "../src/auth/auth-context.js";
import { createAuthValue } from "./helpers.js";
import { RequireAuth } from "../src/auth/require-auth.js";

function LoginProbe() {
  const location = useLocation();
  return <div>login-search:{location.search}</div>;
}

function renderGuard(authValue: AuthContextValue, initialEntry: string) {
  return render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route
            path="/overview"
            element={
              <RequireAuth>
                <div>protected-content</div>
              </RequireAuth>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("RequireAuth", () => {
  it("preserves the query string when redirecting to login", () => {
    renderGuard(createAuthValue(), "/overview?keyword=abc");

    expect(screen.getByText("login-search:?keyword=abc")).toBeTruthy();
  });

  it("renders protected content when authenticated", () => {
    renderGuard(createAuthValue({ token: "token-1" }), "/overview");

    expect(screen.getByText("protected-content")).toBeTruthy();
  });

  it("shows a retryable error instead of dropping the session on meError", async () => {
    const user = userEvent.setup({ delay: null });
    const authValue = createAuthValue({
      token: "token-1",
      meError: "服务暂时不可用",
    });
    renderGuard(authValue, "/overview");

    expect(screen.getByText("管理员身份校验失败")).toBeTruthy();
    expect(screen.getByText("服务暂时不可用")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /重\s*试/ }));
    expect(authValue.retryLoadMe).toHaveBeenCalledTimes(1);
  });
});
