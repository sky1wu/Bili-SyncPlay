import { DEMO_TOKEN } from "./state.js";
import { includesText, paginate } from "./render-utils.js";

export function demoAdminSession() {
  return { id: "admin-demo", username: "demo-admin", role: "admin" };
}

export function createDemoData() {
  const now = Date.now();
  const rooms = [
    {
      roomCode: "ROOM8A",
      instanceId: "instance-1",
      isActive: true,
      ownerMemberId: "member-alice",
      ownerDisplayName: "Alice",
      memberCount: 4,
      sharedVideo: {
        title: "【番剧】第 12 话同步播放",
        videoId: "BV1demo8A",
        url: "https://www.bilibili.com/video/BV1demo8A",
      },
      playback: { paused: false, currentTime: 428.4, playbackRate: 1 },
      createdAt: now - 1000 * 60 * 86,
      lastActiveAt: now - 1000 * 18,
      expiresAt: now + 1000 * 60 * 42,
    },
    {
      roomCode: "ROOM2B",
      instanceId: "instance-1",
      isActive: true,
      ownerMemberId: "member-echo",
      ownerDisplayName: "Echo",
      memberCount: 2,
      sharedVideo: {
        title: "音乐现场回放",
        videoId: "BV1demo2B",
        url: "https://www.bilibili.com/video/BV1demo2B",
      },
      playback: { paused: true, currentTime: 95.2, playbackRate: 1.25 },
      createdAt: now - 1000 * 60 * 210,
      lastActiveAt: now - 1000 * 60 * 3,
      expiresAt: now + 1000 * 60 * 18,
    },
    {
      roomCode: "ARCH9C",
      instanceId: "instance-2",
      isActive: false,
      ownerMemberId: "member-archived-owner",
      ownerDisplayName: null,
      memberCount: 0,
      sharedVideo: null,
      playback: null,
      createdAt: now - 1000 * 60 * 60 * 8,
      lastActiveAt: now - 1000 * 60 * 52,
      expiresAt: now - 1000 * 60 * 10,
    },
  ];

  const roomMembers = {
    ROOM8A: [
      {
        displayName: "Alice",
        memberId: "member-alice",
        sessionId: "sess-alice-01",
        joinedAt: now - 1000 * 60 * 28,
        remoteAddress: "203.0.113.10",
        origin: "chrome-extension://demo-extension",
      },
      {
        displayName: "Bob",
        memberId: "member-bob",
        sessionId: "sess-bob-02",
        joinedAt: now - 1000 * 60 * 18,
        remoteAddress: "198.51.100.42",
        origin: "https://www.bilibili.com",
      },
      {
        displayName: "Carol",
        memberId: "member-carol",
        sessionId: "sess-carol-03",
        joinedAt: now - 1000 * 60 * 11,
        remoteAddress: "198.51.100.77",
        origin: "http://localhost:5173",
      },
      {
        displayName: "Dave",
        memberId: "member-dave",
        sessionId: "sess-dave-04",
        joinedAt: now - 1000 * 60 * 4,
        remoteAddress: null,
        origin: "",
      },
    ],
    ROOM2B: [
      {
        displayName: "Echo",
        memberId: "member-echo",
        sessionId: "sess-echo-01",
        joinedAt: now - 1000 * 60 * 14,
        remoteAddress: "192.0.2.15",
        origin: "https://www.bilibili.com",
      },
      {
        displayName: "Foxtrot",
        memberId: "member-foxtrot",
        sessionId: "sess-foxtrot-02",
        joinedAt: now - 1000 * 60 * 6,
        remoteAddress: "192.0.2.18",
        origin: "chrome-extension://demo-extension",
      },
    ],
    ARCH9C: [],
  };

  const events = [
    {
      timestamp: now - 1000 * 15,
      event: "playback_synced",
      roomCode: "ROOM8A",
      sessionId: "sess-alice-01",
      remoteAddress: "203.0.113.10",
      origin: "chrome-extension://demo-extension",
      result: "ok",
      details: { currentTime: 428.4, playbackRate: 1 },
    },
    {
      timestamp: now - 1000 * 42,
      event: "room_joined",
      roomCode: "ROOM8A",
      sessionId: "sess-dave-04",
      remoteAddress: null,
      origin: "",
      result: "ok",
      details: { memberId: "member-dave" },
    },
    {
      timestamp: now - 1000 * 60 * 3,
      event: "room_joined",
      roomCode: "ROOM2B",
      sessionId: "sess-foxtrot-02",
      remoteAddress: "192.0.2.18",
      origin: "chrome-extension://demo-extension",
      result: "ok",
      details: { memberId: "member-foxtrot" },
    },
    {
      timestamp: now - 1000 * 60 * 7,
      event: "room_idle",
      roomCode: "ARCH9C",
      sessionId: "",
      remoteAddress: null,
      origin: "",
      result: "idle",
      details: { memberCount: 0 },
    },
    {
      timestamp: now - 1000 * 60 * 12,
      event: "admin_room_video_cleared",
      roomCode: "ROOM2B",
      sessionId: "",
      remoteAddress: null,
      origin: "",
      result: "success",
      details: { actor: "demo-admin" },
    },
  ];

  const auditLogs = [
    {
      timestamp: now - 1000 * 60 * 5,
      actor: { username: "demo-admin", role: "admin" },
      action: "clear_video",
      targetType: "room",
      targetId: "ROOM2B",
      result: "success",
      reason: "同步下一首视频前清空当前状态",
      instanceId: "instance-1",
      request: { reason: "同步下一首视频前清空当前状态" },
    },
    {
      timestamp: now - 1000 * 60 * 16,
      actor: { username: "demo-admin", role: "admin" },
      action: "kick_member",
      targetType: "member",
      targetId: "member-carol",
      result: "success",
      reason: "播放源异常，要求重连",
      instanceId: "instance-1",
      request: { roomCode: "ROOM8A", memberId: "member-carol" },
    },
    {
      timestamp: now - 1000 * 60 * 34,
      actor: { username: "demo-admin", role: "admin" },
      action: "disconnect_session",
      targetType: "session",
      targetId: "sess-echo-01",
      result: "success",
      reason: "演示用断开",
      instanceId: "instance-1",
      request: { sessionId: "sess-echo-01" },
    },
  ];

  return { now, rooms, roomMembers, events, auditLogs };
}

