import type { IncomingMessage, ServerResponse } from "node:http";

export function createMetricsRequestHandler(args: {
  getMetrics: () => Promise<string> | string;
}) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/metrics") {
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
    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "application/json" });
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
    try {
      const body = await args.getMetrics();
      response.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
      });
      response.end(body);
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
