import type { HttpClient } from "./http.js";
import { toQueryString } from "./query-string.js";
import type {
  AdminActionResult,
  AdminLoginRequest,
  AdminLoginResult,
  AdminLogoutResult,
  AdminMeResult,
  AdminOverview,
  AuditLogListResult,
  AuditLogQuery,
  EventListQuery,
  EventListResult,
  ReadyStatus,
  RoomDetail,
  RoomListQuery,
  RoomListResult,
} from "./types.js";

export function createAdminApi(client: HttpClient) {
  return {
    login(payload: AdminLoginRequest): Promise<AdminLoginResult> {
      return client.request("/api/admin/auth/login", {
        method: "POST",
        body: payload,
      });
    },
    logout(): Promise<AdminLogoutResult> {
      return client.request("/api/admin/auth/logout", { method: "POST" });
    },
    getMe(): Promise<AdminMeResult> {
      return client.request("/api/admin/me");
    },
    getOverview(): Promise<AdminOverview> {
      return client.request("/api/admin/overview");
    },
    getReady(): Promise<ReadyStatus> {
      return client.request("/readyz");
    },
    listRooms(query: RoomListQuery = {}): Promise<RoomListResult> {
      return client.request(`/api/admin/rooms${toQueryString(query)}`);
    },
    getRoomDetail(roomCode: string): Promise<RoomDetail> {
      return client.request(`/api/admin/rooms/${encodeURIComponent(roomCode)}`);
    },
    closeRoom(roomCode: string, reason?: string): Promise<AdminActionResult> {
      return client.request(
        `/api/admin/rooms/${encodeURIComponent(roomCode)}/close`,
        { method: "POST", body: { reason: reason || undefined } },
      );
    },
    expireRoom(roomCode: string, reason?: string): Promise<AdminActionResult> {
      return client.request(
        `/api/admin/rooms/${encodeURIComponent(roomCode)}/expire`,
        { method: "POST", body: { reason: reason || undefined } },
      );
    },
    clearRoomVideo(
      roomCode: string,
      reason?: string,
    ): Promise<AdminActionResult> {
      return client.request(
        `/api/admin/rooms/${encodeURIComponent(roomCode)}/clear-video`,
        { method: "POST", body: { reason: reason || undefined } },
      );
    },
    kickMember(
      roomCode: string,
      memberId: string,
      reason?: string,
    ): Promise<AdminActionResult> {
      return client.request(
        `/api/admin/rooms/${encodeURIComponent(roomCode)}/members/${encodeURIComponent(memberId)}/kick`,
        { method: "POST", body: { reason: reason || undefined } },
      );
    },
    listEvents(query: EventListQuery = {}): Promise<EventListResult> {
      return client.request(`/api/admin/events${toQueryString(query)}`);
    },
    listAuditLogs(query: AuditLogQuery = {}): Promise<AuditLogListResult> {
      return client.request(`/api/admin/audit-logs${toQueryString(query)}`);
    },
    disconnectSession(
      sessionId: string,
      reason?: string,
    ): Promise<AdminActionResult> {
      return client.request(
        `/api/admin/sessions/${encodeURIComponent(sessionId)}/disconnect`,
        { method: "POST", body: { reason: reason || undefined } },
      );
    },
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;
