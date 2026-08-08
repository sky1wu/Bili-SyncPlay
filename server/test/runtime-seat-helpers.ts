import type { RuntimeStore } from "../src/runtime-store.js";
import type { Session } from "../src/types.js";

/**
 * Test helpers for seating a session directly in a runtime store.
 *
 * The store is write-behind: `registerSession` / `markSessionJoinedRoom` /
 * `addMember` update this node's own maps synchronously and queue the shared
 * write behind them. A test that seats a session and then reads the cluster
 * index back — directly, or through an admin HTTP route — is racing that queue,
 * and it loses in a way that is silent and PARTIAL, because the queue drains in
 * order: the session write lands while the room-index write is still pending
 * (#247, and the CI failures in #244 that found it).
 *
 * These tests used to get away with it only because an unrelated
 * `await heartbeatNode(...)` sat between the writes and the read and happened to
 * cost enough round trips to drain the queue. That is incidental latency, not a
 * barrier — a probe reading the shared index at seat time finds the session
 * absent from it every run.
 */

type SeatBarrierStore = Pick<RuntimeStore, "flush" | "confirmWrites">;

export type RuntimeSeat = {
  roomCode: string;
  memberId: string;
  memberToken: string;
};

/**
 * The ordering barrier a test owes any read of its own write-behind writes.
 *
 * Both halves, because they answer different questions (see
 * `docs/reference/invariants.md`): `flush` says the queue emptied — which is
 * what "my own writes are visible to the read I am about to do" needs — while
 * `confirmWrites` reports failures from the session write queue. `addMember`
 * does not use that queue, so callers that depend on it must verify its shared
 * result separately; {@link seatSession} does that before returning.
 */
export async function settleRuntimeWrites(
  runtimeStore: SeatBarrierStore,
): Promise<void> {
  await runtimeStore.flush?.();
  await runtimeStore.confirmWrites?.();
}

/**
 * Seat `session` as a member of a room and return once the shared index can be
 * read back.
 *
 * The seat fields are written onto the session BEFORE it is registered, because
 * `markSessionJoinedRoom` rebuilds the whole session hash from this node's live
 * copy at the moment the queued write runs — so a session still carrying nulls
 * is what gets persisted.
 *
 * `registerSession` and `markSessionJoinedRoom` report their real outcome, so
 * they are awaited individually: a failure surfaces here, at the seat, rather
 * than as an unhandled rejection or as a puzzling assertion further down.
 */
export async function seatSession(
  runtimeStore: RuntimeStore,
  session: Session,
  seat: RuntimeSeat,
): Promise<void> {
  session.roomCode = seat.roomCode;
  session.memberId = seat.memberId;
  session.memberToken = seat.memberToken;

  await runtimeStore.registerSession(session);
  await runtimeStore.markSessionJoinedRoom(session.id, seat.roomCode);
  runtimeStore.addMember(
    seat.roomCode,
    seat.memberId,
    session,
    seat.memberToken,
  );

  await settleRuntimeWrites(runtimeStore);

  // `addMember` returns only the local room and its Redis operation is tracked
  // through an error-swallowed promise, outside the session write queue that
  // `confirmWrites` reports. Read the seat back through Redis-authoritative
  // paths so an add-member failure cannot turn a setup into a false green.
  const persistedMemberId = await runtimeStore.findMemberIdByToken(
    seat.roomCode,
    seat.memberToken,
  );
  if (persistedMemberId !== seat.memberId) {
    throw new Error(
      `Runtime seat ${seat.memberId} in ${seat.roomCode} was not persisted: ` +
        `member token resolved to ${persistedMemberId ?? "nothing"}.`,
    );
  }

  // The token check above matters for the Redis store: once the shared token
  // hash is non-empty, `getRoom` cannot fall back to this node's local mirror,
  // so this verifies the shared member→session binding as well.
  const persistedRoom = await runtimeStore.getRoom(seat.roomCode);
  const persistedSessionId = persistedRoom?.members.get(seat.memberId)?.id;
  if (persistedSessionId !== session.id) {
    throw new Error(
      `Runtime seat ${seat.memberId} in ${seat.roomCode} was not persisted: ` +
        `member binding resolved to ${persistedSessionId ?? "nothing"}.`,
    );
  }
}
