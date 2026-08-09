/**
 * Infrastructure plumbing the admin event list hides unless asked for.
 *
 * A new event belongs here when its closest existing sibling is here: every
 * `node_heartbeat_*` is (they say nothing about a room), and so is
 * `server_shutdown_step_failed` — which is what the `*_abandoned_at_shutdown`
 * lines replaced for the maintenance timers that now stop on their own budget
 * (#261, #263). Room-lifecycle events stay visible, including
 * `room_persist_failed` and `room_index_reconcile_failed`, so their `reason`
 * variants are not listed here either.
 *
 * Deliberately absent, despite being infrastructure:
 * `runtime_event_appends_dropped` and `runtime_event_appends_resumed`. They are
 * not a statement about the server, they are a statement about THIS LIST —
 * that it is missing events, and how many (#264). Hiding them would leave the
 * gap they explain sitting in plain sight with the explanation switched off.
 */
const HIDDEN_SYSTEM_EVENTS = new Set([
  "admin_audit_log_append_failed",
  "node_heartbeat_abandoned_at_shutdown",
  "node_heartbeat_failed",
  "node_heartbeat_sent",
  "node_heartbeat_skipped",
  "redis_runtime_store_operation_failed",
  "room_event_bus_error",
  "room_event_bus_invalid_message",
  "room_event_consumed",
  "room_event_handler_failed",
  "room_event_publish_failed",
  "room_event_published",
  "room_index_reconcile_abandoned_at_shutdown",
  "room_reaper_sweep_abandoned_at_shutdown",
  "runtime_event_appends_abandoned_at_shutdown",
  "runtime_index_reaper_failed",
  "runtime_index_sessions_reaped",
  "server_shutdown_step_failed",
]);

export function shouldIncludeRuntimeEvent(
  eventName: string,
  includeSystem = false,
): boolean {
  return includeSystem || !HIDDEN_SYSTEM_EVENTS.has(eventName);
}
