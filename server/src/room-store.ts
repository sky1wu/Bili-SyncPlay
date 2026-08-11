import type { PlaybackState, SharedVideo } from "@bili-syncplay/protocol";
import type { RoomListQuery } from "./admin/types.js";
import {
  resolveSharedVideoOwnerId,
  type SharedVideoOwnerCandidate,
} from "./shared-video-owner.js";
import type { ActiveRoom, PersistedRoom, RoomStoreRoomState } from "./types.js";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type CreatePersistedRoomInput = {
  code: string;
  joinToken: string;
  createdAt: number;
  ownerMemberId?: string | null;
  ownerDisplayName?: string | null;
};

export type PersistedRoomPatch = {
  ownerDisplayName?: string | null;
  sharedVideo?: SharedVideo | null;
  playback?: PlaybackState | null;
  lastActiveAt?: number;
  expiresAt?: number | null;
};

export type RoomUpdateResult =
  | { ok: true; room: PersistedRoom }
  | { ok: false; reason: "not_found" | "version_conflict" };

/** Chooses whether this read owns its deadline or is inside a maintenance pass. */
export type RoomReadCaller = "request" | "maintenance_pass";

/** A durable handoff naming one discovery of an orphaned room-index entry. */
export type OrphanedIndexClaim = {
  code: string;
  token: string;
};

/** What one expiry sweep removed, split by whether a room was actually there. */
export type ExpiredRoomSweep = {
  /** Rooms whose body this pass deleted. */
  deletedRoomCodes: string[];
  /**
   * Index entries this pass dropped whose room body was already gone. They
   * still owe runtime teardown, but no room died here.
   */
  orphanedIndexCodes: string[];
  /**
   * Durable claims corresponding to {@link orphanedIndexCodes}. A Redis-backed
   * store keeps each claim until the caller confirms that runtime teardown has
   * settled, so another process can retry after a crash.
   */
  orphanedIndexClaims?: OrphanedIndexClaim[];
};

export type RoomStore = {
  createRoom: (input: CreatePersistedRoomInput) => Promise<PersistedRoom>;
  getRoom: (
    code: string,
    caller?: RoomReadCaller,
  ) => Promise<PersistedRoom | null>;
  updateRoom: (
    code: string,
    expectedVersion: number,
    patch: PersistedRoomPatch,
  ) => Promise<RoomUpdateResult>;
  /**
   * Removes the room record. Idempotent, and reports whether THIS call is the
   * one that removed it: concurrent readers of the same expired room all reach
   * the delete, and only the winner may be counted as having reclaimed a room.
   */
  deleteRoom: (code: string) => Promise<boolean>;
  /**
   * Deletes every expired room and reports what the pass found, split by
   * category.
   *
   * Codes, not a count: the runtime store keeps per-room state that outlives a
   * disconnect (member tokens, since #234) and nothing else collects it once the
   * room is gone, so the caller has to be told WHICH rooms died (#237 review).
   *
   * Split, because the two categories owe different things. Both need runtime
   * teardown, but only the first is a room this pass reclaimed — an orphaned
   * index entry (manual cleanup, an older build, corruption) never had a live
   * room behind it, and counting it would put the reclamation metric back out
   * of step with room creations (#254 review).
   */
  deleteExpiredRooms: (now: number) => Promise<ExpiredRoomSweep>;
  /**
   * Acknowledge orphan claims only after their runtime teardown has settled.
   * Tokens make a late acknowledgement harmless when the room code was reused
   * and became orphaned again in the meantime.
   */
  acknowledgeOrphanedIndexClaims?: (
    claims: readonly OrphanedIndexClaim[],
  ) => Promise<void>;
  listRooms: (
    query: Pick<
      RoomListQuery,
      | "keyword"
      | "includeExpired"
      | "page"
      | "pageSize"
      | "sortBy"
      | "sortOrder"
    >,
  ) => Promise<PersistedRoom[]>;
  countRooms: (
    query: Pick<RoomListQuery, "keyword" | "includeExpired">,
  ) => Promise<number>;
  isReady: () => Promise<boolean>;
};

type CreateInMemoryRoomStoreOptions = {
  now?: () => number;
};

export function createRoomCode(): string {
  return Array.from(
    { length: 6 },
    () =>
      ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)],
  ).join("");
}

function cloneRoom(room: PersistedRoom): PersistedRoom {
  return {
    ...room,
    sharedVideo: room.sharedVideo ? { ...room.sharedVideo } : null,
    playback: room.playback ? { ...room.playback } : null,
  };
}

export function createPersistedRoom(
  input: CreatePersistedRoomInput,
): PersistedRoom {
  return {
    code: input.code,
    joinToken: input.joinToken,
    createdAt: input.createdAt,
    ownerMemberId: input.ownerMemberId ?? null,
    ownerDisplayName: input.ownerDisplayName ?? null,
    sharedVideo: null,
    playback: null,
    version: 0,
    lastActiveAt: input.createdAt,
    expiresAt: null,
  };
}

