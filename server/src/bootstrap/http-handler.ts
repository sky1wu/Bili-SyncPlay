import type { IncomingMessage, ServerResponse } from "node:http";
import { tryHandleAdminPanel } from "../admin-panel.js";
import type { createSecurityPolicy } from "../security.js";
import type { AdminUiConfig } from "../types.js";

export function createHttpRequestHandler(args: {
  adminRouter: {
    handle: (
      request: IncomingMessage,
      response: ServerResponse,
    ) => Promise<boolean>;
  };
  securityPolicy: ReturnType<typeof createSecurityPolicy>;
  adminUiConfig?: AdminUiConfig;
  metricsEnabled?: boolean;
}) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const adminUiEnabled = args.adminUiConfig?.enabled !== false;
    const metricsEnabled = args.metricsEnabled ?? true;
    if (pathname === "/metrics" && !metricsEnabled) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: false,
          error: {
            code: "not_found",
            message: "Not found.",
          },
        }),
      );
      return;
    }
    if (pathname === "/api/connection-check") {
      const originHeader = request.headers.origin;
      const origin = typeof originHeader === "string" ? originHeader : null;
      const originCheck = args.securityPolicy.isOriginAllowed(origin);
      const responseHeaders: Record<string, string> = {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        vary: "origin",
      };
      if (originCheck.ok && origin) {
        responseHeaders["access-control-allow-origin"] = origin;
        responseHeaders["access-control-allow-methods"] = "GET, OPTIONS";
        responseHeaders["access-control-allow-headers"] = "content-type";
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, responseHeaders);
        response.end();
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405, responseHeaders);
        response.end(
          JSON.stringify({
            ok: false,
            error: {
              code: "method_not_allowed",
              message: "Method not allowed.",
            },
          }),
        );
        return;
      }
      response.writeHead(200, responseHeaders);
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            websocketAllowed: originCheck.ok,
          },
        }),
      );
      return;
    }

    try {
      const handled =
        adminUiEnabled ||
        pathname === "/healthz" ||
        pathname === "/readyz" ||
        pathname === "/metrics"
          ? await args.adminRouter.handle(request, response)
          : false;
      if (handled) {
        return;
      }

      if (
        !adminUiEnabled &&
        (pathname === "/admin" ||
          pathname.startsWith("/admin/") ||
          pathname.startsWith("/api/admin/"))
      ) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            error: {
              code: "not_found",
              message: "Not found.",
            },
          }),
        );
        return;
      }

      const adminPanelHandled = await tryHandleAdminPanel(
        request,
        response,
        args.adminUiConfig,
      );
      if (adminPanelHandled) {
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ ok: true, service: "bili-syncplay-server" }),
      );
    } catch {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: false,
          error: {
            code: "internal_error",
            message: "Internal server error.",
          },
        }),
      );
    }
  };
}
