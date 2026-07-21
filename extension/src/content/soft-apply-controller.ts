import type { PlaybackState } from "@bili-syncplay/protocol";
import {
  decidePlaybackReconcileMode,
  shouldTreatAsExplicitSeek,
} from "./playback-reconcile";
import {
  createProgrammaticPlaybackSignature,
  getPlayState,
  setVideoPlaybackRate,
} from "./player-binding";
import type {
  ContentRuntimeState,
  LocalPlaybackEventSource,
} from "./runtime-state";

const SOFT_APPLY_RECOVERY_THRESHOLD_SECONDS = 0.2;
const SOFT_APPLY_MIN_TIMEOUT_MS = 2_000;
const SOFT_APPLY_MAX_TIMEOUT_MS = 4_500;
const SOFT_APPLY_TIMEOUT_PER_SECOND_MS = 900;
const SOFT_APPLY_RTT_TIMEOUT_FACTOR = 2.5;
const SOFT_APPLY_TARGET_SHIFT_CANCEL_THRESHOLD_SECONDS = 0.6;
const SOFT_APPLY_COOLDOWN_MS = 2_500;
// Bounds for the rate-only relative-drift restore window (see
// computeRelativeDriftCloseMs).
const RATE_ONLY_MIN_RESTORE_MS = 600;
const RATE_ONLY_MAX_RESTORE_MS = 8_000;

export interface SoftApplyController {
  cancelActiveSoftApply(video: HTMLVideoElement | null, reason: string): void;
  maintainActiveSoftApply(video: HTMLVideoElement): void;
  upsertActiveSoftApply(
    playback: PlaybackState,
    remainingDriftSeconds: number,
    options?: {
      armCooldownOnConverge?: boolean;
      relativeDriftClose?: { driftSeconds: number; rateOffsetSeconds: number };
    },
  ): void;
  shouldCancelActiveSoftApplyForPlayback(
    playback: PlaybackState | null,
  ): string | null;
  shouldSuppressActiveSoftApplyBroadcast(input: {
    normalizedCurrentUrl: string | null;
    playState: PlaybackState["playState"];
    eventSource: LocalPlaybackEventSource;
    now: number;
  }): boolean;
  isActiveRateOnlyCatchUp(normalizedUrl: string | null): boolean;
  shouldSuppressByCooldown(
    video: HTMLVideoElement,
    playback: PlaybackState,
  ): boolean;
  clearSoftApplyCooldown(): void;
  destroy(): void;
}

