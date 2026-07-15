import { describe, expect, it, vi } from "vitest";
import { ApiError, createHttpClient } from "../src/api/http.js";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("createHttpClient", () => {
  it("sends bearer token and JSON body, returns envelope data", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true, data: { value: 42 } }));
    const client = createHttpClient({
      baseUrl: "https://api.example.com",
      getToken: () => "token-1",
      fetchImpl,
    });

    const data = await client.request<{ value: number }>("/api/admin/x", {
      method: "POST",
      body: { reason: "test" },
    });

    expect(data).toEqual({ value: 42 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.com/api/admin/x",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer token-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: "test" }),
      }),
    );
  });

  it("omits auth header when token is empty", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true, data: null }));
    const client = createHttpClient({ getToken: () => "", fetchImpl });

    await client.request("/api/admin/me");

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/admin/me",
      expect.objectContaining({ headers: {} }),
    );
  });

  it("invokes onUnauthorized and throws on 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(401, {
        ok: false,
        error: { code: "unauthorized", message: "Unauthorized." },
      }),
    );
    const onUnauthorized = vi.fn();
    const client = createHttpClient({
      getToken: () => "expired",
      onUnauthorized,
      fetchImpl,
    });

    const error = await client
      .request<never>("/api/admin/me")
      .catch((e: unknown) => e as ApiError);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("unauthorized");
    expect(error.status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("keeps the error envelope for unauthenticated 401 (login failure)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(401, {
        ok: false,
        error: {
          code: "invalid_credentials",
          message: "Invalid username or password.",
        },
      }),
    );
    const onUnauthorized = vi.fn();
    const client = createHttpClient({
      getToken: () => "",
      onUnauthorized,
      fetchImpl,
    });

    const error = await client
      .request<never>("/api/admin/auth/login")
      .catch((e: unknown) => e as ApiError);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("invalid_credentials");
    expect(error.message).toBe("Invalid username or password.");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("maps error envelope code and message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(429, {
        ok: false,
        error: { code: "too_many_login_attempts", message: "稍后再试。" },
      }),
    );
    const client = createHttpClient({ getToken: () => "", fetchImpl });

    const error = await client
      .request<never>("/api/admin/auth/login")
      .catch((e: unknown) => e as ApiError);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("too_many_login_attempts");
    expect(error.message).toBe("稍后再试。");
    expect(error.status).toBe(429);
  });

  it("falls back to request_failed for non-JSON failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("oops", { status: 500 }));
    const client = createHttpClient({ getToken: () => "", fetchImpl });

    const error = await client
      .request<never>("/api/admin/overview")
      .catch((e: unknown) => e as ApiError);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("request_failed");
    expect(error.status).toBe(500);
  });
});
