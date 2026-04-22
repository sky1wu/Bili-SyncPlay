import assert from "node:assert/strict";
import {
  createSyncServer,
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
  type SecurityConfig,
} from "../../server/src/app.js";
import {
  closeClient,
  connectClient,
  createMultiNodeTestKit,
  MULTI_NODE_ALLOWED_ORIGIN,
} from "../../server/test/multi-node-test-kit.js";
import { type RawData } from "ws";

type Collector = {
  next: (type: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  maybeNext: (
    type: string,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown> | null>;
  detach: () => void;
};

export type RoomParticipant = {
  displayName: string;
  wsUrl: string;
  socket: Awaited<ReturnType<typeof connectClient>>;
  inbox: Collector;
  memberToken: string;
  memberId?: string;
};

export type RoomBenchmarkEnvironment = {
  roomCode: string;
  joinToken: string;
  owner: RoomParticipant;
  joiners: RoomParticipant[];
  cleanup: () => Promise<void>;
  nodeMode: "single-node" | "multi-node";
};

type BenchmarkServer = {
  wsUrl: string;
  cleanup: () => Promise<void>;
};

const SHARED_VIDEO_URL = "https://www.bilibili.com/video/BV1xx411c7mD?p=1";
const SHARED_VIDEO_TITLE = "Benchmark Episode";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createBenchmarkSecurityConfig(input: {
  memberCount: number;
  updatesPerSecond?: number;
}): SecurityConfig {
  const defaults = getDefaultSecurityConfig();
  const requiredMemberCapacity = Math.max(1, input.memberCount);
  const requiredConnections = requiredMemberCapacity + 2;
  const requiredJoinRate = requiredMemberCapacity + 2;
  const requiredPlaybackRate = Math.max(
    defaults.rateLimits.playbackUpdatePerSecond,
    (input.updatesPerSecond ?? defaults.rateLimits.playbackUpdatePerSecond) + 2,
  );

  return {
    ...defaults,
    allowedOrigins: [MULTI_NODE_ALLOWED_ORIGIN],
    maxMembersPerRoom: Math.max(
      defaults.maxMembersPerRoom,
      requiredMemberCapacity,
    ),
    maxConnectionsPerIp: Math.max(
      defaults.maxConnectionsPerIp,
      requiredConnections,
    ),
    connectionAttemptsPerMinute: Math.max(
      defaults.connectionAttemptsPerMinute,
      requiredConnections * 3,
    ),
    rateLimits: {
      ...defaults.rateLimits,
      roomJoinPerMinute: Math.max(
        defaults.rateLimits.roomJoinPerMinute,
        requiredJoinRate,
      ),
      playbackUpdatePerSecond: requiredPlaybackRate,
      playbackUpdateBurst: Math.max(
        defaults.rateLimits.playbackUpdateBurst,
        requiredPlaybackRate + 4,
      ),
    },
  };
}

function createBenchMessageCollector(
  socket: Awaited<ReturnType<typeof connectClient>>,
): Collector {
  const queuedMessages: Array<Record<string, unknown>> = [];
  const listener = (raw: RawData) => {
    queuedMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
  };
  socket.on("message", listener);

  return {
    async next(type: string, timeoutMs = 2_000) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const index = queuedMessages.findIndex(
          (message) => message.type === type,
        );
        if (index >= 0) {
          return queuedMessages.splice(index, 1)[0] as Record<string, unknown>;
        }
        await wait(10);
      }
      throw new Error(`Timed out waiting for message type ${type}`);
    },
    async maybeNext(type: string, timeoutMs = 200) {
      try {
        return await this.next(type, timeoutMs);
      } catch {
        return null;
      }
    },
    detach() {
      socket.off("message", listener);
      queuedMessages.length = 0;
    },
  };
}

