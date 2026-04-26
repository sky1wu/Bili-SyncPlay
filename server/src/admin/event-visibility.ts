const HIDDEN_SYSTEM_EVENTS = new Set([
  "admin_audit_log_append_failed",
  "node_heartbeat_failed",
  "node_heartbeat_sent",
  "redis_runtime_store_operation_failed",
  "room_event_bus_error",
  "room_event_bus_invalid_message",
  "room_event_consumed",
  "room_event_handler_failed",
  "room_event_publish_failed",
  "room_event_published",
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
