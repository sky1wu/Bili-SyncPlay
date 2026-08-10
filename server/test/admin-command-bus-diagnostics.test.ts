import assert from "node:assert/strict";
import test from "node:test";
import { createAdminCommandBusFailureHandlers } from "../src/admin-command-bus-diagnostics.js";

test("a lost admin command result counts only the Redis operations that failed", () => {
  const operations: string[] = [];
  const events: string[] = [];
  const handlers = createAdminCommandBusFailureHandlers({
    metricsCollector: {
      observeRedisAdminCommandBusFailure: (operation) => {
        operations.push(operation);
      },
    },
    getLogEvent: () => (event) => {
      events.push(event);
    },
    instanceId: "instance-1",
    now: () => 1_000,
  });
  const error = new Error("Command timed out");

  // The normal result publish and the fallback publish are two failed Redis
  // operations. The terminal callback says both answers were lost; it is not a
  // third Redis operation.
  handlers.onBusCommandFailed({ operation: "publish_result", error });
  handlers.onBusCommandFailed({ operation: "publish_result", error });
  handlers.onResultPublishFailed(
    {
      kind: "disconnect_session",
      requestId: "request-1",
      targetInstanceId: "instance-1",
      sessionId: "session-1",
      requestedAt: 900,
    },
    error,
  );
  handlers.onConnectionDropped({
    role: "subscriber",
    consecutiveFailures: 1,
  });
  handlers.onConnectionDropped({
    role: "subscriber",
    consecutiveFailures: 1,
  });

  assert.deepEqual(operations, ["publish_result", "publish_result"]);
  assert.deepEqual(events, [
    "admin_command_bus_command_failed",
    "admin_command_result_publish_failed",
    "admin_command_bus_connection_reset",
  ]);
});
