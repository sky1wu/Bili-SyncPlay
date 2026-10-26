import assert from "node:assert/strict";
import test from "node:test";
import type { Announcement, ServerMessage } from "@bili-syncplay/protocol";
import { createServerMessageController } from "../src/background/server-message-controller";

test("server:announcement goes to the announcement controller, not the room session", async () => {
  const received: Array<[Announcement | null, string]> = [];
  const roomSessionMessages: ServerMessage["type"][] = [];
  const controller = createServerMessageController({
    log: () => {},
    shouldLogIncomingMessage: () => false,
    consumeRoomState: () => {},
    handleRoomSessionServerMessage: async (message) => {
      roomSessionMessages.push(message.type);
    },
    receiveAnnouncement: (announcement, sourceServerUrl) =>
      received.push([announcement, sourceServerUrl]),
    updateClockOffset: () => {},
    notifyAll: () => {},
  });
  const announcement: Announcement = {
    id: "a1",
    level: "info",
    message: "新版本",
    expiresInMs: 1_000,
  };

  await controller.handleServerMessage(
    {
      type: "server:announcement",
      payload: { announcement },
    },
    "ws://a.example",
  );
  await controller.handleServerMessage(
    {
      type: "server:announcement",
      payload: { announcement: null },
    },
    "ws://a.example",
  );

  assert.deepEqual(received, [
    [announcement, "ws://a.example"],
    [null, "ws://a.example"],
  ]);
  assert.deepEqual(roomSessionMessages, []);
});
