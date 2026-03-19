import type { IncomingMessage, ServerResponse } from "node:http";
import { tryHandleAdminPanel } from "../admin-panel.js";
import type { createSecurityPolicy } from "../security.js";
import type { AdminUiConfig } from "../types.js";

export function createHttpRequestHandler(args: {
  adminRouter: { handle: (request: IncomingMessage, response: ServerResponse) => Promise<boolean> };
  securityPolicy: ReturnType<typeof createSecurityPolicy>;
  adminUiConfig?: AdminUiConfig;
}) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
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

    void args.adminRouter.handle(request, response).then((handled: boolean) => {
      if (handled) {
        return;
      }
      void tryHandleAdminPanel(request, response, args.adminUiConfig).then(
        (adminPanelHandled) => {
          if (adminPanelHandled) {
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ ok: true, service: "bili-syncplay-server" }),
          );
        },
      );
    });
  };
}
