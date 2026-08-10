import assert from "node:assert/strict";
import test from "node:test";
import { createAdminCommandBusFailureHandlers } from "../src/admin-command-bus-diagnostics.js";

test("a terminal admin result publish failure is counted independently of Redis operation failures", () => {
  const operations: string[] = [];
  const publishFailureKinds: string[] = [];
  const events: string[] = [];
  const handlers = createAdminCommandBusFailureHandlers({
    metricsCollector: {
      observeRedisAdminCommandBusFailure: (operation) => {
        operations.push(operation);
      },
      recordAdminCommandResultPublishFailure: (commandKind) => {
        publishFailureKinds.push(commandKind);
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
  // operations. The terminal callback says the publish path ended in failure;
  // it is not a third Redis operation, but every such terminal failure gets its
  // own count even when the diagnostic log for that command kind is throttled.
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
  handlers.onResultPublishFailed(
    {
      kind: "disconnect_session",
      requestId: "request-2",
      targetInstanceId: "instance-1",
      sessionId: "session-2",
      requestedAt: 901,
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
  assert.deepEqual(publishFailureKinds, [
    "disconnect_session",
    "disconnect_session",
  ]);
  assert.deepEqual(events, [
    "admin_command_bus_command_failed",
    "admin_command_result_publish_failed",
    "admin_command_bus_connection_reset",
  ]);
});
