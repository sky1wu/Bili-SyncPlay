import { readJsonBody } from "../request.js";
import { sendOk } from "../response.js";
import type { AdminRouteHandler } from "../router-types.js";

export const handleActionRoutes: AdminRouteHandler = async ({
  request,
  response,
  segments,
  helpers,
  options,
}) => {
  if (
    request.method === "POST" &&
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "admin" &&
    segments[2] === "rooms" &&
    segments[4] === "close"
  ) {
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    if (!helpers.requireRole(session, "operator", response)) {
      return true;
    }
    const body = await readJsonBody<{ reason?: string }>(request);
    sendOk(response, await options.closeRoom(session, segments[3] ?? "", body.reason));
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
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    if (!helpers.requireRole(session, "operator", response)) {
      return true;
    }
    const body = await readJsonBody<{ reason?: string }>(request);
    sendOk(response, await options.expireRoom(session, segments[3] ?? "", body.reason));
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
      await options.clearRoomVideo(session, segments[3] ?? "", body.reason),
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
      await options.kickMember(
        session,
        segments[3] ?? "",
        segments[5] ?? "",
        body.reason,
      ),
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
      await options.disconnectSession(session, segments[3] ?? "", body.reason),
    );
    return true;
  }

  return false;
};
