export type RedisStoreKind = "room" | "runtime";
export type RedisStoreUnavailableReason = "admission" | "timeout";

export type RedisStoreUnavailableHttpError = {
  statusCode: 503;
  code: `${RedisStoreKind}_store_unavailable`;
  message: string;
};

/**
 * A caller-facing Redis store failure whose operation is safe to retry.
 *
 * The internal message remains useful to logs and tests, while HTTP boundaries
 * deliberately emit one stable public message so operation names, limits, and
 * timeout budgets do not leak through the response.
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

/**
 * Translate the typed store failure once for every HTTP boundary.
 *
 * The admin router and the dedicated metrics server do not share a catch
 * block, but they must expose the same retryable status and the same
 * non-sensitive payload. Keeping that policy here prevents a new boundary
 * from rebuilding it from `error.message` and leaking command details.
 */
export function toRedisStoreUnavailableHttpError(
  error: unknown,
): RedisStoreUnavailableHttpError | null {
  if (!(error instanceof RedisStoreUnavailableError)) {
    return null;
  }
  return {
    statusCode: 503,
    code: `${error.store}_store_unavailable`,
    message:
      error.store === "room"
        ? "Room store is unavailable."
        : "Runtime store is unavailable.",
  };
}
