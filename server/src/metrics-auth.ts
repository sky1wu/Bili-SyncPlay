import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Guards `/metrics` scrapes with an optional static bearer token
 * (`METRICS_TOKEN`). Health probes (`/healthz`, `/readyz`) intentionally stay
 * open, so this must only be applied to the metrics route itself.
 */
export function isMetricsRequestAuthorized(
  request: Pick<IncomingMessage, "headers">,
  metricsToken: string | undefined,
): boolean {
  if (metricsToken === undefined || metricsToken.length === 0) {
    // Token not configured — preserve the historical open-endpoint behavior.
    return true;
  }
  const header = request.headers.authorization;
  if (typeof header !== "string") {
    return false;
  }
  const presentedToken = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  if (presentedToken === undefined) {
    return false;
  }
  // Hashing both sides collapses length differences so timingSafeEqual is
  // applicable and the comparison stays constant-time for any input.
  return timingSafeEqual(sha256(presentedToken), sha256(metricsToken));
}

export function sendMetricsUnauthorized(response: ServerResponse): void {
  response.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": 'Bearer realm="metrics"',
  });
  response.end(
    JSON.stringify({
      ok: false,
      error: {
        code: "unauthorized",
        message: "Unauthorized.",
      },
    }),
  );
}
