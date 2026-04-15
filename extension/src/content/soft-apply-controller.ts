import type { PlaybackState } from "@bili-syncplay/protocol";
import {
  decidePlaybackReconcileMode,
  shouldTreatAsExplicitSeek,
} from "./playback-reconcile";
import {
  createProgrammaticPlaybackSignature,
  getPlayState,
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

export interface SoftApplyController {
  cancelActiveSoftApply(video: HTMLVideoElement | null, reason: string): void;
  maintainActiveSoftApply(video: HTMLVideoElement): void;
  upsertActiveSoftApply(
    playback: PlaybackState,
    remainingDriftSeconds: number,
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
    if (
      video &&
      Math.abs(video.playbackRate - session.restorePlaybackRate) > 0.01
    ) {
      video.playbackRate = session.restorePlaybackRate;
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
    if (reason === "converged" || reason === "apply-hard-seek") {
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
      cancelActiveSoftApply(video, "timeout");
    }, delayMs);
  }

  function upsertActiveSoftApply(
    playback: PlaybackState,
    remainingDriftSeconds: number,
  ): void {
    const normalizedUrl = args.normalizeUrl(playback.url);
    if (!normalizedUrl) {
      clearActiveSoftApplyState();
      return;
    }
    const timeoutMs = computeSoftApplyTimeoutMs(remainingDriftSeconds);
    activeSoftApply = {
      normalizedUrl,
      targetTime: playback.currentTime,
      restorePlaybackRate: playback.playbackRate,
      deadlineAt: nowOf() + timeoutMs,
    };
    scheduleActiveSoftApplyTimeout();
    args.debugLog(
      `Started soft apply url=${normalizedUrl} target=${playback.currentTime.toFixed(2)} rate=${playback.playbackRate.toFixed(2)} timeout=${timeoutMs}`,
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
    if (playback.playState !== "playing") {
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
    if (
      Math.abs(playback.currentTime - activeSoftApply.targetTime) >
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
      cancelActiveSoftApply(video, "timeout");
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
    shouldSuppressByCooldown,
    clearSoftApplyCooldown,
    destroy,
  };
}
