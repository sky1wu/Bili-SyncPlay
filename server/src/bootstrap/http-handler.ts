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
}) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const adminUiEnabled = args.adminUiConfig?.enabled !== false;
    if (pathname === "/api/connection-check") {
      const originHeader = request.headers.origin;
      const origin = typeof originHeader === "string" ? originHeader : null;
      const originCheck = args.securityPolicy.isOriginAllowed(origin);
      const corsHeaders = {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
        "cache-control": "no-store",
      };
      if (request.method === "OPTIONS") {
        response.writeHead(204, corsHeaders);
        response.end();
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405, corsHeaders);
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
      response.writeHead(200, corsHeaders);
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            websocketAllowed: originCheck.ok,
            reason: originCheck.ok ? null : originCheck.reason,
          },
        }),
      );
      return;
    }

    try {
      const handled =
        adminUiEnabled || pathname === "/healthz" || pathname === "/readyz"
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