export function createInMemoryRoomStore(
  options: CreateInMemoryRoomStoreOptions = {},
): RoomStore {
  const rooms = new Map<string, PersistedRoom>();
  const now = options.now ?? Date.now;

  function matchesQuery(
    room: PersistedRoom,
    query: Pick<RoomListQuery, "keyword" | "includeExpired">,
  ): boolean {
    if (
      !query.includeExpired &&
      room.expiresAt !== null &&
      room.expiresAt <= now()
    ) {
      return false;
    }
    if (
      query.keyword &&
      !room.code.toLowerCase().includes(query.keyword.toLowerCase())
    ) {
      return false;
    }
    return true;
  }

  function sortRooms(
    left: PersistedRoom,
    right: PersistedRoom,
    query: Pick<RoomListQuery, "sortBy" | "sortOrder">,
  ): number {
    const factor = query.sortOrder === "asc" ? 1 : -1;
    return (left[query.sortBy] - right[query.sortBy]) * factor;
  }

  return {
    async createRoom(input): Promise<PersistedRoom> {
      if (rooms.has(input.code)) {
        throw new Error(`Room ${input.code} already exists.`);
      }

      const room = createPersistedRoom(input);
      rooms.set(room.code, room);
      return cloneRoom(room);
    },
    async getRoom(code, _caller = "request"): Promise<PersistedRoom | null> {
      const room = rooms.get(code);
      return room ? cloneRoom(room) : null;
    },
    async updateRoom(code, expectedVersion, patch): Promise<RoomUpdateResult> {
      const currentRoom = rooms.get(code);
      if (!currentRoom) {
        return { ok: false, reason: "not_found" };
      }
      if (currentRoom.version !== expectedVersion) {
        return { ok: false, reason: "version_conflict" };
      }

      const nextRoom: PersistedRoom = {
        ...currentRoom,
        ...patch,
        version: currentRoom.version + 1,
        lastActiveAt: patch.lastActiveAt ?? now(),
      };
      rooms.set(code, nextRoom);
      return { ok: true, room: cloneRoom(nextRoom) };
    },
    async deleteRoom(code): Promise<boolean> {
      return rooms.delete(code);
    },
    async deleteExpiredRooms(currentTime): Promise<ExpiredRoomSweep> {
      const deletedRoomCodes: string[] = [];
      for (const [code, room] of rooms.entries()) {
        if (room.expiresAt !== null && room.expiresAt <= currentTime) {
          rooms.delete(code);
          deletedRoomCodes.push(code);
        }
      }
      // A room and its index entry are the same Map entry here, so this
      // implementation cannot produce an orphan; only the Redis store keeps
      // the two apart.
      return { deletedRoomCodes, orphanedIndexCodes: [] };
    },
    async listRooms(query) {
      const items = Array.from(rooms.values())
        .filter((room) => matchesQuery(room, query))
        .sort((left, right) => sortRooms(left, right, query));
      const start = (query.page - 1) * query.pageSize;
      return items.slice(start, start + query.pageSize).map(cloneRoom);
    },
    async countRooms(query) {
      return Array.from(rooms.values()).filter((room) =>
        matchesQuery(room, query),
      ).length;
    },
    async isReady() {
      return true;
    },
  };
}

export function roomStateOf(
  room: PersistedRoom,
  activeRoom: ActiveRoom | null,
): RoomStoreRoomState {
  return roomStateFromSessions(
    room,
    Array.from(activeRoom?.members.values() ?? []),
  );
}

export function roomStateFromSessions(
  room: PersistedRoom,
  sessions: Array<{
    id: string;
    memberId: string | null;
    displayName: string;
    joinedAt?: number | null;
    /** Required to be a member: see the residue filter below. */
    roomCode: string | null;
  }>,
): RoomStoreRoomState {
  const members = new Map<string, { id: string; name: string }>();
  const candidates: SharedVideoOwnerCandidate[] = [];
  for (const session of sessions) {
    // A session that does not name this room is index residue, not a member.
    // Removing a session from a room's index is the ONE write keyed on the old
    // room code, and nothing afterwards remembers that code — a leave or switch
    // whose cleanup failed leaves the id in that room's set forever, and the
    // session it loads then rejoins the roster and can win the share back
    // (#235 review).
    //
    // `roomCode: null` counts as residue too, which is what makes this cover an
    // explicit leave: `onRoomLeft` re-registers the session with its room
    // already cleared, so a failed index write leaves exactly that shape behind.
    // Safe because a join writes the hash's `roomCode` and the room-set entry in
    // ONE transaction (`markSessionJoinedRoom`) — a session in the set always
    // names the room it is in, so no in-flight join can be mistaken for residue.
    if ((session.roomCode ?? null) !== room.code) {
      continue;
    }
    const memberId = session.memberId ?? session.id;
    members.set(memberId, {
      id: memberId,
      name: session.displayName,
    });
    candidates.push({ id: memberId, joinedAt: session.joinedAt });
  }

  return {
    roomCode: room.code,
    sharedVideo: withResolvedSharedOwner(room.sharedVideo, members, candidates),
    playback: room.playback,
    members: Array.from(members.values()),
  };
}

/**
 * The one place `sharedVideo` reaches a client, so the one place share
 * ownership is resolved against the live member list (#235). Every `room:state`
 * is built from `roomStateFromSessions`, and the persisted room is left alone —
 * see `resolveSharedVideoOwnerId` for why ownership is derived and not stored.
 *
 * `sharedByDisplayName` moves with the id. It is only a fallback for a name the
 * member list cannot supply, and the successor is by construction in that list,
 * so leaving the previous sharer's name behind would not change what a client
 * renders — it would just leave a contradiction in the payload for the next
 * reader to trip over.
 */
function withResolvedSharedOwner(
  sharedVideo: SharedVideo | null,
  members: ReadonlyMap<string, { id: string; name: string }>,
  candidates: readonly SharedVideoOwnerCandidate[],
): SharedVideo | null {
  if (!sharedVideo) {
    return null;
  }
  const ownerId = resolveSharedVideoOwnerId(
    sharedVideo.sharedByMemberId,
    candidates,
  );
  if (ownerId === sharedVideo.sharedByMemberId) {
    return sharedVideo;
  }
  return {
    ...sharedVideo,
    sharedByMemberId: ownerId,
    sharedByDisplayName:
      (ownerId ? members.get(ownerId)?.name : undefined) ??
      sharedVideo.sharedByDisplayName,
  };
}
