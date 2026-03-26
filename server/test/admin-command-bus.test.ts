import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemoryAdminCommandBus,
  createNoopAdminCommandBus,
} from "../src/admin-command-bus.js";

test("in-memory admin command bus routes commands to the subscribed instance", async () => {
  const bus = createInMemoryAdminCommandBus(() => 2_000);
  const unsubscribe = await bus.subscribe("node-a", async (command) => ({
    requestId: command.requestId,
    targetInstanceId: command.targetInstanceId,
    executorInstanceId: "node-a",
    status: "ok",
    roomCode: command.kind === "kick_member" ? command.roomCode : null,
    memberId: command.kind === "kick_member" ? command.memberId : undefined,
    sessionId:
      command.kind === "disconnect_session" ? command.sessionId : undefined,
    completedAt: 2_000,
  }));

  try {
    const result = await bus.request({
      kind: "kick_member",
      requestId: "req-1",
      targetInstanceId: "node-a",
      roomCode: "ROOM01",
      memberId: "member-a",
      requestedAt: 1_000,
    });

    assert.deepEqual(result, {
      requestId: "req-1",
      targetInstanceId: "node-a",
      executorInstanceId: "node-a",
      status: "ok",
      roomCode: "ROOM01",
      memberId: "member-a",
      sessionId: undefined,
      completedAt: 2_000,
    });
  } finally {
    await unsubscribe();
  }
});

test("in-memory admin command bus reports stale target when no subscriber exists", async () => {
  const bus = createInMemoryAdminCommandBus(() => 3_000);
  const result = await bus.request({
    kind: "disconnect_session",
    requestId: "req-2",
    targetInstanceId: "node-b",
    sessionId: "session-a",
    requestedAt: 2_000,
  });

  assert.deepEqual(result, {
    requestId: "req-2",
    targetInstanceId: "node-b",
    executorInstanceId: "node-b",
    status: "stale_target",
    code: "stale_target",
    message: "Target instance is unavailable.",
    completedAt: 3_000,
  });
});

test("noop admin command bus always reports disabled stale target", async () => {
  const bus = createNoopAdminCommandBus();
  const result = await bus.request({
    kind: "disconnect_session",
    requestId: "req-3",
    targetInstanceId: "node-c",
    sessionId: "session-b",
    requestedAt: 2_500,
  });

  assert.equal(result.status, "stale_target");
  assert.equal(result.code, "command_bus_disabled");
});
