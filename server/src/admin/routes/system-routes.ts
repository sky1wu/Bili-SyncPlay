import { sendOk } from "../response.js";
import type { AdminRouteHandler } from "../router-types.js";

export const handleSystemRoutes: AdminRouteHandler = async ({
  request,
  response,
  pathname,
  options,
}) => {
  if (request.method === "GET" && pathname === "/metrics") {
    response.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    });
    response.end(await options.getMetrics());
    return true;
  }

  if (request.method === "GET" && pathname === "/healthz") {
    sendOk(response, {
      status: "healthy",
      service: options.serviceName,
      time: new Date((options.now ?? Date.now)()).toISOString(),
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/readyz") {
    const roomStoreReady = await options.roomStoreReady();
    const status = roomStoreReady ? "ready" : "not_ready";
    sendOk(
      response,
      {
        status,
        checks: {
          httpServer: "ok",
          roomStore: roomStoreReady ? "ok" : "error",
          redis: roomStoreReady ? "ok" : "error",
        },
      },
      roomStoreReady ? 200 : 503,
    );
    return true;
  }

  return false;
};
