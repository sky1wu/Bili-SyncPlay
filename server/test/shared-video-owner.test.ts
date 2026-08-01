import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSharedVideoOwnerId,
  sharedVideoOwnerChangedOnLeave,
} from "../src/shared-video-owner.js";

test("keeps the stored sharer while that member is online", () => {
  assert.equal(
    resolveSharedVideoOwnerId("member-b", [
      { id: "member-a", joinedAt: 1_000 },
      { id: "member-b", joinedAt: 2_000 },
    ]),
    "member-b",
  );
});

test("elects the longest-tenured member once the sharer is gone", () => {
  // Deliberately not the smallest id, and deliberately not first in the list:
  // the election must run on `joinedAt`, not on ordering luck.
  assert.equal(
    resolveSharedVideoOwnerId("member-gone", [
      { id: "member-c", joinedAt: 5_000 },
      { id: "member-a", joinedAt: 9_000 },
      { id: "member-b", joinedAt: 3_000 },
    ]),
    "member-b",
  );
});

test("a later arrival never displaces the sitting successor", () => {
  // The publish side depends on this: it treats a join as ownership-neutral
  // unless the joiner IS the stored sharer, which only holds if a newer
  // `joinedAt` can never win.
  const before = resolveSharedVideoOwnerId("member-gone", [
    { id: "member-z", joinedAt: 1_000 },
  ]);
  const after = resolveSharedVideoOwnerId("member-gone", [
    { id: "member-z", joinedAt: 1_000 },
    { id: "member-a", joinedAt: 2_000 },
  ]);
  assert.equal(before, "member-z");
  assert.equal(after, "member-z");
});

test("breaks a tenure tie on member id so every node agrees", () => {
  assert.equal(
    resolveSharedVideoOwnerId("member-gone", [
      { id: "member-c", joinedAt: 1_000 },
      { id: "member-a", joinedAt: 1_000 },
    ]),
    "member-a",
  );
});

test("a member without a join time never outranks one that has it", () => {
  assert.equal(
    resolveSharedVideoOwnerId("member-gone", [
      { id: "aaa-no-join-time", joinedAt: null },
      { id: "zzz-joined", joinedAt: 9_000 },
    ]),
    "zzz-joined",
  );
});

test("returns the stored sharer when nobody is online to inherit", () => {
  assert.equal(resolveSharedVideoOwnerId("member-gone", []), "member-gone");
  assert.equal(resolveSharedVideoOwnerId(undefined, []), undefined);
});

test("an unshared room elects nobody", () => {
  // Repairing a dangling reference is not the same as inventing one: a room
  // nobody shared into must not sprout a sharer just because it has members.
  assert.equal(
    resolveSharedVideoOwnerId(undefined, [{ id: "member-a", joinedAt: 1_000 }]),
    undefined,
  );
});

test("the sharer leaving moves ownership", () => {
  assert.equal(
    sharedVideoOwnerChangedOnLeave({
      sharedByMemberId: "member-a",
      membersAfter: [{ id: "member-b", joinedAt: 2_000 }],
      leavingMember: { id: "member-a", joinedAt: 1_000 },
    }),
    true,
  );
});

test("a bystander leaving leaves ownership alone", () => {
  assert.equal(
    sharedVideoOwnerChangedOnLeave({
      sharedByMemberId: "member-a",
      membersAfter: [{ id: "member-a", joinedAt: 1_000 }],
      leavingMember: { id: "member-c", joinedAt: 3_000 },
    }),
    false,
  );
});

test("the standing successor leaving moves ownership again", () => {
  // The stored sharer left long ago, so the id that moves is not theirs — the
  // reason this asks the election rather than comparing against the stored id.
  assert.equal(
    sharedVideoOwnerChangedOnLeave({
      sharedByMemberId: "member-gone",
      membersAfter: [{ id: "member-c", joinedAt: 3_000 }],
      leavingMember: { id: "member-b", joinedAt: 2_000 },
    }),
    true,
  );
});

test("a bystander leaving an orphaned room leaves ownership alone", () => {
  assert.equal(
    sharedVideoOwnerChangedOnLeave({
      sharedByMemberId: "member-gone",
      membersAfter: [{ id: "member-b", joinedAt: 2_000 }],
      leavingMember: { id: "member-c", joinedAt: 3_000 },
    }),
    false,
  );
});

test("an unshared room never reports an ownership move", () => {
  // Otherwise every leave from a room with no shared video would trigger a
  // full-state broadcast that nothing in the room needs.
  assert.equal(
    sharedVideoOwnerChangedOnLeave({
      sharedByMemberId: undefined,
      membersAfter: [{ id: "member-b", joinedAt: 2_000 }],
      leavingMember: { id: "member-a", joinedAt: 1_000 },
    }),
    false,
  );
});
