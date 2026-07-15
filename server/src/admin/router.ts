import type { IncomingMessage, ServerResponse } from "node:http";
import { AdminActionError } from "./action-service.js";
import {
  requireAdminWriteOrigin,
  setAdminCorsResponseHeaders,
} from "./csrf.js";
import {
  getBearerToken,
  getPathSegments,
  JsonBodyParseError,
} from "./request.js";
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

function getAdminCorsAllowedMethods(pathname: string): string | null {
  if (pathname.startsWith("/api/admin/")) {
    return "GET, POST, OPTIONS";
  }
  if (pathname === "/healthz" || pathname === "/readyz") {
    return "GET, OPTIONS";
  }
  return null;
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

  function requireWriteOrigin(
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean {
    return requireAdminWriteOrigin(
      request,
      response,
      options.writeOriginPolicy,
    );
  }

  function getIpKey(request: IncomingMessage): string {
    if (options.getRequestIpKey) {
      return options.getRequestIpKey(request);
    }
    return request.socket.remoteAddress ?? "unknown";
  }

  return {
    async handle(
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<boolean> {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const segments = getPathSegments(request);

      try {
        const corsAllowedMethods = getAdminCorsAllowedMethods(pathname);
        if (corsAllowedMethods) {
          setAdminCorsResponseHeaders(
            request,
            response,
            options.writeOriginPolicy,
          );
          if (request.method === "OPTIONS") {
            if (!requireWriteOrigin(request, response)) {
              return true;
            }
            response.setHeader(
              "access-control-allow-methods",
              corsAllowedMethods,
            );
            response.setHeader(
              "access-control-allow-headers",
              "authorization, content-type",
            );
            response.writeHead(204);
            response.end();
            return true;
          }
        }

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
                requireWriteOrigin,
                getIpKey,
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
          sendError(
            response,
            error.statusCode,
            error.code,
            error.message,
            error.details,
          );
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
