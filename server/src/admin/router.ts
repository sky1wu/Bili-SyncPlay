import type { IncomingMessage, ServerResponse } from "node:http";
import { AdminActionError } from "./action-service.js";
import { AdminSessionStoreUnavailableError } from "../redis-admin-session-store.js";
import { AuditStoreUnavailableError } from "./redis-audit-store.js";
import { EventStoreUnavailableError } from "./redis-event-store.js";
import { toRedisStoreUnavailableHttpError } from "../redis-store-unavailable.js";
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
        if (error instanceof EventStoreUnavailableError) {
          // 503, not 500: the store refused to issue the read because its Redis
          // connection is not answering, and a retry once Redis recovers is
          // exactly the right thing for the caller to do. Refusing is the
          // point — issuing it would queue a command that never returns behind
          // the one already stuck (#266 review).
          sendError(response, 503, "event_store_unavailable", error.message);
          return true;
        }
        if (error instanceof AdminSessionStoreUnavailableError) {
          // 503 for the same reason as the two stores below, on the path that
          // runs BEFORE any of them: `authenticate` is the first Redis command
          // of every admin request, and until #271 a stalled session store hung
          // it with no bound at all. A 401 would be worse than a 500 here — it
          // would log an operator out over a Redis blip — so the store answers
          // with its own type rather than an absent session.
          sendError(
            response,
            503,
            "admin_session_store_unavailable",
            error.message,
          );
          return true;
        }
        if (error instanceof AuditStoreUnavailableError) {
          // Same 503 for the same reason as the event store's, on the sibling
          // path: the audit list refused to issue its read because the write
          // path on that connection is not answering, and retrying once Redis
          // recovers is exactly right (#267).
          sendError(response, 503, "audit_store_unavailable", error.message);
          return true;
        }
        const redisStoreUnavailable = toRedisStoreUnavailableHttpError(error);
        if (redisStoreUnavailable) {
          // The room and shared-runtime stores use caller-side caps and refuse
          // new commands once their non-cancelling caps fill the admission
          // budget. Both outcomes are transient dependency failures, not
          // application bugs. The shared translation is also used by the
          // dedicated metrics server, so every HTTP boundary names the same
          // retryable failure without exposing operation details.
          sendError(
            response,
            redisStoreUnavailable.statusCode,
            redisStoreUnavailable.code,
            redisStoreUnavailable.message,
          );
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