async function listenSingleNode(
  securityConfig: SecurityConfig,
): Promise<BenchmarkServer> {
  const server = await createSyncServer(
    securityConfig,
    getDefaultPersistenceConfig(),
    {
      logEvent: () => {},
      serviceVersion: "0.0.0-bench-single-node",
      adminUiConfig: { enabled: false, demoEnabled: false },
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.httpServer.listen(0, "127.0.0.1", () => resolve());
    server.httpServer.once("error", reject);
  });

  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve single-node benchmark address.");
  }

  return {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    cleanup: () => server.close(),
  };
}

async function connectParticipants(
  memberCount: number,
  resolveWsUrl: (index: number) => string,
) {
  const sockets = await Promise.all(
    Array.from({ length: memberCount }, async (_, index) => {
      const wsUrl = resolveWsUrl(index);
      const socket = await connectClient(wsUrl);
      return {
        displayName: `Bench Member ${String(index + 1).padStart(3, "0")}`,
        wsUrl,
        socket,
        inbox: createBenchMessageCollector(socket),
      };
    }),
  );

  return sockets;
}

export async function setupRoomBenchmark(input: {
  memberCount: number;
  redisUrl?: string;
  mode: "single-node" | "multi-node";
  updatesPerSecond?: number;
}): Promise<RoomBenchmarkEnvironment> {
  let cleanup: (() => Promise<void>) | undefined;
  const securityConfig = createBenchmarkSecurityConfig({
    memberCount: input.memberCount,
    updatesPerSecond: input.updatesPerSecond,
  });

  try {
    if (input.mode === "single-node") {
      const server = await listenSingleNode(securityConfig);
      cleanup = server.cleanup;
      const participants = await connectParticipants(
        input.memberCount,
        () => server.wsUrl,
      );
      return await initializeRoom(participants, cleanup, "single-node");
    }

    assert.ok(input.redisUrl, "redisUrl is required in multi-node mode.");
    const testKit = await createMultiNodeTestKit(input.redisUrl, {
      securityConfig,
    });
    cleanup = () => testKit.closeAll();
    const ownerNode = await testKit.startRoomNode("bench-node-a");
    const memberNode = await testKit.startRoomNode("bench-node-b");
    const participants = await connectParticipants(
      input.memberCount,
      (index) => (index === 0 ? ownerNode.wsUrl : memberNode.wsUrl),
    );
    return await initializeRoom(participants, cleanup, "multi-node");
  } catch (error) {
    if (cleanup) {
      await cleanup();
    }
    throw error;
  }
}

async function initializeRoom(
  participants: Array<{
    displayName: string;
    wsUrl: string;
    socket: Awaited<ReturnType<typeof connectClient>>;
    inbox: Collector;
  }>,
  cleanup: () => Promise<void>,
  nodeMode: "single-node" | "multi-node",
): Promise<RoomBenchmarkEnvironment> {
  const [ownerSeed, ...joinerSeeds] = participants;
  if (!ownerSeed) {
    throw new Error("At least one room participant is required.");
  }

  ownerSeed.socket.send(
    JSON.stringify({
      type: "room:create",
      payload: { displayName: ownerSeed.displayName },
    }),
  );

  const created = await ownerSeed.inbox.next("room:created");
  await ownerSeed.inbox.next("room:state");

  const createdPayload = created.payload as {
    roomCode: string;
    joinToken: string;
    memberToken: string;
    memberId: string;
  };

  const joiners: RoomParticipant[] = [];
  for (const joinerSeed of joinerSeeds) {
    joinerSeed.socket.send(
      JSON.stringify({
        type: "room:join",
        payload: {
          roomCode: createdPayload.roomCode,
          joinToken: createdPayload.joinToken,
          displayName: joinerSeed.displayName,
        },
      }),
    );

    const joined = await joinerSeed.inbox.next("room:joined");
    await joinerSeed.inbox.next("room:state");
    await ownerSeed.inbox.next("room:state");

    const joinedPayload = joined.payload as {
      memberToken: string;
    };
    joiners.push({
      ...joinerSeed,
      memberToken: joinedPayload.memberToken,
    });
  }

  const owner: RoomParticipant = {
    ...ownerSeed,
    memberToken: createdPayload.memberToken,
    memberId: createdPayload.memberId,
  };

  owner.socket.send(
    JSON.stringify({
      type: "video:share",
      payload: {
        memberToken: owner.memberToken,
        video: {
          videoId: "BV1xx411c7mD",
          url: SHARED_VIDEO_URL,
          title: SHARED_VIDEO_TITLE,
        },
        playback: {
          url: SHARED_VIDEO_URL,
          currentTime: 0,
          playState: "paused",
          playbackRate: 1,
          updatedAt: Date.now(),
          serverTime: 0,
          actorId: owner.memberId,
          seq: 1,
        },
      },
    }),
  );

  await owner.inbox.next("room:state");
  await Promise.all(joiners.map((joiner) => joiner.inbox.next("room:state")));

  return {
    roomCode: createdPayload.roomCode,
    joinToken: createdPayload.joinToken,
    owner,
    joiners,
    nodeMode,
    cleanup: async () => {
      const allParticipants = [owner, ...joiners];
      await Promise.all(
        allParticipants.map((participant) => closeClient(participant.socket)),
      );
      await cleanup();
    },
  };
}

