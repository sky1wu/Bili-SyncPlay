import type { PlaybackState } from "@bili-syncplay/protocol";
import type {
  ContentRuntimeState,
  PendingLocalPlaybackOverride,
} from "./runtime-state";

const PENDING_LOCAL_EXPLICIT_SEEK_GUARD_MS = 5_000;
const PENDING_LOCAL_EXPLICIT_SEEK_SETTLE_THRESHOLD_SECONDS = 0.35;
const PENDING_LOCAL_EXPLICIT_RATECHANGE_GUARD_MS = 5_000;
const PENDING_LOCAL_EXPLICIT_RATECHANGE_SETTLE_THRESHOLD = 0.01;

export interface PendingLocalOverrideController {
  getPendingLocalPlaybackOverrideDecision(playback: PlaybackState | null): {
    shouldIgnore: boolean;
    reason?: string;
    extra?: string;
  };
  rememberPendingLocalPlaybackOverride(
    payload: PlaybackState,
    now: number,
  ): void;
  clearPendingLocalPlaybackOverride(reason?: string): void;
}

export function createPendingLocalOverrideController(args: {
  runtimeState: ContentRuntimeState;
  userGestureGraceMs: number;
  normalizeUrl: (url: string | undefined | null) => string | null;
  getNow?: () => number;
  debugLog: (message: string) => void;
}): PendingLocalOverrideController {
  const nowOf = () => args.getNow?.() ?? Date.now();

  function clearPendingLocalPlaybackOverride(reason = "unknown"): void {
    if (args.runtimeState.pendingLocalPlaybackOverride) {
      const pending = args.runtimeState.pendingLocalPlaybackOverride;
      args.debugLog(
        `Cleared pending local playback override kind=${pending.kind} url=${pending.url} seq=${pending.seq} reason=${reason}`,
      );
    }
    args.runtimeState.pendingLocalPlaybackOverride = null;
  }

  function getPendingLocalSeekOverrideDecision(
    playback: PlaybackState,
    pending: PendingLocalPlaybackOverride,
  ): {
    shouldIgnore: boolean;
    reason?: string;
    extra?: string;
  } {
    if (pending.targetTime === undefined) {
      return { shouldIgnore: false };
    }

    const deltaToPending = Math.abs(playback.currentTime - pending.targetTime);
    if (
      deltaToPending <= PENDING_LOCAL_EXPLICIT_SEEK_SETTLE_THRESHOLD_SECONDS
    ) {
      clearPendingLocalPlaybackOverride("seek-settled");
      return { shouldIgnore: false };
    }

    return {
      shouldIgnore: true,
      reason: "pending-local-explicit-seek",
      extra: `seq=${playback.seq} pendingSeq=${pending.seq} seekDelta=${deltaToPending.toFixed(2)} incomingIntent=${playback.syncIntent ?? "none"}`,
    };
  }

  function getPendingLocalRateOverrideDecision(
    playback: PlaybackState,
    pending: PendingLocalPlaybackOverride,
  ): {
    shouldIgnore: boolean;
    reason?: string;
    extra?: string;
  } {
    if (
      playback.playState !== "playing" ||
      pending.playbackRate === undefined
    ) {
      return { shouldIgnore: false };
    }

    const rateDelta = Math.abs(playback.playbackRate - pending.playbackRate);
    if (rateDelta <= PENDING_LOCAL_EXPLICIT_RATECHANGE_SETTLE_THRESHOLD) {
      clearPendingLocalPlaybackOverride("rate-settled");
      return { shouldIgnore: false };
    }

    return {
      shouldIgnore: true,
      reason: "pending-local-explicit-ratechange",
      extra: `seq=${playback.seq} pendingSeq=${pending.seq} rateDelta=${rateDelta.toFixed(2)} targetRate=${pending.playbackRate.toFixed(2)} incomingRate=${playback.playbackRate.toFixed(2)}`,
    };
  }

  function getPendingLocalPlaybackOverrideDecision(
    playback: PlaybackState | null,
  ): {
    shouldIgnore: boolean;
    reason?: string;
    extra?: string;
  } {
    const pending = args.runtimeState.pendingLocalPlaybackOverride;
    if (!pending) {
      return { shouldIgnore: false };
    }

    if (nowOf() >= pending.expiresAt) {
      clearPendingLocalPlaybackOverride("expired");
      return { shouldIgnore: false };
    }

    if (!playback) {
      return { shouldIgnore: false };
    }

    const normalizedPlaybackUrl = args.normalizeUrl(playback.url);
    if (!normalizedPlaybackUrl || normalizedPlaybackUrl !== pending.url) {
      return { shouldIgnore: false };
    }

    if (
      args.runtimeState.localMemberId &&
      playback.actorId === args.runtimeState.localMemberId &&
      playback.seq >= pending.seq
    ) {
      clearPendingLocalPlaybackOverride("self-echo-ack");
      return { shouldIgnore: false };
    }

    if (pending.kind === "seek") {
      return getPendingLocalSeekOverrideDecision(playback, pending);
    }

    return getPendingLocalRateOverrideDecision(playback, pending);
  }

  function rememberPendingLocalPlaybackOverride(
    payload: PlaybackState,
    now: number,
  ): void {
    if (payload.syncIntent === "explicit-seek") {
      args.runtimeState.pendingLocalPlaybackOverride = {
        kind: "seek",
        url: args.normalizeUrl(payload.url) ?? payload.url,
        targetTime: payload.currentTime,
        seq: payload.seq,
        expiresAt: now + PENDING_LOCAL_EXPLICIT_SEEK_GUARD_MS,
      };
      args.debugLog(
        `Remember pending local playback override kind=seek url=${payload.url} target=${payload.currentTime.toFixed(2)} seq=${payload.seq} expiresAt=${args.runtimeState.pendingLocalPlaybackOverride.expiresAt}`,
      );
      return;
    }

    if (
      args.runtimeState.lastExplicitUserAction?.kind === "ratechange" &&
      now - args.runtimeState.lastExplicitUserAction.at <
        args.userGestureGraceMs
    ) {
      args.runtimeState.pendingLocalPlaybackOverride = {
        kind: "ratechange",
        url: args.normalizeUrl(payload.url) ?? payload.url,
        playbackRate: payload.playbackRate,
        seq: payload.seq,
        expiresAt: now + PENDING_LOCAL_EXPLICIT_RATECHANGE_GUARD_MS,
      };
      args.debugLog(
        `Remember pending local playback override kind=ratechange url=${payload.url} rate=${payload.playbackRate.toFixed(2)} seq=${payload.seq} expiresAt=${args.runtimeState.pendingLocalPlaybackOverride.expiresAt}`,
      );
    }
  }

  return {
    getPendingLocalPlaybackOverrideDecision,
    rememberPendingLocalPlaybackOverride,
    clearPendingLocalPlaybackOverride,
  };
}
