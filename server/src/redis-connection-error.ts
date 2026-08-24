import type { LogEvent } from "./types.js";

/**
 * A socket-level failure on one Redis connection.
 *
 * Deliberately one event name for all nine connections rather than one per
 * component: an operator asking "is Redis reachable from this node" wants one
 * counter to watch, and `component` answers "which connection" as a dimension
 * of it. `events_total{event="redis_connection_error"}` therefore answers both
 * of #266's questions statelessly — "still happening?" and "how much?" — with
 * no start/end pair to keep honest.
 */
export const REDIS_CONNECTION_ERROR_EVENT = "redis_connection_error";

/**
 * Which connection failed.
 *
 * Every one of these is created by `createBoundedRedisClient`, and the factory
 * requires this the same way it requires a bound: an omitted identity is
 * invisible in a diff, and this issue exists because an omitted listener was
 * invisible in seven of them (#280).
 */
export type RedisConnectionComponent =
  | "admin_command_bus"
  | "admin_session_store"
  | "audit_store"
  | "event_store"
  | "room_event_bus"
  | "room_store"
  | "runtime_store";

/** Which half of a pub/sub pair failed; absent on single-client connections. */
export type RedisConnectionRole = "publisher" | "subscriber";

export type RedisConnectionIdentity = {
  readonly component: RedisConnectionComponent;
  readonly role?: RedisConnectionRole;
  /** Which node this connection belongs to; see {@link RedisConnectionReporting}. */
  readonly instanceId?: string;
};

/**
 * Everything a connection needs to report, as ONE value.
 *
 * Both halves or neither, deliberately. Which node a connection belongs to is
 * part of its identity — multi-node deployments aggregate these lines into one
 * backend, where "the audit store's connection was refused" without a node is
 * not actionable. Carrying the node as a second, separately-optional option let
 * a bootstrap pass the logger and forget the node, which is exactly what the
 * admin services' own bootstrap did: they run as their own process and reach
 * these stores through a different path, so "the bootstrap wraps its logger to
 * add the node" was a per-call-site responsibility — the same shape that left
 * seven connections without a listener in the first place. Bundled, that
 * failure is not expressible (#280 review).
 */
export type RedisConnectionReporting = {
  readonly instanceId: string;
  readonly logEvent: LogEvent;
};

/**
 * ioredis emits `error` once per reconnect attempt, so one outage is a burst:
 * the 2026-08-11 incident produced nine lines inside 1.3 seconds. A burst is
 * still ONE fact, so the line is throttled per connection and per code — while
 * the counter behind `logEvent` stays unconditional, because throttling the
 * count is what leaves an operator unable to tell nine failures from nine
 * million (#266, #268).
 */
export const REDIS_CONNECTION_ERROR_REPORT_INTERVAL_MS = 60_000;

/**
 * How many (connection, code) pairs stay individually tracked inside one
 * window.
 *
 * The identity half is bounded by the deployment — seven components, two of
 * them pub/sub pairs, nine connections in total. The code half is the open one:
 * a cascading failure walks connections through `ECONNREFUSED`, `ECONNRESET`,
 * `ETIMEDOUT` and whatever else the socket produces. Sized so every connection
 * can carry a handful of codes without any of them falling into the shared
 * overflow bucket, because that bucket is exactly where the report stops
 * saying WHICH connection broke — the one thing this key exists to say. Past
 * it the vocabulary really is open-ended, and sharing a window is the honest
 * answer (#268, #280).
 */
export const REDIS_CONNECTION_ERROR_MAX_TRACKED = 64;

/**
 * The error's code, or a stable stand-in.
 *
 * ioredis surfaces Node's socket codes (`ECONNREFUSED`, `ECONNRESET`,
 * `ETIMEDOUT`) on the error object. They are the diagnosis an operator acts
 * on — "Redis is not listening" and "Redis dropped an established socket" are
 * different incidents — so they are a field of their own rather than being
 * left inside the message string.
 */
export function redisConnectionErrorCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return error instanceof Error && error.name.length > 0 ? error.name : "other";
}

/**
 * Attaches the report to one connection.
 *
 * Returned as a listener rather than applied here so `createBoundedRedisClient`
 * stays the only place that knows how a client is wired, and so the throttle
 * key is built once from the identity that owns it.
 */
export function createRedisConnectionErrorListener(
  identity: RedisConnectionIdentity,
  logEvent: LogEvent,
): (error: unknown) => void {
  const connectionKey =
    identity.role === undefined
      ? identity.component
      : `${identity.component}:${identity.role}`;
  return (error: unknown) => {
    const code = redisConnectionErrorCode(error);
    logEvent(
      REDIS_CONNECTION_ERROR_EVENT,
      {
        ...(identity.instanceId === undefined
          ? {}
          : { instanceId: identity.instanceId }),
        component: identity.component,
        ...(identity.role === undefined ? {} : { role: identity.role }),
        code,
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      },
      {
        // Per connection AND per code: a reconnect loop repeats one code, while
        // a node that can reach Redis on one connection and not another is a
        // different fact that must not be hidden behind the first one's window.
        throttleKey: `${REDIS_CONNECTION_ERROR_EVENT}:${connectionKey}:${code}`,
        throttleIntervalMs: REDIS_CONNECTION_ERROR_REPORT_INTERVAL_MS,
        throttleMaxTracked: REDIS_CONNECTION_ERROR_MAX_TRACKED,
      },
    );
  };
}

/**
 * What a connection reports through when no logger was supplied.
 *
 * Reachable: a store constructed directly with a URL — the real-Redis test
 * suite does exactly that — creates a connection nobody wired a logger to.
 * Printing the line unthrottled is the right behaviour there; the throttle
 * belongs to the logger because that is also where the unconditional counter
 * lives, and splitting them is what #266 forbids.
 */
export const logRedisConnectionErrorToStdout: LogEvent = (
  event,
  data,
  options,
) => {
  console.log(
    JSON.stringify({
      event,
      level: options?.level ?? "error",
      timestamp: new Date().toISOString(),
      ...data,
    }),
  );
};
