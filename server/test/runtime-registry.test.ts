import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeRegistry } from "../src/admin/runtime-registry.js";
import type { Session } from "../src/types.js";

function createSession(id: string): Session {
  return {
    id,
    socket: {
      readyState: 1,
      OPEN: 1,
      send() {},
      close() {},
      terminate() {}
    } as Session["socket"],
    remoteAddress: null,
    origin: null,
    roomCode: null,
    memberId: null,
    memberToken: null,
    displayName: id,
    joinedAt: null,
    invalidMessageCount: 0,
    rateLimitState: {
      roomCreate: { windowStart: 0, count: 0 },
      roomJoin: { windowStart: 0, count: 0 },
      videoShare: { windowStart: 0, count: 0 },
      playbackUpdate: { tokens: 0, lastRefillAt: 0 },
      syncRequest: { windowStart: 0, count: 0 },
      syncPing: { tokens: 0, lastRefillAt: 0 }
    }
  };
}

test("runtime registry removes stale room membership when session roomCode was cleared before disconnect", () => {
  const registry = createRuntimeRegistry(() => 1_000);
  const session = createSession("session-1");

  registry.registerSession(session);
  registry.markSessionJoinedRoom(session.id, "ROOM01");

  session.roomCode = null;
  registry.unregisterSession(session.id);

  assert.equal(registry.getConnectionCount(), 0);
  assert.equal(registry.getActiveRoomCount(), 0);
  assert.equal(registry.getActiveMemberCount(), 0);
  assert.deepEqual(Array.from(registry.getActiveRoomCodes()), []);
});
