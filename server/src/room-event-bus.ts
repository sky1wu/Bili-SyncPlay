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
      type: "room_deleted";
      roomCode: string;
      sourceInstanceId: string;
      emittedAt: number;
    };

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
