import { readJsonBody } from "../request.js";
import { sendOk } from "../response.js";
import type { AdminRouteHandler } from "../router-types.js";
import { requireNonEmptyString, requireSegment } from "./validation.js";

export const handleActionRoutes: AdminRouteHandler = async ({
  request,
  response,
  segments,
  helpers,
  options,
}) => {
  if (
    request.method === "POST" &&
    segments.length === 3 &&
    segments[0] === "api" &&
    segments[1] === "admin" &&
    segments[2] === "ip-blocks"
  ) {
    if (!helpers.requireWriteOrigin(request, response)) {
      return true;
    }
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    if (!helpers.requireRole(session, "operator", response)) {
      return true;
    }
    const body = await readJsonBody<{ ip?: string; reason?: string }>(request);
    sendOk(
      response,
      await options.blockIp(session, body.ip ?? "", body.reason),
    );
    return true;
  }

  if (
    request.method === "DELETE" &&
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "admin" &&
    segments[2] === "ip-blocks"
  ) {
    if (!helpers.requireWriteOrigin(request, response)) {
      return true;
    }
    const ip = decodeURIComponent(
      requireNonEmptyString(requireSegment(segments, 3, "ip"), "ip"),
    );
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    if (!helpers.requireRole(session, "operator", response)) {
      return true;
    }
    const body = await readJsonBody<{ reason?: string }>(request);
    sendOk(response, await options.unblockIp(session, ip, body.reason));
    return true;
  }

  if (
    request.method === "POST" &&
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "admin" &&
    segments[2] === "rooms" &&
    segments[4] === "close"
  ) {
    if (!helpers.requireWriteOrigin(request, response)) {
      return true;
    }
    const roomCode = requireNonEmptyString(
      requireSegment(segments, 3, "roomCode"),
      "roomCode",
    );
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    if (!helpers.requireRole(session, "operator", response)) {
      return true;
    }
    const body = await readJsonBody<{ reason?: string }>(request);
    sendOk(response, await options.closeRoom(session, roomCode, body.reason));
    return true;
  }

  if (
    request.method === "POST" &&
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "admin" &&
    segments[2] === "rooms" &&
    segments[4] === "expire"
  ) {
    if (!helpers.requireWriteOrigin(request, response)) {
      return true;
    }
    const roomCode = requireNonEmptyString(
      requireSegment(segments, 3, "roomCode"),
      "roomCode",
    );
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    if (!helpers.requireRole(session, "operator", response)) {
      return true;
    }
    const body = await readJsonBody<{ reason?: string }>(request);
    sendOk(response, await options.expireRoom(session, roomCode, body.reason));
    return true;
  }

  if (
    request.method === "POST" &&
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "admin" &&
    segments[2] === "rooms" &&
    segments[4] === "clear-video"
  ) {
    if (!helpers.requireWriteOrigin(request, response)) {
      return true;
    }
    const roomCode = requireNonEmptyString(
      requireSegment(segments, 3, "roomCode"),
      "roomCode",
    );
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    if (!helpers.requireRole(session, "operator", response)) {
      return true;
    }
    const body = await readJsonBody<{ reason?: string }>(request);
    sendOk(
      response,
      await options.clearRoomVideo(session, roomCode, body.reason),
    );
    return true;
  }

  if (
    request.method === "POST" &&
    segments.length === 7 &&
    segments[0] === "api" &&
    segments[1] === "admin" &&
    segments[2] === "rooms" &&
    segments[4] === "members" &&
    segments[6] === "kick"
  ) {
    if (!helpers.requireWriteOrigin(request, response)) {
      return true;
    }
    const roomCode = requireNonEmptyString(
      requireSegment(segments, 3, "roomCode"),
      "roomCode",
    );
    const memberId = requireNonEmptyString(
      requireSegment(segments, 5, "memberId"),
      "memberId",
    );
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    if (!helpers.requireRole(session, "operator", response)) {
      return true;
    }
    const body = await readJsonBody<{ reason?: string }>(request);
    sendOk(
      response,
      await options.kickMember(session, roomCode, memberId, body.reason),
    );
    return true;
  }

  if (
    request.method === "POST" &&
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "admin" &&
    segments[2] === "sessions" &&
    segments[4] === "disconnect"
  ) {
    if (!helpers.requireWriteOrigin(request, response)) {
      return true;
    }
    const targetSessionId = requireNonEmptyString(
      requireSegment(segments, 3, "sessionId"),
      "sessionId",
    );
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    if (!helpers.requireRole(session, "operator", response)) {
      return true;
    }
    const body = await readJsonBody<{ reason?: string }>(request);
    sendOk(
      response,
      await options.disconnectSession(session, targetSessionId, body.reason),
    );
    return true;
  }

  return false;
};
