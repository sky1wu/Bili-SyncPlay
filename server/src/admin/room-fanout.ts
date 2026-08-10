import { createConcurrencyLimiter } from "../concurrency-limiter.js";

/**
 * How many rooms an admin read may have in flight at once.
 *
 * The admin services answer a question about EVERY room by mapping over the
 * room codes and issuing at least one store command per code. That fan-out is
 * sized by the deployment, not by the request — so on a Redis-backed store it
 * runs straight into the store's synchronous command admission, which refuses
 * past its limit. The result is an admin console that fails, deterministically
 * and on a completely healthy Redis, once a deployment has more rooms than that
 * limit (257 was enough, #277 review).
 *
 * Admission is a refusal-style safety boundary and this is a waiting budget for
 * work already accepted; the two roles have to stay separate, or ordinary
 * fan-out turns the boundary into a partial business operation
 * (`concurrency-limiter`, and the same split the admin command bus landed on in
 * #275).
 *
 * 64 because it is comfortably under every store's admission limit even with
 * two admin reads overlapping, and far above the point where added concurrency
 * still buys round trips.
 */
export const ADMIN_ROOM_FANOUT_LIMIT = 64;

/**
 * One budget per admin service, shared by every fan-out inside it.
 *
 * Per SERVICE rather than per call, because concurrent calls multiply a
 * per-call batch and the boundary they must stay under is global to the store
 * (#275).
 */
export function createRoomFanOutLimiter() {
  return createConcurrencyLimiter(ADMIN_ROOM_FANOUT_LIMIT);
}
