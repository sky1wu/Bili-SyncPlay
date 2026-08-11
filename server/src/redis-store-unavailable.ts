export type RedisStoreKind = "room" | "runtime";
export type RedisStoreUnavailableReason = "admission" | "timeout";

/**
 * A caller-facing Redis store failure whose operation is safe to retry.
 *
 * The internal message remains useful to logs and tests, while the admin
 * router deliberately emits its own stable public message so operation names,
 * limits, and timeout budgets do not leak through the HTTP boundary.
 */
export class RedisStoreUnavailableError extends Error {
  constructor(
    readonly store: RedisStoreKind,
    readonly operationName: string,
    readonly reason: RedisStoreUnavailableReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RedisStoreUnavailableError";
  }
}

export function redisStoreUnavailableMessage(store: RedisStoreKind): string {
  return store === "room"
    ? "Room store is unavailable."
    : "Runtime store is unavailable.";
}
