import { resolveApiPath } from "./state.js";

export function createAdminApi({
  state,
  serializeQuery,
  clearAuth,
  navigate,
  mockRequest,
}) {
  return {
    async request(path, options = {}) {
      if (state.demo) {
        return mockRequest(path, options);
      }

      const response = await fetch(resolveApiPath(path), {
        method: options.method || "GET",
        headers: {
          ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
          ...(options.body ? { "content-type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      const contentType = response.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await response.json()
        : null;

      if (response.status === 401) {
        clearAuth();
        navigate("/login", true);
        throw { code: "unauthorized", message: "登录已失效，请重新登录。" };
      }

      if (!response.ok || !payload?.ok) {
        throw {
          code: payload?.error?.code || "request_failed",
          message: payload?.error?.message || "请求失败。",
        };
      }

      return payload.data;
    },
    login(payload) {
      return this.request("/api/admin/auth/login", {
        method: "POST",
        body: payload,
      });
    },
    logout() {
      return this.request("/api/admin/auth/logout", { method: "POST" });
    },
    getMe() {
      return this.request("/api/admin/me");
    },
    getHealth() {
      return this.request("/healthz");
    },
    getReady() {
      return this.request("/readyz");
    },
    getOverview() {
      return this.request("/api/admin/overview");
    },
    listRooms(query) {
      return this.request(`/api/admin/rooms${serializeQuery(query)}`);
    },
    getRoomDetail(roomCode) {
      return this.request(`/api/admin/rooms/${encodeURIComponent(roomCode)}`);
    },
    listIpBlocks() {
      return this.request("/api/admin/ip-blocks");
    },
    blockIp(ip, reason) {
      return this.request("/api/admin/ip-blocks", {
        method: "POST",
        body: { ip, reason },
      });
    },
    unblockIp(ip, reason) {
      return this.request(`/api/admin/ip-blocks/${encodeURIComponent(ip)}`, {
        method: "DELETE",
        body: { reason },
      });
    },
    closeRoom(roomCode, reason) {
      return this.request(
        `/api/admin/rooms/${encodeURIComponent(roomCode)}/close`,
        { method: "POST", body: { reason } },
      );
    },
    expireRoom(roomCode, reason) {
      return this.request(
        `/api/admin/rooms/${encodeURIComponent(roomCode)}/expire`,
        { method: "POST", body: { reason } },
      );
    },
    clearRoomVideo(roomCode, reason) {
      return this.request(
        `/api/admin/rooms/${encodeURIComponent(roomCode)}/clear-video`,
        { method: "POST", body: { reason } },
      );
    },
    kickMember(roomCode, memberId, reason) {
      return this.request(
        `/api/admin/rooms/${encodeURIComponent(roomCode)}/members/${encodeURIComponent(memberId)}/kick`,
        {
          method: "POST",
          body: { reason },
        },
      );
    },
    disconnectSession(sessionId, reason) {
      return this.request(
        `/api/admin/sessions/${encodeURIComponent(sessionId)}/disconnect`,
        {
          method: "POST",
          body: { reason },
        },
      );
    },
    listEvents(query) {
      return this.request(`/api/admin/events${serializeQuery(query)}`);
    },
    listAuditLogs(query) {
      return this.request(`/api/admin/audit-logs${serializeQuery(query)}`);
    },
    getConfig() {
      return this.request("/api/admin/config");
    },
  };
}