export function attachPlaybackLatencyObservers(
  watchers: RoomParticipant[],
  onPlayback: (watcherIndex: number, seq: number, receivedAtMs: number) => void,
) {
  const listeners = watchers.map((watcher, watcherIndex) => {
    const listener = (raw: RawData) => {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        payload?: {
          playback?: {
            seq?: number;
          };
        };
      };

      const seq = message.payload?.playback?.seq;
      if (message.type === "room:state" && typeof seq === "number") {
        onPlayback(watcherIndex, seq, Date.now());
      }
    };

    watcher.socket.on("message", listener);
    return { watcher, listener };
  });

  return () => {
    for (const { watcher, listener } of listeners) {
      watcher.socket.off("message", listener);
    }
  };
}

function detachParticipantCollectors(participants: RoomParticipant[]) {
  for (const participant of participants) {
    participant.inbox.detach();
  }
}

export async function runPlaybackBroadcastBenchmark(input: {
  scenario: "single-node-room" | "redis-broadcast";
  memberCount: number;
  durationSeconds: number;
  updatesPerSecond: number;
  watcherCount: number;
  redisUrl?: string;
}) {
  const environment = await setupRoomBenchmark({
    memberCount: input.memberCount,
    redisUrl: input.redisUrl,
    mode: input.scenario === "redis-broadcast" ? "multi-node" : "single-node",
    updatesPerSecond: input.updatesPerSecond,
  });

  const sampledWatcherCount = Math.max(
    0,
    Math.min(input.watcherCount, environment.joiners.length),
  );
  const watchers = environment.joiners.slice(0, sampledWatcherCount);
  detachParticipantCollectors([environment.owner, ...environment.joiners]);
  const latencySamplesMs: number[] = [];
  const pendingWatchersBySeq = new Map<number, Set<number>>();
  const sentAtBySeq = new Map<number, number>();
  let errors = 0;
  let completed = 0;
  let attempted = 0;

  const detachObservers = attachPlaybackLatencyObservers(
    watchers,
    (watcherIndex, seq, receivedAtMs) => {
      const sentAtMs = sentAtBySeq.get(seq);
      const pending = pendingWatchersBySeq.get(seq);
      if (sentAtMs === undefined || !pending || !pending.has(watcherIndex)) {
        return;
      }

      pending.delete(watcherIndex);
      latencySamplesMs.push(receivedAtMs - sentAtMs);
      completed += 1;

      if (pending.size === 0) {
        pendingWatchersBySeq.delete(seq);
        sentAtBySeq.delete(seq);
      }
    },
  );

  const startedAtMs = Date.now();
  const totalUpdates = Math.max(
    1,
    Math.round(input.durationSeconds * input.updatesPerSecond),
  );
  const intervalMs = 1_000 / input.updatesPerSecond;
  let completedAtMs = startedAtMs;

  try {
    for (let index = 0; index < totalUpdates; index += 1) {
      const seq = index + 2;
      if (watchers.length > 0) {
        pendingWatchersBySeq.set(
          seq,
          new Set(Array.from({ length: watchers.length }, (_, id) => id)),
        );
      }

      const sentAtMs = Date.now();
      if (watchers.length > 0) {
        sentAtBySeq.set(seq, sentAtMs);
      }
      attempted += watchers.length;

      environment.owner.socket.send(
        JSON.stringify({
          type: "playback:update",
          payload: {
            memberToken: environment.owner.memberToken,
            playback: {
              url: SHARED_VIDEO_URL,
              currentTime: index / input.updatesPerSecond,
              playState: index % 2 === 0 ? "playing" : "paused",
              playbackRate: 1,
              updatedAt: sentAtMs,
              serverTime: 0,
              actorId: environment.owner.memberId,
              seq,
            },
          },
        }),
      );

      const nextTickAt = startedAtMs + Math.round((index + 1) * intervalMs);
      const delayMs = nextTickAt - Date.now();
      if (delayMs > 0) {
        await wait(delayMs);
      }
    }

    const drainDeadline = Date.now() + 5_000;
    while (pendingWatchersBySeq.size > 0 && Date.now() < drainDeadline) {
      await wait(20);
    }

    for (const pending of pendingWatchersBySeq.values()) {
      errors += pending.size;
    }
    completedAtMs = Date.now();
  } finally {
    detachObservers();
    await environment.cleanup();
  }

  return {
    attempted,
    completed,
    errors,
    latencySamplesMs,
    watcherCount: watchers.length,
    startedAtMs,
    completedAtMs,
    nodeMode: environment.nodeMode,
  };
}