export function createMockApiRequest() {
  const demoData = createDemoData();

  return async function mockApiRequest(path) {
    const url = new URL(path, location.origin);
    const pathname = url.pathname;
    const params = url.searchParams;

    if (pathname === "/api/admin/auth/login") {
      return {
        token: DEMO_TOKEN,
        expiresAt: demoData.now + 12 * 60 * 60 * 1000,
        admin: demoAdminSession(),
      };
    }
    if (pathname === "/api/admin/auth/logout") {
      return { ok: true };
    }
    if (pathname === "/api/admin/me") {
      return demoAdminSession();
    }
    if (pathname === "/healthz") {
      return { status: "healthy" };
    }
    if (pathname === "/readyz") {
      return { status: "ready", checks: { roomStore: "ok", redis: "ok" } };
    }
    if (pathname === "/api/admin/overview") {
      return {
        service: {
          name: "bili-syncplay-server",
          version: "0.7.0-demo",
          instanceId: "instance-1",
          startedAt: demoData.now - 1000 * 60 * 60 * 4,
          uptimeMs: 1000 * 60 * 60 * 4 + 1000 * 60 * 22,
        },
        storage: { provider: "redis", redisConnected: true },
        runtime: {
          connectionCount: 6,
          activeRoomCount: 2,
          activeMemberCount: 6,
        },
        rooms: { totalNonExpired: 2, idle: 1 },
        events: {
          lastMinute: {
            room_created: 1,
            room_joined: 2,
            rate_limited: 0,
            ws_connection_rejected: 0,
            error: 0,
          },
          totals: {
            room_created: 18,
            room_joined: 143,
            ws_connection_rejected: 4,
            rate_limited: 9,
          },
        },
      };
    }
    if (pathname === "/api/admin/rooms") {
      let items = demoData.rooms.slice();
      const keyword = params.get("keyword") || "";
      const status = params.get("status") || "all";
      const includeExpired = params.get("includeExpired") === "true";
      const sortBy = params.get("sortBy") || "lastActiveAt";
      const sortOrder = params.get("sortOrder") || "desc";
      const page = params.get("page") || "1";
      const pageSize = params.get("pageSize") || "20";

      if (keyword) {
        items = items.filter(
          (item) =>
            includesText(item.roomCode, keyword) ||
            includesText(item.sharedVideo?.title, keyword),
        );
      }
      if (status === "active") {
        items = items.filter((item) => item.isActive);
      } else if (status === "idle") {
        items = items.filter((item) => !item.isActive);
      }
      if (!includeExpired) {
        items = items.filter((item) => item.expiresAt > demoData.now);
      }
      items.sort((a, b) => {
        const delta = Number(a[sortBy] || 0) - Number(b[sortBy] || 0);
        return sortOrder === "asc" ? delta : -delta;
      });
      const paged = paginate(items, page, pageSize);
      return { items: paged.items, pagination: paged.pagination };
    }
    if (
      pathname.startsWith("/api/admin/rooms/") &&
      !pathname.endsWith("/close") &&
      !pathname.endsWith("/expire") &&
      !pathname.endsWith("/clear-video")
    ) {
      const roomCode = decodeURIComponent(pathname.split("/")[4] || "");
      const room = demoData.rooms.find((item) => item.roomCode === roomCode);
      if (!room) {
        throw { code: "room_not_found", message: "房间不存在。" };
      }
      return {
        instanceId: room.instanceId,
        room,
        members: demoData.roomMembers[roomCode] || [],
        recentEvents: demoData.events
          .filter((event) => event.roomCode === roomCode)
          .slice(0, 20),
      };
    }
    if (pathname === "/api/admin/events") {
      let items = demoData.events.slice();
      const filters = [
        "event",
        "roomCode",
        "sessionId",
        "remoteAddress",
        "origin",
        "result",
      ];
      for (const key of filters) {
        const value = params.get(key);
        if (value) {
          items = items.filter((item) => includesText(item[key], value));
        }
      }
      items.sort((a, b) => b.timestamp - a.timestamp);
      const paged = paginate(
        items,
        params.get("page") || "1",
        params.get("pageSize") || "20",
      );
      return { items: paged.items, total: paged.total };
    }
    if (pathname === "/api/admin/audit-logs") {
      let items = demoData.auditLogs.slice();
      const actor = params.get("actor");
      const action = params.get("action");
      const targetType = params.get("targetType");
      const targetId = params.get("targetId");
      const result = params.get("result");
      if (actor) {
        items = items.filter((item) =>
          includesText(item.actor.username, actor),
        );
      }
      if (action) {
        items = items.filter((item) => includesText(item.action, action));
      }
      if (targetType) {
        items = items.filter((item) =>
          includesText(item.targetType, targetType),
        );
      }
      if (targetId) {
        items = items.filter((item) => includesText(item.targetId, targetId));
      }
      if (result) {
        items = items.filter((item) => includesText(item.result, result));
      }
      items.sort((a, b) => b.timestamp - a.timestamp);
      const paged = paginate(
        items,
        params.get("page") || "1",
        params.get("pageSize") || "20",
      );
      return { items: paged.items, total: paged.total };
    }
    if (pathname === "/api/admin/config") {
      return {
        instanceId: "instance-1",
        persistence: {
          provider: "redis",
          emptyRoomTtlMs: 1800000,
          roomCleanupIntervalMs: 60000,
          redisConfigured: true,
        },
        admin: {
          configured: true,
          username: "demo-admin",
          role: "admin",
          sessionTtlMs: 43200000,
        },
        security: {
          allowedOrigins: [
            "https://www.bilibili.com",
            "chrome-extension://demo-extension",
          ],
          allowMissingOriginInDev: false,
          trustedProxyAddresses: ["127.0.0.1", "10.0.0.10"],
          maxConnectionsPerIp: 24,
          connectionAttemptsPerMinute: 120,
          maxMembersPerRoom: 16,
          maxMessageBytes: 8192,
          invalidMessageCloseThreshold: 3,
          rateLimits: {
            perIp: { windowMs: 60000, max: 120 },
            perRoom: { windowMs: 10000, max: 30 },
          },
        },
      };
    }
    if (
      pathname.includes("/close") ||
      pathname.includes("/expire") ||
      pathname.includes("/clear-video") ||
      pathname.includes("/kick") ||
      pathname.includes("/disconnect")
    ) {
      return { ok: true };
    }

    throw {
      code: "request_failed",
      message: `未实现的 demo 接口：${pathname}`,
    };
  };
}
