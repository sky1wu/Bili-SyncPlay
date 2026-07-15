import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../src/auth/auth-context.js";

const STORAGE_KEY = "bili-syncplay-admin-token";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function Probe() {
  const { token, meError, initializing, me } = useAuth();
  if (initializing) {
    return <div>state:initializing</div>;
  }
  return (
    <div>
      state:token={token ? "yes" : "no"};me={me ? me.username : "none"};error=
      {meError || "none"}
    </div>
  );
}

function renderProvider() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

describe("AuthProvider bootstrap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the stored token and reports meError on non-401 failures", async () => {
    localStorage.setItem(STORAGE_KEY, "token-1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(500, {
          ok: false,
          error: { code: "internal_error", message: "Internal server error." },
        }),
      ),
    );

    renderProvider();

    expect(
      await screen.findByText(
        /token=yes;me=none;error=Internal server error\./,
      ),
    ).toBeTruthy();
    expect(localStorage.getItem(STORAGE_KEY)).toBe("token-1");
  });

  it("clears the session on 401 during bootstrap", async () => {
    localStorage.setItem(STORAGE_KEY, "expired");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(401, {
          ok: false,
          error: { code: "unauthorized", message: "Unauthorized." },
        }),
      ),
    );

    renderProvider();

    expect(await screen.findByText(/token=no;me=none;error=none/)).toBeTruthy();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("loads the identity when the stored session is valid", async () => {
    localStorage.setItem(STORAGE_KEY, "token-1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          ok: true,
          data: {
            id: "admin-1",
            username: "ops",
            role: "admin",
            expiresAt: 0,
            lastSeenAt: 0,
          },
        }),
      ),
    );

    renderProvider();

    expect(await screen.findByText(/token=yes;me=ops;error=none/)).toBeTruthy();
  });
});
