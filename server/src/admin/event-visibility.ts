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
 * The `runtime_event_appends_*` lines are absent because they never reach the
 * store to be filtered: `EVENT_STORE_EXCLUDED_EVENTS` in `logger.ts` keeps the
 * event store's own backpressure reports out of the event store (#266 review).
 * If that exclusion is ever lifted, they belong here.
 */
const HIDDEN_SYSTEM_EVENTS = new Set([
  "admin_audit_log_append_failed",
  "admin_command_bus_close_unfinished",
  "node_heartbeat_abandoned_at_shutdown",
  "node_heartbeat_failed",
  "node_heartbeat_sent",
  "node_heartbeat_skipped",
  "redis_runtime_store_operation_failed",
  "room_event_bus_close_unfinished",
  "room_event_bus_error",
  "room_event_bus_invalid_message",
  "room_event_consumed",
  "room_event_handler_failed",
  "room_event_publish_failed",
  "room_event_published",
  "room_index_reconcile_abandoned_at_shutdown",
  "room_reaper_sweep_abandoned_at_shutdown",
  "room_store_close_unfinished",
  "runtime_index_reaper_failed",
  "runtime_index_sessions_reaped",
  "runtime_store_close_unfinished",
  "server_shutdown_step_failed",
]);

export function shouldIncludeRuntimeEvent(
  eventName: string,
  includeSystem = false,
): boolean {
  return includeSystem || !HIDDEN_SYSTEM_EVENTS.has(eventName);
}
