import {
  ADMIN_AUTH_UNAVAILABLE_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
  UNAUTHORIZED_MESSAGE,
} from "../../messages.js";
import { getBearerToken, readJsonBody } from "../request.js";
import { sendError, sendOk } from "../response.js";
import type { AdminRouteHandler } from "../router-types.js";

export const handleAuthRoutes: AdminRouteHandler = async ({
  request,
  response,
  pathname,
  helpers,
  options,
}) => {
  if (request.method === "POST" && pathname === "/api/admin/auth/login") {
    if (!options.authService) {
      sendError(
        response,
        503,
        "admin_auth_unavailable",
        ADMIN_AUTH_UNAVAILABLE_MESSAGE,
      );
      return true;
    }
    const body = await readJsonBody<{
      username?: string;
      password?: string;
    }>(request);
    const username = body.username?.trim() ?? "";
    const password = body.password ?? "";
    try {
      const result = await options.authService.login(username, password);
      sendOk(response, {
        token: result.token,
        expiresAt: result.expiresAt,
        admin: {
          id: result.admin.adminId,
          username: result.admin.username,
          role: result.admin.role,
        },
      });
    } catch {
      sendError(
        response,
        401,
        "invalid_credentials",
        INVALID_CREDENTIALS_MESSAGE,
      );
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/admin/auth/logout") {
    const token = getBearerToken(request);
    if (!token || !options.authService) {
      sendError(response, 401, "unauthorized", UNAUTHORIZED_MESSAGE);
      return true;
    }
    await options.authService.logout(token);
    sendOk(response, { success: true });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/admin/me") {
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    sendOk(response, {
      id: session.adminId,
      username: session.username,
      role: session.role,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
    });
    return true;
  }

  return false;
};
