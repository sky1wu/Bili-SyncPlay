import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { EventListResult, RuntimeEventRecord } from "../src/api/types.js";
import { AuthContext } from "../src/auth/auth-context.js";
import type { AuthContextValue } from "../src/auth/auth-context.js";
import { EventsPage } from "../src/pages/events/events-page.js";
import { createAuthValue, createStubApi } from "./helpers.js";

function makeEvent(
  overrides: Partial<RuntimeEventRecord> = {},
): RuntimeEventRecord {
  return {
    id: "event-1",
    timestamp: new Date().toISOString(),
    event: "rate_limited",
    roomCode: "ROOM1",
    sessionId: "session-1",
    remoteAddress: "1.2.3.4",
    origin: "chrome-extension://abc",
    result: "rejected",
    details: { limit: "playback:update" },
    ...overrides,
  };
}

function makeResult(items: RuntimeEventRecord[]): EventListResult {
  return { items, total: items.length, pagination: { page: 1, pageSize: 20 } };
}

function renderEvents(authValue: AuthContextValue, initialEntry = "/events") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <AuthContext.Provider value={authValue}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/events" element={<EventsPage />} />
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

describe("EventsPage", () => {
  it("renders events with labels, result badge and details entry", async () => {
    renderEvents(
      createAuth({
        listEvents: vi.fn().mockResolvedValue(makeResult([makeEvent()])),
      }),
    );

    expect(await screen.findByText("rate_limited")).toBeTruthy();
    expect(screen.getByText("触发限流")).toBeTruthy();
    expect(screen.getByText("已拒绝")).toBeTruthy();
    expect(screen.getByText("ROOM1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "JSON" })).toBeTruthy();
  });

  it("passes URL filters through to the events query", async () => {
    const listEvents = vi.fn().mockResolvedValue(makeResult([]));
    renderEvents(
      createAuth({ listEvents }),
      "/events?event=rate_limited&roomCode=R1&includeSystem=true&from=1000&to=2000",
    );

    await waitFor(() => {
      expect(listEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "rate_limited",
          roomCode: "R1",
          includeSystem: true,
          from: 1000,
          to: 2000,
        }),
      );
    });
  });

  it("submits text filters and resets the page", async () => {
    const listEvents = vi.fn().mockResolvedValue(makeResult([]));
    const user = userEvent.setup();
    renderEvents(createAuth({ listEvents }), "/events?page=3");

    await user.type(screen.getByPlaceholderText("事件名"), "room_created");
    await user.click(screen.getByRole("button", { name: /查\s*询/ }));

    await waitFor(() => {
      expect(listEvents).toHaveBeenCalledWith(
        expect.objectContaining({ event: "room_created", page: 1 }),
      );
    });
  });

  it("opens the details JSON modal", async () => {
    const user = userEvent.setup();
    renderEvents(
      createAuth({
        listEvents: vi.fn().mockResolvedValue(makeResult([makeEvent()])),
      }),
    );

    await user.click(await screen.findByRole("button", { name: "JSON" }));
    expect(await screen.findByText(/playback:update/)).toBeTruthy();
  });

  it("shows an error state with retry on failure", async () => {
    const listEvents = vi
      .fn()
      .mockRejectedValueOnce(new Error("事件存储不可用"))
      .mockResolvedValue(makeResult([makeEvent()]));
    const user = userEvent.setup();
    renderEvents(createAuth({ listEvents }));

    expect(await screen.findByText("运行事件加载失败")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /重\s*试/ }));
    expect(await screen.findByText("rate_limited")).toBeTruthy();
  });
});
