import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/http.js";
import { AuthContext } from "../src/auth/auth-context.js";
import type { AuthContextValue } from "../src/auth/auth-context.js";
import { LoginPage } from "../src/pages/login-page.js";

function createAuthValue(
  overrides: Partial<AuthContextValue> = {},
): AuthContextValue {
  return {
    token: "",
    me: null,
    initializing: false,
    meError: "",
    api: {
      login: vi.fn(),
      logout: vi.fn(),
      getMe: vi.fn(),
    },
    signIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    retryLoadMe: vi.fn(),
    ...overrides,
  };
}

function renderLogin(authValue: AuthContextValue, initialEntry = "/login") {
  return render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/overview" element={<div>overview-page</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("LoginPage", () => {
  it("submits trimmed credentials and navigates to overview", async () => {
    const user = userEvent.setup();
    const authValue = createAuthValue();
    renderLogin(authValue);

    await user.type(screen.getByLabelText("用户名"), " admin ");
    await user.type(screen.getByLabelText("密码"), "secret");
    await user.click(screen.getByRole("button", { name: /登\s*录/ }));

    await waitFor(() => {
      expect(authValue.signIn).toHaveBeenCalledWith("admin", "secret");
    });
    expect(await screen.findByText("overview-page")).toBeTruthy();
  });

  it("shows the error message when sign-in fails", async () => {
    const user = userEvent.setup();
    const authValue = createAuthValue({
      signIn: vi.fn().mockRejectedValue(new Error("用户名或密码错误。")),
    });
    renderLogin(authValue);

    await user.type(screen.getByLabelText("用户名"), "admin");
    await user.type(screen.getByLabelText("密码"), "wrong");
    await user.click(screen.getByRole("button", { name: /登\s*录/ }));

    expect(await screen.findByText("用户名或密码错误。")).toBeTruthy();
  });

  it("maps invalid_credentials to a friendly Chinese message", async () => {
    const user = userEvent.setup();
    const authValue = createAuthValue({
      signIn: vi
        .fn()
        .mockRejectedValue(
          new ApiError(
            "invalid_credentials",
            "Invalid username or password.",
            401,
          ),
        ),
    });
    renderLogin(authValue);

    await user.type(screen.getByLabelText("用户名"), "admin");
    await user.type(screen.getByLabelText("密码"), "wrong");
    await user.click(screen.getByRole("button", { name: /登\s*录/ }));

    expect(await screen.findByText("用户名或密码错误。")).toBeTruthy();
  });

  it("redirects to overview when already authenticated", () => {
    renderLogin(createAuthValue({ token: "token-1" }));
    expect(screen.getByText("overview-page")).toBeTruthy();
  });

  describe("demo preview notice", () => {
    afterEach(() => {
      delete (globalThis as { __ADMIN_UI_CONFIG__?: unknown })
        .__ADMIN_UI_CONFIG__;
    });

    it("points demo previews at the legacy panel", () => {
      (globalThis as { __ADMIN_UI_CONFIG__?: unknown }).__ADMIN_UI_CONFIG__ = {
        demoEnabled: true,
      };
      renderLogin(createAuthValue(), "/login?demo=1");

      expect(screen.getByText("新控制台暂不支持演示模式")).toBeTruthy();
    });

    it("stays hidden when demo mode is disabled", () => {
      renderLogin(createAuthValue(), "/login?demo=1");

      expect(screen.queryByText("新控制台暂不支持演示模式")).toBeNull();
    });
  });
});
