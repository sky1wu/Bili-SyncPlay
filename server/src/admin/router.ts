import type { IncomingMessage, ServerResponse } from "node:http";
import { AdminActionError } from "./action-service.js";
import { getBearerToken, getPathSegments, JsonBodyParseError } from "./request.js";
import { sendError } from "./response.js";
import {
  FORBIDDEN_MESSAGE,
  INTERNAL_SERVER_ERROR_MESSAGE,
  UNAUTHORIZED_MESSAGE,
} from "../messages.js";
import { handleActionRoutes } from "./routes/action-routes.js";
import { handleAuthRoutes } from "./routes/auth-routes.js";
import { handleReadRoutes } from "./routes/read-routes.js";
import { handleSystemRoutes } from "./routes/system-routes.js";
import type { AdminRouteHandler, AdminRouterOptions } from "./router-types.js";
import type { AdminRole, AdminSession } from "./types.js";

function unauthorized(response: ServerResponse): void {
  sendError(response, 401, "unauthorized", UNAUTHORIZED_MESSAGE);
}

function forbidden(response: ServerResponse): void {
  sendError(response, 403, "forbidden", FORBIDDEN_MESSAGE);
}

export function createAdminRouter(options: AdminRouterOptions) {
  const roleRank: Record<AdminRole, number> = {
    viewer: 1,
    operator: 2,
    admin: 3,
  };
  const routeHandlers: AdminRouteHandler[] = [
    handleSystemRoutes,
    handleAuthRoutes,
    handleReadRoutes,
    handleActionRoutes,
  ];

  async function requireAdmin(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<AdminSession | null> {
    const token = getBearerToken(request);
    if (!token || !options.authService) {
      unauthorized(response);
      return null;
    }
    const session = await options.authService.authenticate(token);
    if (!session) {
      unauthorized(response);
      return null;
    }
    return session;
  }

  function requireRole(
    session: AdminSession,
    role: AdminRole,
    response: ServerResponse,
  ): boolean {
    if (roleRank[session.role] < roleRank[role]) {
      forbidden(response);
      return false;
    }
    return true;
  }

  return {
    async handle(
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<boolean> {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const segments = getPathSegments(request);

      try {
        for (const routeHandler of routeHandlers) {
          if (
            await routeHandler({
              request,
              response,
              pathname,
              segments,
              options,
              helpers: {
                requireAdmin,
                requireRole,
              },
            })
          ) {
            return true;
          }
        }
        return false;
      } catch (error) {
        if (error instanceof JsonBodyParseError) {
          sendError(response, 400, "invalid_json", error.message);
          return true;
        }
        if (error instanceof AdminActionError) {
          sendError(response, error.statusCode, error.code, error.message);
          return true;
        }
        sendError(
          response,
          500,
          "internal_error",
          INTERNAL_SERVER_ERROR_MESSAGE,
        );
        return true;
      }
    },
  };
}