export async function runReconnectStormBenchmark(input: {
  memberCount: number;
  reconnectTimeoutMs: number;
}) {
  const environment = await setupRoomBenchmark({
    memberCount: input.memberCount,
    mode: "single-node",
  });

  const seeds = [environment.owner, ...environment.joiners].map(
    (participant) => ({
      displayName: participant.displayName,
      memberToken: participant.memberToken,
      wsUrl: participant.wsUrl,
    }),
  );

  await Promise.all(
    [environment.owner, ...environment.joiners].map((participant) =>
      closeClient(participant.socket),
    ),
  );
  await wait(100);

  const startedAtMs = Date.now();
  const latencySamplesMs: number[] = [];
  let completed = 0;
  let errors = 0;
  let completedAtMs = startedAtMs;
  const reconnectSockets: Array<Awaited<ReturnType<typeof connectClient>>> = [];

  detachParticipantCollectors([environment.owner, ...environment.joiners]);

  try {
    await Promise.all(
      seeds.map(async (seed) => {
        const reconnectStartedAtMs = Date.now();
        let socket: Awaited<ReturnType<typeof connectClient>> | undefined;
        let inbox: Collector | undefined;

        try {
          socket = await connectClient(seed.wsUrl);
          inbox = createBenchMessageCollector(socket);
          socket.send(
            JSON.stringify({
              type: "room:join",
              payload: {
                roomCode: environment.roomCode,
                joinToken: environment.joinToken,
                displayName: seed.displayName,
                memberToken: seed.memberToken,
              },
            }),
          );
          await inbox.next("room:joined", input.reconnectTimeoutMs);
          await inbox.next("room:state", input.reconnectTimeoutMs);
          latencySamplesMs.push(Date.now() - reconnectStartedAtMs);
          completed += 1;
        } catch {
          errors += 1;
        } finally {
          inbox?.detach?.();
          if (socket) {
            reconnectSockets.push(socket);
          }
        }
      }),
    );
    completedAtMs = Date.now();
  } finally {
    await Promise.all(reconnectSockets.map((socket) => closeClient(socket)));
    await environment.cleanup();
  }

  return {
    attempted: seeds.length,
    completed,
    errors,
    latencySamplesMs,
    startedAtMs,
    completedAtMs,
  };
}
