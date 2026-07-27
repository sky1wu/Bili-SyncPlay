import { render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

// 控制台挂在 /admin-next 下（app.tsx 的 BrowserRouter basename），而其余路由测试
// 一律用无 basename 的 MemoryRouter——basename 的拼接语义因此没有任何覆盖。
// 升级 react-router 大版本时这里最容易悄悄改变（路径前缀是否计入 path 匹配、
// Navigate 的目标是否再次带上前缀），故单独锁住。
const BASENAME = "/admin-next";

function renderAt(pathname: string) {
  window.history.replaceState({}, "", pathname);
  return render(
    <BrowserRouter basename={BASENAME}>
      <Routes>
        <Route path="/login" element={<div>login-page</div>} />
        <Route index element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<div>overview-page</div>} />
        <Route path="/rooms/:roomCode" element={<div>room-detail</div>} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Routes>
    </BrowserRouter>,
  );
}

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("BrowserRouter basename", () => {
  it("matches routes against the path after the basename", () => {
    renderAt(`${BASENAME}/overview`);
    expect(screen.getByText("overview-page")).toBeTruthy();
  });

  it("keeps the basename out of route params", () => {
    renderAt(`${BASENAME}/rooms/ABCD12`);
    expect(screen.getByText("room-detail")).toBeTruthy();
  });

  it("redirects the index route without dropping the basename", async () => {
    renderAt(`${BASENAME}/`);
    expect(await screen.findByText("overview-page")).toBeTruthy();
    await waitFor(() => {
      expect(window.location.pathname).toBe(`${BASENAME}/overview`);
    });
  });

  it("sends unknown paths to overview, still under the basename", async () => {
    renderAt(`${BASENAME}/not-a-page`);
    expect(await screen.findByText("overview-page")).toBeTruthy();
    await waitFor(() => {
      expect(window.location.pathname).toBe(`${BASENAME}/overview`);
    });
  });

  it("renders nothing for paths outside the basename", () => {
    renderAt("/somewhere-else");
    expect(screen.queryByText("overview-page")).toBeNull();
    expect(screen.queryByText("login-page")).toBeNull();
  });
});