export function createSoftApplyController(args: {
  runtimeState: ContentRuntimeState;
  normalizeUrl: (url: string | undefined | null) => string | null;
  getVideoElement: () => HTMLVideoElement | null;
  debugLog: (message: string) => void;
  userGestureGraceMs: number;
  programmaticApplyWindowMs: number;
  getNow?: () => number;
  armProgrammaticApplyWindow: (
    signature: ReturnType<typeof createProgrammaticPlaybackSignature>,
    reason: "pending" | "apply",
    actorId?: string,
  ) => void;
}): SoftApplyController {
  const nowOf = () => args.getNow?.() ?? Date.now();
  let activeSoftApply: {
    normalizedUrl: string;
    targetTime: number;
    restorePlaybackRate: number;
    deadlineAt: number;
    // Whether converging this session should arm the soft-apply cooldown. Only
    // true soft-apply sessions (which seek the playhead) warrant the cooldown;
    // a rate-only catch-up merely nudges the rate, so arming a cooldown for it
    // would wrongly suppress the next genuine remote reconcile and leave drift.
    armCooldownOnConverge: boolean;
    // Rate-only sessions restore by elapsed time (the rate offset absorbing the
    // initial drift) rather than by the playhead reaching the snapshot target:
    // the remote head keeps advancing, so converging on the stale target would
    // restore the base rate too early and leave residual drift behind.
    convergeByRelativeDrift: boolean;
    // When `targetTime` was captured. The remote head keeps advancing from it,
    // so any comparison against a *live* remote position has to age the
    // snapshot by the elapsed time first.
    startedAt: number;
  } | null = null;
  let activeSoftApplyTimer: number | null = null;

  function clearActiveSoftApplyState(): void {
    activeSoftApply = null;
    if (activeSoftApplyTimer !== null) {
      window.clearTimeout(activeSoftApplyTimer);
      activeSoftApplyTimer = null;
    }
  }

  function armSoftApplyCooldown(normalizedUrl: string, reason: string): void {
    args.runtimeState.softApplyCooldownUrl = normalizedUrl;
    args.runtimeState.softApplyCooldownUntil = nowOf() + SOFT_APPLY_COOLDOWN_MS;
    args.debugLog(
      `Soft apply cooldown armed url=${normalizedUrl} result=${reason} until=${args.runtimeState.softApplyCooldownUntil}`,
    );
  }

  function clearSoftApplyCooldown(): void {
    args.runtimeState.softApplyCooldownUntil = 0;
    args.runtimeState.softApplyCooldownUrl = null;
  }

  function computeSoftApplyTimeoutMs(remainingDriftSeconds: number): number {
    const networkAllowanceMs =
      args.runtimeState.rttMs === null
        ? 0
        : Math.round(args.runtimeState.rttMs * SOFT_APPLY_RTT_TIMEOUT_FACTOR);
    return Math.min(
      SOFT_APPLY_MAX_TIMEOUT_MS,
      Math.max(
        SOFT_APPLY_MIN_TIMEOUT_MS,
        Math.round(
          SOFT_APPLY_MIN_TIMEOUT_MS +
            networkAllowanceMs +
            Math.max(
              0,
              remainingDriftSeconds - SOFT_APPLY_RECOVERY_THRESHOLD_SECONDS,
            ) *
              SOFT_APPLY_TIMEOUT_PER_SECOND_MS,
        ),
      ),
    );
  }

  function cancelActiveSoftApply(
    video: HTMLVideoElement | null,
    reason: string,
  ): void {
    if (!activeSoftApply) {
      return;
    }

    const session = activeSoftApply;
    clearActiveSoftApplyState();
    // When the user explicitly changes the playback rate, they have taken over
    // the rate — restoring the stale snapshot rate here would silently undo
    // their change once the session deadline elapses, so skip the restore.
    if (
      reason !== "user-ratechange" &&
      video &&
      Math.abs(video.playbackRate - session.restorePlaybackRate) > 0.01
    ) {
      setVideoPlaybackRate(video, session.restorePlaybackRate);
      args.armProgrammaticApplyWindow(
        {
          url: session.normalizedUrl,
          playState: getPlayState(video, args.runtimeState.intendedPlayState),
          currentTime: video.currentTime,
          playbackRate: session.restorePlaybackRate,
        },
        "apply",
      );
    }
    if (
      session.armCooldownOnConverge &&
      (reason === "converged" ||
        reason === "apply-hard-seek" ||
        reason === "drift-closed")
    ) {
      // `drift-closed` is the relative-drift restore path. A pure rate-only
      // session has armCooldownOnConverge=false so it still won't arm here, but
      // a real soft-apply that wrote currentTime and was later re-upserted as a
      // rate-only nudge keeps the sticky flag and must still arm the cooldown.
      armSoftApplyCooldown(session.normalizedUrl, reason);
    } else if (
      args.runtimeState.softApplyCooldownUrl === session.normalizedUrl
    ) {
      clearSoftApplyCooldown();
    }
    args.debugLog(
      `Cancelled soft apply url=${session.normalizedUrl} target=${session.targetTime.toFixed(2)} result=${reason}`,
    );
  }

  function scheduleActiveSoftApplyTimeout(): void {
    if (!activeSoftApply) {
      return;
    }
    if (activeSoftApplyTimer !== null) {
      window.clearTimeout(activeSoftApplyTimer);
    }
    const delayMs = Math.max(0, activeSoftApply.deadlineAt - nowOf());
    activeSoftApplyTimer = window.setTimeout(() => {
      activeSoftApplyTimer = null;
      if (!activeSoftApply) {
        return;
      }
      const video = args.getVideoElement();
      // Mirror maintainActiveSoftApply: a relative-drift session reaching its
      // deadline via the timer (no timeupdate happened to fire first) must still
      // settle through the drift-closed path so a sticky cooldown is honored.
      cancelActiveSoftApply(
        video,
        activeSoftApply.convergeByRelativeDrift ? "drift-closed" : "timeout",
      );
    }, delayMs);
  }

  // Real time needed for the rate offset to absorb the initial drift while the
  // remote head keeps advancing: closing the *relative* drift takes
  // drift / rateOffset seconds. Bounded so a tiny offset cannot keep the rate
  // elevated forever and a large one still nudges for a perceptible moment.
  function computeRelativeDriftCloseMs(input: {
    driftSeconds: number;
    rateOffsetSeconds: number;
  }): number {
    const offset = Math.max(0.01, Math.abs(input.rateOffsetSeconds));
    const closeMs = (Math.abs(input.driftSeconds) / offset) * 1_000;
    return Math.min(
      RATE_ONLY_MAX_RESTORE_MS,
      Math.max(RATE_ONLY_MIN_RESTORE_MS, Math.round(closeMs)),
    );
  }

  function upsertActiveSoftApply(
    playback: PlaybackState,
    remainingDriftSeconds: number,
    options: {
      armCooldownOnConverge?: boolean;
      relativeDriftClose?: { driftSeconds: number; rateOffsetSeconds: number };
    } = {},
  ): void {
    const armCooldownOnConverge = options.armCooldownOnConverge ?? true;
    const convergeByRelativeDrift = options.relativeDriftClose !== undefined;
    const normalizedUrl = args.normalizeUrl(playback.url);
    if (!normalizedUrl) {
      clearActiveSoftApplyState();
      return;
    }
    const timeoutMs = options.relativeDriftClose
      ? computeRelativeDriftCloseMs(options.relativeDriftClose)
      : computeSoftApplyTimeoutMs(remainingDriftSeconds);
    const sameSession =
      activeSoftApply !== null &&
      activeSoftApply.normalizedUrl === normalizedUrl;
    const restorePlaybackRate = sameSession
      ? activeSoftApply!.restorePlaybackRate
      : playback.playbackRate;
    // The cooldown flag is sticky within a session: once a real soft-apply has
    // run on this url, keep arming the cooldown even if a later rate-only nudge
    // re-upserts the same session.
    const nextArmCooldownOnConverge =
      (sameSession && activeSoftApply!.armCooldownOnConverge) ||
      armCooldownOnConverge;
    activeSoftApply = {
      normalizedUrl,
      targetTime: playback.currentTime,
      restorePlaybackRate,
      deadlineAt: nowOf() + timeoutMs,
      armCooldownOnConverge: nextArmCooldownOnConverge,
      convergeByRelativeDrift,
      startedAt: nowOf(),
    };
    scheduleActiveSoftApplyTimeout();
    args.debugLog(
      `Started soft apply url=${normalizedUrl} target=${playback.currentTime.toFixed(2)} rate=${restorePlaybackRate.toFixed(2)} timeout=${timeoutMs} cooldown=${nextArmCooldownOnConverge} relativeDrift=${convergeByRelativeDrift}`,
    );
  }

  function shouldCancelActiveSoftApplyForPlayback(
    playback: PlaybackState | null,
  ): string | null {
    if (!activeSoftApply) {
      return null;
    }
    if (!playback) {
      return "missing-playback";
    }

    const normalizedUrl = args.normalizeUrl(playback.url);
    if (!normalizedUrl || normalizedUrl !== activeSoftApply.normalizedUrl) {
      return "url-changed";
    }
    // `buffering` is a transient stall of the *sender*, not a change to where
    // the room is. Cancelling on it lets any member's hiccup abort a healthy
    // member's drift convergence — the catch-up would restore its base rate and
    // leave the residual behind, which is the ratchet #185 removed. Only a real
    // `paused` (or any other non-playing state) ends the session.
    if (
      playback.playState !== "playing" &&
      playback.playState !== "buffering"
    ) {
      return "play-state-changed";
    }
    if (
      shouldTreatAsExplicitSeek({
        syncIntent: playback.syncIntent,
        playState: playback.playState,
      })
    ) {
      return "explicit-seek";
    }
    if (
      Math.abs(playback.playbackRate - activeSoftApply.restorePlaybackRate) >
      0.01
    ) {
      return "rate-changed";
    }
    // `targetTime` is a snapshot of the remote head taken when the session
    // started, but the peer keeps playing. Comparing a live remote position
    // against the frozen snapshot makes every routine heartbeat look like a
    // jump once more than SOFT_APPLY_TARGET_SHIFT_CANCEL_THRESHOLD_SECONDS of
    // content has elapsed — for a peer playing steadily and heartbeating every
    // couple of seconds that is guaranteed to happen long before a catch-up can
    // converge, so the session was always killed early and left residual drift
    // behind. Age the snapshot by the elapsed wall time so this only fires for a
    // genuine unannounced jump. (Announced ones are caught by the `explicit-seek`
    // check above, and a stalled/paused peer by `play-state-changed`.)
    const elapsedSeconds = Math.max(
      0,
      (nowOf() - activeSoftApply.startedAt) / 1_000,
    );
    const expectedTargetTime =
      activeSoftApply.targetTime +
      elapsedSeconds * activeSoftApply.restorePlaybackRate;
    if (
      Math.abs(playback.currentTime - expectedTargetTime) >
      SOFT_APPLY_TARGET_SHIFT_CANCEL_THRESHOLD_SECONDS
    ) {
      return "target-shifted";
    }
    return null;
  }

  function maintainActiveSoftApply(video: HTMLVideoElement): void {
    if (!activeSoftApply) {
      return;
    }
    if (nowOf() >= activeSoftApply.deadlineAt) {
      cancelActiveSoftApply(
        video,
        activeSoftApply.convergeByRelativeDrift ? "drift-closed" : "timeout",
      );
      return;
    }
    // Rate-only sessions never converge on the stale snapshot target — the
    // remote head has moved on. They restore once the relative-drift close
    // deadline above elapses.
    if (activeSoftApply.convergeByRelativeDrift) {
      return;
    }
    if (
      Math.abs(video.currentTime - activeSoftApply.targetTime) <=
      SOFT_APPLY_RECOVERY_THRESHOLD_SECONDS
    ) {
      cancelActiveSoftApply(video, "converged");
    }
  }

  function shouldSuppressActiveSoftApplyBroadcast(input: {
    normalizedCurrentUrl: string | null;
    playState: PlaybackState["playState"];
    eventSource: LocalPlaybackEventSource;
    now: number;
  }): boolean {
    if (
      !activeSoftApply ||
      input.now >= activeSoftApply.deadlineAt ||
      !input.normalizedCurrentUrl ||
      input.normalizedCurrentUrl !== activeSoftApply.normalizedUrl
    ) {
      return false;
    }

    if (
      args.runtimeState.lastExplicitUserAction &&
      input.now - args.runtimeState.lastExplicitUserAction.at <
        args.userGestureGraceMs
    ) {
      return false;
    }

    return true;
  }

  // A *pure* rate-only catch-up session for this url: it only nudged the rate
  // (never wrote currentTime, hence armCooldownOnConverge=false) and restores by
  // relative drift. A genuine stall/pause during such a session is real local
  // evidence, so the broadcast layer abandons the catch-up instead of letting it
  // suppress / pollute the authoritative state. A session that ran a real
  // soft-apply (sticky armCooldownOnConverge=true) is excluded: its delayed
  // seek echoes must still be suppressed.
  function isActiveRateOnlyCatchUp(normalizedUrl: string | null): boolean {
    return (
      activeSoftApply !== null &&
      activeSoftApply.convergeByRelativeDrift &&
      !activeSoftApply.armCooldownOnConverge &&
      normalizedUrl !== null &&
      normalizedUrl === activeSoftApply.normalizedUrl
    );
  }

  function shouldSuppressByCooldown(
    video: HTMLVideoElement,
    playback: PlaybackState,
  ): boolean {
    if (
      args.runtimeState.softApplyCooldownUntil <= nowOf() ||
      !args.runtimeState.softApplyCooldownUrl
    ) {
      return false;
    }

    const normalizedUrl = args.normalizeUrl(playback.url);
    if (
      !normalizedUrl ||
      normalizedUrl !== args.runtimeState.softApplyCooldownUrl ||
      video.paused ||
      playback.playState !== "playing" ||
      playback.syncIntent === "explicit-seek" ||
      playback.syncIntent === "explicit-ratechange"
    ) {
      return false;
    }

    const decision = decidePlaybackReconcileMode({
      localCurrentTime: video.currentTime,
      targetTime: playback.currentTime,
      playState: playback.playState,
      playbackRate: playback.playbackRate,
      isExplicitSeek: shouldTreatAsExplicitSeek({
        syncIntent: playback.syncIntent,
        playState: playback.playState,
      }),
    });

    return decision.mode === "rate-only" || decision.mode === "soft-apply";
  }

  function destroy(): void {
    if (activeSoftApplyTimer !== null) {
      window.clearTimeout(activeSoftApplyTimer);
      activeSoftApplyTimer = null;
    }
  }

  return {
    cancelActiveSoftApply,
    maintainActiveSoftApply,
    upsertActiveSoftApply,
    shouldCancelActiveSoftApplyForPlayback,
    shouldSuppressActiveSoftApplyBroadcast,
    isActiveRateOnlyCatchUp,
    shouldSuppressByCooldown,
    clearSoftApplyCooldown,
    destroy,
  };
}
