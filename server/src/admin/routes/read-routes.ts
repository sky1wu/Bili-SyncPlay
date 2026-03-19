import { ROOM_NOT_FOUND_MESSAGE } from "../../messages.js";
import { getQueryParams, parsePositiveInt } from "../request.js";
import { sendError, sendOk } from "../response.js";
import type { AdminRouteHandler } from "../router-types.js";
import type { AuditLogQuery, EventListQuery, RoomListQuery } from "../types.js";

export const handleReadRoutes: AdminRouteHandler = async ({
  request,
  response,
  pathname,
  segments,
  helpers,
  options,
}) => {
  if (request.method === "GET" && pathname === "/api/admin/overview") {
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    sendOk(response, await options.getOverview());
    return true;
  }

  if (request.method === "GET" && pathname === "/api/admin/config") {
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    sendOk(response, options.getConfigSummary());
    return true;
  }

  if (request.method === "GET" && pathname === "/api/admin/rooms") {
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    const queryParams = getQueryParams(request);
    const status = queryParams.get("status");
    const query: RoomListQuery = {
      status:
        status === "active" || status === "idle" || status === "all"
          ? status
          : "all",
      keyword: queryParams.get("keyword") ?? undefined,
      page: parsePositiveInt(queryParams.get("page"), 1),
      pageSize: Math.min(parsePositiveInt(queryParams.get("pageSize"), 20), 100),
      sortBy:
        queryParams.get("sortBy") === "createdAt"
          ? "createdAt"
          : "lastActiveAt",
      sortOrder: queryParams.get("sortOrder") === "asc" ? "asc" : "desc",
      includeExpired: queryParams.get("includeExpired") === "true",
    };
    sendOk(response, await options.listRooms(query));
    return true;
  }

  if (
    request.method === "GET" &&
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "admin" &&
    segments[2] === "rooms"
  ) {
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    const detail = await options.getRoomDetail(segments[3] ?? "");
    if (!detail) {
      sendError(response, 404, "room_not_found", ROOM_NOT_FOUND_MESSAGE);
      return true;
    }
    sendOk(response, detail);
    return true;
  }

  if (request.method === "GET" && pathname === "/api/admin/events") {
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    const queryParams = getQueryParams(request);
    const query: EventListQuery = {
      event: queryParams.get("event") ?? undefined,
      roomCode: queryParams.get("roomCode") ?? undefined,
      sessionId: queryParams.get("sessionId") ?? undefined,
      remoteAddress: queryParams.get("remoteAddress") ?? undefined,
      origin: queryParams.get("origin") ?? undefined,
      result: queryParams.get("result") ?? undefined,
      from: queryParams.get("from") ? Number(queryParams.get("from")) : undefined,
      to: queryParams.get("to") ? Number(queryParams.get("to")) : undefined,
      page: parsePositiveInt(queryParams.get("page"), 1),
      pageSize: Math.min(parsePositiveInt(queryParams.get("pageSize"), 20), 100),
    };
    sendOk(response, {
      ...options.eventStore.query(query),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
      },
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/admin/audit-logs") {
    const session = await helpers.requireAdmin(request, response);
    if (!session) {
      return true;
    }
    const queryParams = getQueryParams(request);
    const targetTypeValue = queryParams.get("targetType");
    const resultValue = queryParams.get("result");
    const query: AuditLogQuery = {
      actor: queryParams.get("actor") ?? undefined,
      action: queryParams.get("action") ?? undefined,
      targetId: queryParams.get("targetId") ?? undefined,
      targetType:
        targetTypeValue === "room" ||
        targetTypeValue === "session" ||
        targetTypeValue === "member" ||
        targetTypeValue === "config" ||
        targetTypeValue === "block"
          ? targetTypeValue
          : undefined,
      result:
        resultValue === "ok" ||
        resultValue === "rejected" ||
        resultValue === "error"
          ? resultValue
          : undefined,
      from: queryParams.get("from") ? Number(queryParams.get("from")) : undefined,
      to: queryParams.get("to") ? Number(queryParams.get("to")) : undefined,
      page: parsePositiveInt(queryParams.get("page"), 1),
      pageSize: Math.min(parsePositiveInt(queryParams.get("pageSize"), 20), 100),
    };
    sendOk(response, {
      ...options.listAuditLogs(query),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
      },
    });
    return true;
  }

  return false;
};
