import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocket } from "ws";
import {
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
} from "../src/app.js";
import {
  createPersistedRoom,
  createInMemoryRoomStore,
} from "../src/room-store.js";
import { createRoomService } from "../src/room-service.js";
import type { RuntimeStore } from "../src/runtime-store.js";
import type { LogEvent, Session } from "../src/types.js";

function createSession(
  id: string,
  roomCode: string,
  displayName: string,
  memberId = id,
): Session {
  return {
    id,
    connectionState: "attached",
    socket: {} as WebSocket,
    instanceId: `${id}-node`,
    remoteAddress: "127.0.0.1",
    origin: "chrome-extension://allowed-extension",
    roomCode,
    memberId,
    displayName,
    memberToken: `token-${id}`,
    joinedAt: 1_000,
    invalidMessageCount: 0,
    rateLimitState: {
      roomCreate: { windowStart: 0, count: 0 },
      roomJoin: { windowStart: 0, count: 0 },
      videoShare: { windowStart: 0, count: 0 },
      playbackUpdate: { tokens: 0, lastRefillAt: 0 },
      syncRequest: { windowStart: 0, count: 0 },
      syncPing: { tokens: 0, lastRefillAt: 0 },
    },
  };
}

test("room state query uses cluster sessions instead of only local active members", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const room = createPersistedRoom({
    code: "ROOM01",
    joinToken: "join-token-1",
    createdAt: 1_000,
  });
  await roomStore.saveRoom(room);

  const localOwner = createSession("owner", "ROOM01", "Alice");
  const remoteJoiner = createSession("joiner", "ROOM01", "Bob");
  const runtimeStore = {
    getRoom() {
      return {
        code: "ROOM01",
        members: new Map([[localOwner.memberId ?? localOwner.id, localOwner]]),
        memberTokens: new Map([
          [localOwner.memberId ?? localOwner.id, "token-owner"],
        ]),
      };
    },
    async listClusterSessionsByRoom() {
      return [localOwner, remoteJoiner];
    },
    deleteRoom() {},
  } as Pick<
    RuntimeStore,
    "getRoom" | "listClusterSessionsByRoom" | "deleteRoom"
  >;

  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    runtimeStore: runtimeStore as RuntimeStore,
    generateToken: () => "generated-token",
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
  });

  const state = await service.getRoomStateByCode("ROOM01");
  assert.deepEqual(state?.members, [
    { id: "owner", name: "Alice" },
    { id: "joiner", name: "Bob" },
  ]);
});
