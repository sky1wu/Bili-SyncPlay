import { readJsonBody } from "../request.js";
import { sendOk } from "../response.js";
import type { PublishAnnouncementInput } from "../announcement-service.js";
import type { AdminRouteHandler } from "../router-types.js";

/**
 * `/api/admin/announcement` — read (viewer), publish and withdraw (operator).
 *
 * Withdraw is a POST to its own path rather than a DELETE because the admin
 * CORS policy only allows GET and POST, like every other admin action.
 */
export const handleAnnouncementRoutes: AdminRouteHandler = async ({
  request,
  response,
  segments,
  helpers,
  options,
}) => {
  if (
    segments.length < 3 ||
    segments[0] !== "api" ||
    segments[1] !== "admin" ||
    segments[2] !== "announcement"
  ) {
    return false;
  }

  if (request.method === "GET" && segments.length === 3) {
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    if (!helpers.requireRole(session, "viewer", response)) {
      return true;
    }
    sendOk(response, await options.getAnnouncement());
    return true;
  }

  if (request.method === "POST" && segments.length === 3) {
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
    const body = await readJsonBody<PublishAnnouncementInput>(request);
    sendOk(response, await options.publishAnnouncement(session, body));
    return true;
  }

  if (
    request.method === "POST" &&
    segments.length === 4 &&
    segments[3] === "withdraw"
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
    const body = await readJsonBody<{ reason?: unknown }>(request);
    sendOk(response, await options.withdrawAnnouncement(session, body.reason));
    return true;
  }

  return false;
};
