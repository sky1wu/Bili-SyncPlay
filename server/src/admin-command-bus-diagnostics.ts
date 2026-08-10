import type { MetricsCollector } from "./admin/metrics.js";
import type { AdminCommand } from "./admin-command-bus.js";
import { createDiagnosisThrottle } from "./diagnosis-throttle.js";
import type { LogEvent } from "./types.js";

/**
 * How often a repeated admin command bus failure diagnosis may be logged.
 *
 * Its own constant, like every other throttle here: this one paces a report
 * driven by admin requests and by command fan-out, which are different rates
 * from the event store's log volume and the session store's request rate.
 */
const COMMAND_BUS_FAILURE_REPORT_INTERVAL_MS = 60_000;

/** Operations, command kinds, and two connection roles share this bound. */
const MAX_TRACKED_COMMAND_BUS_FAILURE_DIAGNOSES = 16;

export function createAdminCommandBusFailureHandlers(options: {
  metricsCollector: Pick<
    MetricsCollector,
    "observeRedisAdminCommandBusFailure"
  >;
  getLogEvent: () => LogEvent;
  instanceId: string;
  now?: () => number;
}) {
  const throttle = createDiagnosisThrottle({
    intervalMs: COMMAND_BUS_FAILURE_REPORT_INTERVAL_MS,
    maxTrackedDiagnoses: MAX_TRACKED_COMMAND_BUS_FAILURE_DIAGNOSES,
    now: options.now,
  });

  return {
    onResultPublishFailed(command: AdminCommand, error: unknown) {
      // The failed Redis operations were already counted by
      // onBusCommandFailed. This terminal callback describes a different fact:
      // neither the result nor its fallback reached the requester.
      if (!throttle.allow(`result:${command.kind}`)) {
        return;
      }
      options.getLogEvent()("admin_command_result_publish_failed", {
        instanceId: options.instanceId,
        commandKind: command.kind,
        requestId: command.requestId,
        targetInstanceId: command.targetInstanceId,
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    },
    onBusCommandFailed({
      operation,
      error,
    }: {
      operation: "subscribe" | "publish" | "unsubscribe" | "publish_result";
      error: unknown;
    }) {
      // Count each Redis operation failure. The line is throttled because an
      // admin console polling through an outage would otherwise emit one per
      // poll.
      options.metricsCollector.observeRedisAdminCommandBusFailure(operation);
      if (!throttle.allow(`bus:${operation}`)) {
        return;
      }
      options.getLogEvent()("admin_command_bus_command_failed", {
        instanceId: options.instanceId,
        operation,
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    },
    onConnectionDropped({
      role,
      consecutiveFailures,
    }: {
      role: "publisher" | "subscriber";
      consecutiveFailures: number;
    }) {
      // Subscriber state failures reset after one event, so a permission error
      // can otherwise emit one line per human request or close-room fan-out.
      // The per-operation counter above remains unconditional.
      if (!throttle.allow(`reset:${role}`)) {
        return;
      }
      options.getLogEvent()("admin_command_bus_connection_reset", {
        instanceId: options.instanceId,
        role,
        consecutiveFailures,
        result: "error",
      });
    },
  };
}
