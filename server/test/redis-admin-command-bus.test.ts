import assert from "node:assert/strict";
import test from "node:test";
import { createRedisAdminCommandBus } from "../src/redis-admin-command-bus.js";
import { createFakeRedisPubSubClient } from "./redis-pubsub-test-helpers.js";

const REDIS_URL = process.env.REDIS_URL;

function createChannelPrefix(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2)}:`;
}

test("redis admin command bus closes and reports both clients when QUIT never answers", async () => {
  const publisher = createFakeRedisPubSubClient(
    () => new Promise(() => undefined),
  );
  const subscriber = createFakeRedisPubSubClient(
    () => new Promise(() => undefined),
  );
  const unfinished: Array<{
    role: string;
    quitOutcome: string;
    budgetMs: number;
  }> = [];
  const bus = await createRedisAdminCommandBus("redis://unused", {
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
    closeQuitTimeoutMs: 20,
    onCloseUnfinished: (info) => {
      unfinished.push(info);
    },
  });

  const startedAt = Date.now();
  await bus.close();
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(publisher.disconnectCalls(), 1);
  assert.equal(subscriber.disconnectCalls(), 1);
  assert.deepEqual(
    unfinished.sort((left, right) => left.role.localeCompare(right.role)),
    [
      { role: "publisher", quitOutcome: "timed_out", budgetMs: 20 },
      { role: "subscriber", quitOutcome: "timed_out", budgetMs: 20 },
    ],
  );
});

test("redis admin command bus routes commands to the target instance and returns results", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const commandChannelPrefix = createChannelPrefix("bsp:test:admin-command");
  const resultChannelPrefix = createChannelPrefix(
    "bsp:test:admin-command-result",
  );
  const busA = await createRedisAdminCommandBus(REDIS_URL, {
    commandChannelPrefix,
    resultChannelPrefix,
  });
  const busB = await createRedisAdminCommandBus(REDIS_URL, {
    commandChannelPrefix,
    resultChannelPrefix,
  });

  const unsubscribe = await busB.subscribe("node-b", async (command) => ({
    requestId: command.requestId,
    targetInstanceId: command.targetInstanceId,
    executorInstanceId: "node-b",
    status: "ok",
    roomCode: command.kind === "kick_member" ? command.roomCode : null,
    memberId: command.kind === "kick_member" ? command.memberId : undefined,
    sessionId:
      command.kind === "disconnect_session" ? command.sessionId : undefined,
    completedAt: 5_000,
  }));

  try {
    const result = await busA.request({
      kind: "disconnect_session",
      requestId: "req-redis-1",
      targetInstanceId: "node-b",
      sessionId: "session-1",
      requestedAt: 4_000,
    });

    assert.deepEqual(result, {
      requestId: "req-redis-1",
      targetInstanceId: "node-b",
      executorInstanceId: "node-b",
      status: "ok",
      roomCode: null,
      memberId: undefined,
      sessionId: "session-1",
      completedAt: 5_000,
    });
  } finally {
    await unsubscribe();
    await busA.close();
    await busB.close();
  }
});

test("redis admin command bus reports stale target when no subscriber responds", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const bus = await createRedisAdminCommandBus(REDIS_URL, {
    commandChannelPrefix: createChannelPrefix("bsp:test:admin-command"),
    resultChannelPrefix: createChannelPrefix("bsp:test:admin-command-result"),
  });

  try {
    const result = await bus.request(
      {
        kind: "kick_member",
        requestId: "req-redis-2",
        targetInstanceId: "missing-node",
        roomCode: "ROOM01",
        memberId: "member-a",
        requestedAt: 6_000,
      },
      100,
    );

    assert.equal(result.status, "stale_target");
    assert.equal(result.code, "command_timeout");
  } finally {
    await bus.close();
  }
});

test("a failing cleanup UNSUBSCRIBE does not replace the request's answer", async () => {
  // `request` runs three commands on the subscriber connection: SUBSCRIBE, the
  // reply wait, and an UNSUBSCRIBE in a `finally`. Only the middle one is the
  // answer. Since #271 gave this client a `commandTimeout`, a stalled Redis
  // rejects the cleanup instead of hanging in it — and an unguarded `finally`
  // would throw that rejection over a well-formed result, precisely on the
  // stall the `command_timeout` result exists to describe.
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    unsubscribe: async () => {
      throw new Error("Command timed out");
    },
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  try {
    // Nothing replies, so the reply timer produces the answer.
    const result = await bus.request(
      {
        kind: "kick_member",
        requestId: "request-1",
        targetInstanceId: "instance-1",
        roomCode: "ABC123",
        memberId: "member-1",
        requestedAt: 1,
      },
      20,
    );

    assert.equal(result.status, "stale_target");
    assert.equal(
      result.status === "stale_target" ? result.code : null,
      "command_timeout",
    );
  } finally {
    await bus.close();
  }
});
