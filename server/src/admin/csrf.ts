import type { IncomingMessage, ServerResponse } from "node:http";
import { CROSS_ORIGIN_REJECTED_MESSAGE } from "../messages.js";
import { sendError } from "./response.js";

export type AdminWriteOriginPolicy = {
  allowedOrigins: readonly string[];
};

type OriginCheckResult =
  { ok: true } | { ok: false; reason: "origin_missing" | "origin_not_allowed" };

function getRequestScheme(request: IncomingMessage): string {
  const forwardedProto = request.headers["x-forwarded-proto"];
  if (typeof forwardedProto === "string" && forwardedProto.length > 0) {
    return forwardedProto.split(",")[0]?.trim() || "http";
  }
  const socket = request.socket as { encrypted?: boolean };
  return socket.encrypted ? "https" : "http";
}

function sameOriginFromRequest(request: IncomingMessage): string | null {
  const hostHeader = request.headers.host;
  if (typeof hostHeader !== "string" || hostHeader.length === 0) {
    return null;
  }
  return `${getRequestScheme(request)}://${hostHeader}`;
}

export function evaluateAdminWriteOrigin(
  request: IncomingMessage,
  policy: AdminWriteOriginPolicy,
): OriginCheckResult {
  const originHeader = request.headers.origin;
  const origin = typeof originHeader === "string" ? originHeader : null;
  if (!origin) {
    return { ok: false, reason: "origin_missing" };
  }

  const sameOrigin = sameOriginFromRequest(request);
  if (sameOrigin && origin === sameOrigin) {
    return { ok: true };
  }

  if (policy.allowedOrigins.includes(origin)) {
    return { ok: true };
  }

  return { ok: false, reason: "origin_not_allowed" };
}

export function setAdminCorsResponseHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  policy: AdminWriteOriginPolicy,
): void {
  response.setHeader("vary", "origin");

  const result = evaluateAdminWriteOrigin(request, policy);
  const origin = request.headers.origin;
  if (result.ok && typeof origin === "string") {
    response.setHeader("access-control-allow-origin", origin);
  }
}

export function requireAdminWriteOrigin(
  request: IncomingMessage,
  response: ServerResponse,
  policy: AdminWriteOriginPolicy,
): boolean {
  const result = evaluateAdminWriteOrigin(request, policy);
  if (result.ok) {
    return true;
  }
  sendError(
    response,
    403,
    `csrf_${result.reason}`,
    CROSS_ORIGIN_REJECTED_MESSAGE,
  );
  return false;
}
