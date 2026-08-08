import {
  createMaintenancePass,
  type MaintenancePassFailureReason,
} from "./maintenance-pass.js";
import type { LogEvent, ClusterNodeStatus } from "./types.js";
import type { RuntimeStore } from "./runtime-store.js";

/**
 * Exactly what a beat touches, and no more.
 *
 * Narrow on purpose, same reason as `runtime-index-reaper`'s: a fake that has
 * to satisfy the whole `RuntimeStore` gets cast past the checker instead, and
 * the cast then swallows every later change to the contracts these tests exist
 * to pin.
 */
export type NodeHeartbeatRuntimeStore = Pick<
  RuntimeStore,
  | "getStartedAt"
  | "getConnectionCount"
  | "getActiveRoomCount"
  | "getActiveMemberCount"
  | "heartbeatNode"
>;

export type NodeHeartbeat = {
  start: () => void;
  /**
   * Beat once now, under the same cap and the same overlap rule as the timer.
   *
   * Does NOT reject on a failed write: like every other pass, the outcome is
   * reported through `node_heartbeat_failed` — a heartbeat whose caller has to
   * remember to catch is how this stayed silent for a whole class of failure
   * (#263).
   */
  beat: () => Promise<void>;
  stop: () => Promise<void>;
};

const HEARTBEAT_FAILURE_REASON: Record<
  Exclude<MaintenancePassFailureReason, "overlapped">,
  string
> = {
  run_failed: "node_heartbeat_write_failed",
  timed_out: "node_heartbeat_write_timeout",
  stalled: "node_heartbeat_write_stalled",
};

/**
 * Caps ONE beat, derived from the two settings that decide what a late beat
 * costs (#263).
 *
 * `heartbeatNode` is a direct `MULTI` on the shared runtime store — it does not
 * go through the write queue, so nothing else on that path bounds it, and a
 * half-open connection used to leave the beat pending forever: no
 * `node_heartbeat_sent`, no `node_heartbeat_failed`, and the node quietly
 * ageing out of the cluster index while it was still serving clients.
 *
 * Half an interval, and never more than a third of the TTL. Both halves matter:
 *
 * - **Below the interval**, so a beat that has not answered is reported before
 *   the next one is due — which also means the tick after a timeout reports
 *   `stalled` rather than `overlapped`, the ordering the runbook reads.
 * - **Well below the TTL**, so the log line lands long before other nodes can
 *   call this one stale (`staleAt`) or offline (`expiresAt`). A cap that fired
 *   at the same time as the expiry would answer a question nobody could still
 *   act on.
 */
export function heartbeatTimeoutMs(intervalMs: number, ttlMs: number): number {
  return Math.max(1, Math.min(intervalMs / 2, ttlMs / 3));
}

export function createNodeHeartbeat(options: {
  enabled: boolean;
  instanceId: string;
  serviceVersion: string;
  runtimeStore: NodeHeartbeatRuntimeStore;
  intervalMs: number;
  ttlMs: number;
  now?: () => number;
  logEvent?: LogEvent;
}): NodeHeartbeat {
  const now = options.now ?? Date.now;
  const staleAfterMs = Math.max(
    options.intervalMs,
    Math.min(options.ttlMs, options.intervalMs * 2),
  );
  const timeoutMs = heartbeatTimeoutMs(options.intervalMs, options.ttlMs);

  const pass = createMaintenancePass<ClusterNodeStatus, void>({
    name: "node heartbeat",
    intervalMs: options.intervalMs,
    timeoutMs,
    // The caller owns the enable flag, so the timer is armed from `start()`
    // rather than from construction.
    autoStart: false,
    // A heartbeat is not work the process should stay alive for: it only
    // reports state, and the shutdown path stops it explicitly. Same as before
    // this moved onto the shared driver.
    unrefTimer: true,
    run: async () => {
      const currentTime = now();
      const status: ClusterNodeStatus = {
        instanceId: options.instanceId,
        version: options.serviceVersion,
        startedAt: options.runtimeStore.getStartedAt(),
        lastHeartbeatAt: currentTime,
        staleAt: currentTime + staleAfterMs,
        expiresAt: currentTime + options.ttlMs,
        connectionCount: options.runtimeStore.getConnectionCount(),
        activeRoomCount: options.runtimeStore.getActiveRoomCount(),
        activeMemberCount: options.runtimeStore.getActiveMemberCount(),
        health: "ok",
      };
      await options.runtimeStore.heartbeatNode(status);
      return status;
    },
    onSuccess: (status) => {
      options.logEvent?.("node_heartbeat_sent", {
        instanceId: status.instanceId,
        version: status.version,
        connectionCount: status.connectionCount,
        activeRoomCount: status.activeRoomCount,
        activeMemberCount: status.activeMemberCount,
        ttlMs: options.ttlMs,
        result: "ok",
      });
    },
    onFailure: ({ reason, error }) => {
      if (reason === "overlapped") {
        // Unreachable while the cap stays below the interval — kept because the
        // driver's contract allows it and a silent fall-through would hide a
        // future change to `heartbeatTimeoutMs`.
        options.logEvent?.("node_heartbeat_skipped", {
          instanceId: options.instanceId,
          timeoutMs,
          result: "ignored",
        });
        return;
      }
      options.logEvent?.("node_heartbeat_failed", {
        instanceId: options.instanceId,
        reason: HEARTBEAT_FAILURE_REASON[reason],
        // Only where the cap produced the record; on a write that threw it
        // would name a limit nothing came near.
        ...(reason === "run_failed" ? {} : { timeoutMs }),
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    },
    onSettleTimeout: ({ pendingCalls, budgetMs }) => {
      // Shutdown goes on to close the runtime store, so this says an EXEC is
      // still on the connection `redis.quit()` will close. Until the cap
      // existed the same situation showed up as a `stop_node_heartbeat` that
      // timed out; a bounded stop has to say it in its own words.
      options.logEvent?.("node_heartbeat_abandoned_at_shutdown", {
        instanceId: options.instanceId,
        pendingBeats: pendingCalls,
        budgetMs,
        result: "timeout",
      });
    },
  });

  let started = false;

  return {
    start() {
      // Idempotent, and the flag is this function's own — `pass.start()` only
      // guards the timer, so keying off it would let a second `start()` fire
      // another immediate beat (and, while the first is in flight, report it as
      // skipped). The old implementation returned early on `timer` existing;
      // that guarantee has to survive the move to the shared driver.
      if (!options.enabled || started) {
        return;
      }
      started = true;
      pass.start();
      // Immediately, not one interval from now: the cluster index should carry
      // this node from the moment it starts serving, not from the first tick.
      void pass.runNow().catch(() => undefined);
    },
    async beat() {
      if (!options.enabled) {
        return;
      }
      await pass.runNow();
    },
    async stop() {
      await pass.stop();
    },
  };
}
