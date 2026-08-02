/**
 * Who currently owns the room's share, given who shared it and who is online.
 *
 * `sharedVideo.sharedByMemberId` is written once, at `video:share`, and is a
 * durable reference to a volatile identity: a member id only exists while that
 * member holds a seat. Once the sharer leaves — or their `memberToken` outlives
 * its retention and they come back as somebody else (#237) — the stored id
 * matches nobody, every client computes `isLocalSharedSource() === false`, and
 * the room stops advancing because no one considers themselves the sharer
 * (#235).
 *
 * So ownership is DERIVED at every read rather than rewritten into the room.
 * That keeps the stored id meaningful as the *preferred* owner: a member whose
 * socket blipped — an MV3 service worker suspending is enough — drops out of
 * the member list and gets the share back the moment they reconnect under the
 * same id. Persisting a transfer would hand the room away permanently on a
 * two-second outage.
 *
 * The successor rule is "longest tenure wins", not "smallest id wins", so the
 * answer is stable under joins: a member arriving later normally carries a later
 * `joinedAt`, so a new arrival does not displace a sitting successor and the
 * room is not reshuffled every time somebody walks in. `memberId` breaks ties so
 * the result stays deterministic across nodes resolving the same room.
 *
 * That stability is a comfort, not a correctness argument, and nothing here may
 * lean on it: `joinedAt` is stamped by whichever node handled the join, so two
 * nodes' clocks disagreeing can reorder members. The publish side therefore asks
 * whether a joiner *ended up* owning the share rather than assuming a join can
 * never win it.
 */
export type SharedVideoOwnerCandidate = {
  id: string;
  joinedAt?: number | null;
};

function compareCandidates(
  left: SharedVideoOwnerCandidate,
  right: SharedVideoOwnerCandidate,
): number {
  // A null `joinedAt` means the session never recorded one; it must never win
  // the tenure comparison, or an unjoined session would outrank real members.
  const leftJoinedAt = left.joinedAt ?? Number.POSITIVE_INFINITY;
  const rightJoinedAt = right.joinedAt ?? Number.POSITIVE_INFINITY;
  if (leftJoinedAt !== rightJoinedAt) {
    return leftJoinedAt - rightJoinedAt;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Returns the member id that should be presented as the share owner.
 *
 * Keeps `sharedByMemberId` when that member is online. Otherwise elects the
 * longest-tenured online member. With no online members there is nobody to
 * elect, so the stored id is returned untouched — an empty room has no client
 * to mislead, and the room may still be reclaimed by its original sharer.
 *
 * Repairs a dangling reference; it does not invent one. Without a stored id
 * there is no ownership to inherit — a room nobody has shared into must not
 * acquire a sharer just because somebody is sitting in it.
 */
export function resolveSharedVideoOwnerId(
  sharedByMemberId: string | null | undefined,
  members: readonly SharedVideoOwnerCandidate[],
): string | undefined {
  if (!sharedByMemberId) {
    return undefined;
  }
  if (members.some((member) => member.id === sharedByMemberId)) {
    return sharedByMemberId;
  }

  let successor: SharedVideoOwnerCandidate | null = null;
  for (const member of members) {
    if (!successor || compareCandidates(member, successor) < 0) {
      successor = member;
    }
  }

  return successor?.id ?? sharedByMemberId;
}

/**
 * Did removing `leavingMember` hand the share to somebody else?
 *
 * The caller needs this because a protocol >= 2 client is told about a leave
 * with `room:member-left`, which only edits its member list — the cached
 * `sharedVideo` keeps whatever owner the last full `room:state` carried. When
 * ownership moves, that cache is wrong and the room needs a real `room:state`
 * (#235). Computed from the member list the leave already loaded, so this costs
 * no extra store read.
 */
export function sharedVideoOwnerChangedOnLeave(args: {
  sharedByMemberId: string | null | undefined;
  membersAfter: readonly SharedVideoOwnerCandidate[];
  leavingMember: SharedVideoOwnerCandidate;
}): boolean {
  // A seat still held by that id did not go anywhere — the session was replaced,
  // not the member. Re-adding it would put the same id in the election twice
  // with two different `joinedAt` values, and the older copy would beat the
  // survivor's own entry and report a handover that never happened.
  const memberStillSeated = args.membersAfter.some(
    (member) => member.id === args.leavingMember.id,
  );
  const ownerBefore = memberStillSeated
    ? resolveSharedVideoOwnerId(args.sharedByMemberId, args.membersAfter)
    : resolveSharedVideoOwnerId(args.sharedByMemberId, [
        ...args.membersAfter,
        args.leavingMember,
      ]);
  const ownerAfter = resolveSharedVideoOwnerId(
    args.sharedByMemberId,
    args.membersAfter,
  );
  return ownerBefore !== ownerAfter;
}
