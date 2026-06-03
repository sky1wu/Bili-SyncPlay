export type RoomEventBusMessage =
  | {
      type: "room_state_updated";
      roomCode: string;
      sourceInstanceId: string;
      emittedAt: number;
    }
  | {
      type: "room_member_changed";
      roomCode: string;
      sourceInstanceId: string;
      emittedAt: number;
    }
  | {
      type: "room_member_joined";
      roomCode: string;
      sourceInstanceId: string;
      emittedAt: number;
      memberId: string;
      displayName: string;
    }
  | {
      type: "room_member_left";
      roomCode: string;
      sourceInstanceId: string;
      emittedAt: number;
      memberId: string;
      displayName: string;
    }
  | {
      type: "room_deleted";
      roomCode: string;
      sourceInstanceId: string;
      emittedAt: number;
    };

export type RoomEventType = RoomEventBusMessage["type"];

// Single source of truth for the set of room event types, used both for
// runtime iteration (e.g. pre-seeding per-type metrics to 0) and as a
// type-level exhaustiveness guard. The `satisfies` clause rejects invalid
// entries; the assertion below fails to compile if a new RoomEventBusMessage
// variant is added without being listed here.
export const ROOM_EVENT_TYPES = [
  "room_state_updated",
  "room_member_changed",
  "room_member_joined",
  "room_member_left",
  "room_deleted",
] as const satisfies readonly RoomEventType[];

type _EnsureAllRoomEventTypesCovered =
  Exclude<RoomEventType, (typeof ROOM_EVENT_TYPES)[number]> extends never
    ? true
    : never;
const _roomEventTypesAreExhaustive: _EnsureAllRoomEventTypesCovered = true;
void _roomEventTypesAreExhaustive;

export type RoomEventBus = {
  publish: (message: RoomEventBusMessage) => Promise<void>;
  subscribe: (
    handler: (message: RoomEventBusMessage) => Promise<void> | void,
  ) => Promise<() => Promise<void>>;
};

export function createNoopRoomEventBus(): RoomEventBus {
  return {
    async publish() {},
    async subscribe() {
      return async () => {};
    },
  };
}

export function createInMemoryRoomEventBus(): RoomEventBus {
  const subscribers = new Set<
    (message: RoomEventBusMessage) => Promise<void> | void
  >();

  return {
    async publish(message) {
      await Promise.allSettled(
        Array.from(subscribers, (subscriber) =>
          Promise.resolve(subscriber(message)),
        ),
      );
    },
    async subscribe(handler) {
      subscribers.add(handler);
      return async () => {
        subscribers.delete(handler);
      };
    },
  };
}
