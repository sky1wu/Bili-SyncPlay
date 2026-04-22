import { buildBenchmarkResult, type BenchmarkResult } from "./cli.js";
import { ensureRedis } from "./redis-harness.js";
import {
  runPlaybackBroadcastBenchmark,
  runReconnectStormBenchmark,
} from "./room-bench.js";

export type SingleNodeRoomScenarioInput = {
  memberCount: number;
  durationSeconds: number;
  updatesPerSecond: number;
  watcherCount: number;
};

export type RedisBroadcastScenarioInput = SingleNodeRoomScenarioInput;

export type ReconnectStormScenarioInput = {
  memberCount: number;
  reconnectTimeoutMs: number;
};

export async function runSingleNodeRoomScenario(
  input: SingleNodeRoomScenarioInput,
): Promise<BenchmarkResult> {
  const benchmark = await runPlaybackBroadcastBenchmark({
    scenario: "single-node-room",
    memberCount: input.memberCount,
    durationSeconds: input.durationSeconds,
    updatesPerSecond: input.updatesPerSecond,
    watcherCount: input.watcherCount,
  });

  return buildBenchmarkResult({
    scenario: "single-node-room",
    startedAtMs: benchmark.startedAtMs,
    completedAtMs: benchmark.completedAtMs,
    attempted: benchmark.attempted,
    completed: benchmark.completed,
    errors: benchmark.errors,
    latencySamplesMs: benchmark.latencySamplesMs,
    config: {
      memberCount: input.memberCount,
      durationSeconds: input.durationSeconds,
      updatesPerSecond: input.updatesPerSecond,
      sampledWatchers: benchmark.watcherCount,
      nodeMode: benchmark.nodeMode,
    },
    notes: [
      "Latency samples are collected from a subset of watcher sockets.",
      "Throughput counts sampled playback deliveries rather than total room broadcasts.",
    ],
  });
}

export async function runRedisBroadcastScenario(
  input: RedisBroadcastScenarioInput,
): Promise<BenchmarkResult> {
  const redis = await ensureRedis(true);

  try {
    const benchmark = await runPlaybackBroadcastBenchmark({
      scenario: "redis-broadcast",
      memberCount: input.memberCount,
      durationSeconds: input.durationSeconds,
      updatesPerSecond: input.updatesPerSecond,
      watcherCount: input.watcherCount,
      redisUrl: redis.redisUrl,
    });

    return buildBenchmarkResult({
      scenario: "redis-broadcast",
      startedAtMs: benchmark.startedAtMs,
      completedAtMs: benchmark.completedAtMs,
      attempted: benchmark.attempted,
      completed: benchmark.completed,
      errors: benchmark.errors,
      latencySamplesMs: benchmark.latencySamplesMs,
      config: {
        memberCount: input.memberCount,
        durationSeconds: input.durationSeconds,
        updatesPerSecond: input.updatesPerSecond,
        sampledWatchers: benchmark.watcherCount,
        nodeMode: benchmark.nodeMode,
        redisMode: redis.mode,
      },
      notes: [
        "Owner traffic is pinned to node A and followers to node B to emphasize cross-node fan-out.",
        "Latency samples are collected from watcher sockets attached to the remote node.",
      ],
    });
  } finally {
    await redis.cleanup();
  }
}

export async function runReconnectStormScenario(
  input: ReconnectStormScenarioInput,
): Promise<BenchmarkResult> {
  const benchmark = await runReconnectStormBenchmark({
    memberCount: input.memberCount,
    reconnectTimeoutMs: input.reconnectTimeoutMs,
  });

  return buildBenchmarkResult({
    scenario: "reconnect-storm",
    startedAtMs: benchmark.startedAtMs,
    completedAtMs: benchmark.completedAtMs,
    attempted: benchmark.attempted,
    completed: benchmark.completed,
    errors: benchmark.errors,
    latencySamplesMs: benchmark.latencySamplesMs,
    config: {
      memberCount: input.memberCount,
      reconnectTimeoutMs: input.reconnectTimeoutMs,
      nodeMode: "single-node",
    },
    notes: [
      "Each reconnect latency measures socket open plus room rejoin until the first room state arrives.",
    ],
  });
}
