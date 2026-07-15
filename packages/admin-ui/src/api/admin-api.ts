import type { HttpClient } from "./http.js";
import type {
  AdminLoginRequest,
  AdminLoginResult,
  AdminLogoutResult,
  AdminMeResult,
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
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;
