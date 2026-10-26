import assert from "node:assert/strict";
import test from "node:test";
import type { Announcement, ServerMessage } from "@bili-syncplay/protocol";
import { createServerMessageController } from "../src/background/server-message-controller";

test("server:announcement goes to the announcement controller, not the room session", async () => {
  const received: Array<Announcement | null> = [];
  const roomSessionMessages: ServerMessage["type"][] = [];
  const controller = createServerMessageController({
    log: () => {},
    shouldLogIncomingMessage: () => false,
    consumeRoomState: () => {},
    handleRoomSessionServerMessage: async (message) => {
      roomSessionMessages.push(message.type);
    },
    receiveAnnouncement: (announcement) => received.push(announcement),
    updateClockOffset: () => {},
    notifyAll: () => {},
  });
  const announcement: Announcement = {
    id: "a1",
    level: "info",
    message: "新版本",
    expiresInMs: 1_000,
  };

  await controller.handleServerMessage({
    type: "server:announcement",
    payload: { announcement },
  });
  await controller.handleServerMessage({
    type: "server:announcement",
    payload: { announcement: null },
  });

  assert.deepEqual(received, [announcement, null]);
  assert.deepEqual(roomSessionMessages, []);
});
