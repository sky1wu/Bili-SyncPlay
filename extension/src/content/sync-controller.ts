import type {
  PlaybackState,
  RoomState,
  SharedVideo,
} from "@bili-syncplay/protocol";
import type { SharedVideoToastPayload } from "../shared/messages";
import {
  createPlaybackBroadcastPayload,
  derivePlaybackSyncIntent,
  deriveUserInitiatedPause,
  shouldPauseForNonSharedBroadcast,
  shouldSkipBroadcastWhileHydrating,
} from "./playback-broadcast";
import {
  applyPendingPlaybackApplication as applyPendingPlaybackApplicationWithBinding,
  createProgrammaticPlaybackSignature,
  getPlayState,
  pauseVideo,
} from "./player-binding";
import {
  decidePlaybackReconcileMode,
  formatPlaybackReconcileDecision,
  shouldTreatAsExplicitSeek,
} from "./playback-reconcile";
import { createRoomStateApplyController } from "./room-state-apply-controller";
import {
  hasRecentRemoteStopIntent as hasRecentRemoteStopIntentGuard,
  rememberRemotePlaybackForSuppression as rememberRemotePlaybackForSuppressionGuard,
  shouldApplySelfPlayback as shouldApplySelfPlaybackGuard,
  shouldSuppressLocalEcho as shouldSuppressLocalEchoGuard,
  shouldSuppressRemoteFollowupBroadcast as shouldSuppressRemoteFollowupBroadcastGuard,
  shouldSuppressProgrammaticEvent as shouldSuppressProgrammaticEventGuard,
  shouldSuppressRemotePlayTransition as shouldSuppressRemotePlayTransitionGuard,
} from "./sync-guards";
import { createSoftApplyController } from "./soft-apply-controller";
import { createPendingLocalOverrideController } from "./pending-local-override";
import type {
  ContentRuntimeState,
  LocalPlaybackEventSource,
  ProgrammaticApplyScope,
} from "./runtime-state";

/** Tolerance for treating two broadcast positions as the same frozen instant. */
const DUPLICATE_BROADCAST_TIME_EPSILON_SECONDS = 0.05;

export interface SyncController {
  resetPlaybackSyncState(reason: string): void;
  hasRecentRemoteStopIntent(currentVideoUrl: string): boolean;
  cancelActiveSoftApply(video: HTMLVideoElement | null, reason: string): void;
  maintainActiveSoftApply(video: HTMLVideoElement): void;
  applyPendingPlaybackApplication(video: HTMLVideoElement): void;
  broadcastPlayback(
    video: HTMLVideoElement,
    eventSource?: LocalPlaybackEventSource,
    naturalEnd?: boolean,
  ): Promise<void>;
  applyRoomState(
    state: RoomState,
    shareToast?: SharedVideoToastPayload | null,
  ): Promise<void>;
  hydrateRoomState(): Promise<void>;
  scheduleHydrationRetry(delayMs?: number): void;
  destroy(): void;
}

export function createSyncController(args: {
  runtimeState: ContentRuntimeState;
  lastAppliedVersionByActor: Map<string, { serverTime: number; seq: number }>;
  broadcastLogState: { key: string | null; at: number };
  ignoredSelfPlaybackLogState: { key: string | null; at: number };
  localIntentGuardMs: number;
  pauseHoldMs: number;
  initialRoomStatePauseHoldMs: number;
  remoteEchoSuppressionMs: number;
  remotePlayTransitionGuardMs: number;
  remoteFollowPlayingWindowMs: number;
  programmaticApplyWindowMs: number;
  userGestureGraceMs: number;
  /**
   * Window during which a buffer-induced pause is broadcast as `buffering`
   * instead of `paused`. After this elapses the binding layer re-broadcasts
   * as `paused`.
   */
  bufferPauseUpgradeMs: number;
  /**
   * Delay before applying a remote `paused` room state, to absorb the
   * "pause→play within ~1s" flicker emitted by peers experiencing buffer
   * stalls. Set to 0 to disable.
   */
  remotePauseDebounceMs: number;
  /**
   * Window within which an otherwise identical `playback:update` is treated as
   * a duplicate of the previous one and dropped.
   */
  duplicateBroadcastWindowMs: number;
  nextSeq: () => number;
  markBroadcastAt: (at: number) => void;
  getNow?: () => number;
  debugLog: (message: string) => void;
  shouldLogHeartbeat: (
    state: { key: string | null; at: number },
    key: string,
    now?: number,
  ) => boolean;
  runtimeSendMessage: <T>(message: unknown) => Promise<T | null>;
  getVideoElement: () => HTMLVideoElement | null;
  getCurrentPlaybackVideo: () => Promise<SharedVideo | null>;
  getSharedVideo: () => SharedVideo | null;
  normalizeUrl: (url: string | undefined | null) => string | null;
  notifyRoomStateToasts: (state: RoomState) => void;
  maybeShowSharedVideoToast: (
    toast: SharedVideoToastPayload | null | undefined,
    state: RoomState,
  ) => void;
}): SyncController {
  const nowOf = () => args.getNow?.() ?? Date.now();
  const ignoredRemotePlaybackLogState = { key: null as string | null, at: 0 };
  const duplicateBroadcastLogState = { key: null as string | null, at: 0 };
  /**
   * The last local playback state the room itself echoed back, for collapsing
   * the burst of identical messages one player event produces.
   *
   * Deliberately keyed on the room's echo rather than on "we called send":
   * neither the background nor the socket nor the server acknowledges a
   * `playback:update` on the failure paths — the background answers `{ok:true}`
   * even when it drops the message, `sendToServer` drops silently when the
   * socket is not OPEN, and the server drops silently when the rate-limit
   * bucket is empty. Suppressing a repeat because we *sent* something could
   * therefore swallow the retry for an update the room never received; a repeat
   * is only redundant once the room demonstrably already holds that state.
   *
   * Cleared whenever the playback context resets so a duplicate can never be
   * matched across videos.
   */
  let roomConfirmedBroadcast: {
    normalizedUrl: string | null;
    playState: PlaybackState["playState"];
    syncIntent: PlaybackState["syncIntent"] | undefined;
    userInitiated: boolean;
    naturalEnd: boolean;
    currentTime: number;
    playbackRate: number;
    at: number;
  } | null = null;
  const localEchoLogState = { key: null as string | null, at: 0 };
  const dispatchPlaybackLogState = { key: null as string | null, at: 0 };

  function formatPlaybackDiagnostic(argsForLog: {
    actor?: string | null;
    playState: PlaybackState["playState"];
    url: string;
    localTime?: number | null;
    targetTime: number;
    result: string;
    extra?: string;
  }): string {
    const localTime = argsForLog.localTime ?? null;
    const delta =
      localTime === null
        ? "n/a"
        : Math.abs(localTime - argsForLog.targetTime).toFixed(2);
    const parts = [
      `actor=${argsForLog.actor ?? "unknown"}`,
      `playState=${argsForLog.playState}`,
      `url=${argsForLog.url}`,
      `delta=${delta}`,
      `result=${argsForLog.result}`,
    ];
    if (argsForLog.extra) {
      parts.push(argsForLog.extra);
    }
    return parts.join(" ");
  }

  function formatBroadcastTrace(argsForTrace: {
    eventSource: LocalPlaybackEventSource;
    currentVideoUrl: string | null;
    normalizedCurrentVideoUrl: string | null;
    playState?: PlaybackState["playState"];
    currentTime?: number;
    playbackRate?: number;
  }): string {
    const pending = args.runtimeState.pendingLocalPlaybackOverride;
    const suppressed = args.runtimeState.suppressedRemotePlayback;
    const explicitAction = args.runtimeState.lastExplicitUserAction;
    const programmatic = args.runtimeState.programmaticApplySignature;

    return [
      `source=${argsForTrace.eventSource}`,
      `url=${argsForTrace.currentVideoUrl ?? "none"}`,
      `normalizedUrl=${argsForTrace.normalizedCurrentVideoUrl ?? "none"}`,
      `playState=${argsForTrace.playState ?? "unknown"}`,
      `t=${argsForTrace.currentTime?.toFixed(2) ?? "n/a"}`,
      `rate=${argsForTrace.playbackRate?.toFixed(2) ?? "n/a"}`,
      `intendedState=${args.runtimeState.intendedPlayState}`,
      `intendedRate=${args.runtimeState.intendedPlaybackRate.toFixed(2)}`,
      `explicitAction=${explicitAction?.kind ?? "none"}@${explicitAction?.at ?? 0}`,
      `lastGestureAt=${args.runtimeState.lastUserGestureAt}`,
      `pendingOverride=${pending ? `${pending.kind}:${pending.seq}@${pending.url}` : "none"}`,
      `remoteFollow=${args.runtimeState.remoteFollowPlayingUrl ?? "none"}@${args.runtimeState.remoteFollowPlayingUntil}`,
      `suppressedRemote=${suppressed ? `${suppressed.playState}@${suppressed.url}` : "none"}`,
      `programmatic=${programmatic ? `${programmatic.playState}@${programmatic.url}` : "none"}@${args.runtimeState.programmaticApplyUntil}`,
      `pauseHoldUntil=${args.runtimeState.pauseHoldUntil}`,
    ].join(" ");
  }

  function logHeartbeatMessage(
    state: { key: string | null; at: number },
    key: string,
    message: string,
    now = nowOf(),
  ): void {
    if (args.shouldLogHeartbeat(state, key, now)) {
      args.debugLog(message);
    }
  }

  function logBroadcastTrace(
    result: string,
    eventSource: LocalPlaybackEventSource,
    trace: string,
    _normalizedUrl: string | null,
    _now = nowOf(),
  ): void {
    if (
      eventSource === "timeupdate" ||
      eventSource === "canplay" ||
      eventSource === "playing" ||
      eventSource === "seeked"
    ) {
      return;
    }
    args.debugLog(`Broadcast trace result=${result} ${trace}`);
  }

  function activatePauseHold(durationMs = args.pauseHoldMs): void {
    args.runtimeState.pauseHoldUntil = nowOf() + durationMs;
  }

  function armProgrammaticApplyWindow(
    signature: ReturnType<typeof createProgrammaticPlaybackSignature>,
    reason: "pending" | "apply",
    actorId = "system",
    scope: ProgrammaticApplyScope = "all",
  ): void {
    // Normalize the signature url at the single write point so every consumer
    // (programmatic-event guard, programmatic-paused window, programmatic
    // ratechange detection) compares it against the equally normalized current
    // url. The raw playback url can differ from its normalized form (e.g.
    // festival/watchlater shares resolve to /video/...), and a mismatch would
    // make our own programmatic rate/seek echoes look like genuine user actions.
    const normalizedSignatureUrl =
      args.normalizeUrl(signature.url) ?? signature.url;
    args.runtimeState.programmaticApplySignature = {
      ...signature,
      url: normalizedSignatureUrl,
    };
    args.runtimeState.programmaticApplyAt = nowOf();
    args.runtimeState.programmaticApplyScope = scope;
    args.runtimeState.programmaticApplyUntil =
      nowOf() + args.programmaticApplyWindowMs;
    args.debugLog(
      `Programmatic apply window armed actor=${actorId} playState=${signature.playState} url=${signature.url} delta=n/a result=${reason} scope=${scope} until=${args.runtimeState.programmaticApplyUntil}`,
    );
  }

  const softApply = createSoftApplyController({
    runtimeState: args.runtimeState,
    normalizeUrl: args.normalizeUrl,
    getVideoElement: args.getVideoElement,
    debugLog: args.debugLog,
    userGestureGraceMs: args.userGestureGraceMs,
    programmaticApplyWindowMs: args.programmaticApplyWindowMs,
    getNow: args.getNow,
    armProgrammaticApplyWindow,
  });

  const pendingLocalOverride = createPendingLocalOverrideController({
    runtimeState: args.runtimeState,
    userGestureGraceMs: args.userGestureGraceMs,
    normalizeUrl: args.normalizeUrl,
    getNow: args.getNow,
    debugLog: args.debugLog,
  });

  function resetPlaybackSyncState(reason: string): void {
    softApply.cancelActiveSoftApply(args.getVideoElement(), `reset:${reason}`);
    args.lastAppliedVersionByActor.clear();
    clearRemoteFollowPlayingWindow();
    args.runtimeState.suppressedRemotePlayback = null;
    args.runtimeState.recentRemotePlayingIntent = null;
    args.runtimeState.pendingPlaybackApplication = null;
    pendingLocalOverride.clearPendingLocalPlaybackOverride("reset");
    args.runtimeState.programmaticApplyUntil = 0;
    args.runtimeState.programmaticApplyAt = 0;
    args.runtimeState.programmaticApplyScope = "all";
    args.runtimeState.programmaticApplySignature = null;
    softApply.clearSoftApplyCooldown();
    args.runtimeState.lastLocalPlaybackVersion = null;
    args.runtimeState.intendedPlaybackRate = 1;
    roomConfirmedBroadcast = null;
    args.runtimeState.lastNonSharedGuardUrl = null;
    args.runtimeState.lastExplicitPlaybackAction = null;
    // Preserve the user's authorization to keep watching a non-shared local video
    // they manually started when this reset is a remote shared-url switch and they
    // are STILL on that very video. Otherwise the periodic non-shared load-pause
    // guard would re-pause an active local watch just because another member moved
    // the room to a different shared video. A genuine navigation away still clears
    // it (the navigation reset), and on the shared/other page it is harmless.
    const resolvedCurrentUrl = args.normalizeUrl(args.getSharedVideo()?.url);
    const keepNonSharedAuthorization =
      resolvedCurrentUrl !== null &&
      resolvedCurrentUrl === args.runtimeState.explicitNonSharedPlaybackUrl;
    if (!keepNonSharedAuthorization) {
      args.runtimeState.explicitNonSharedPlaybackUrl = null;
      args.runtimeState.nonSharerAutoplayHoldUrl = null;
    }
    args.runtimeState.suppressedLocalEndPauseUrl = null;
    args.runtimeState.suppressedLocalEndPauseUntil = 0;
    args.runtimeState.postNavigationAnchorSharedUrl = null;
    args.runtimeState.postNavigationAnchorSetAt = 0;
    args.runtimeState.sharerEndedSuppressionUrl = null;
    args.runtimeState.sharerEndedSuppressionUntil = 0;
    args.runtimeState.sharerEndedSuppressionArmedAt = 0;
    args.runtimeState.sharedVideoNaturalEndUrl = null;
    args.runtimeState.sharedVideoNaturalEndAt = 0;
    args.runtimeState.sharedVideoNaturalEndAfterSeek = false;
    args.debugLog(`Reset playback sync state: ${reason}`);
  }

  function applyPendingPlaybackApplication(video: HTMLVideoElement): void {
    const pending = args.runtimeState.pendingPlaybackApplication;
    const result = applyPendingPlaybackApplicationWithBinding({
      video,
      pendingPlaybackApplication: pending,
      // While a catch-up is running for this video, converge on the drift
      // instead of stopping as soon as it re-enters the (much wider) band that
      // triggered the catch-up in the first place.
      hasActiveCatchUp:
        pending !== null &&
        softApply.isActiveRateOnlyCatchUp(args.normalizeUrl(pending.url)),
      hasActiveCorrectionSession:
        pending !== null &&
        softApply.hasActiveCorrectionSession(args.normalizeUrl(pending.url)),
      clearPendingPlaybackApplication: () => {
        args.runtimeState.pendingPlaybackApplication = null;
      },
      onPlaybackAdjusted: (adjustment, playback) => {
        // A `rate-only` catch-up that actually inflates the playback rate above
        // the base rate must self-restore just like `soft-apply`: it bumps the
        // rate to close drift but never writes time, so if no corrective remote
        // update follows (e.g. the sharer keeps playing steadily after an
        // autoplay-next), the elevated rate would otherwise persist and the
        // playhead would run ahead forever. Registering it as an active
        // soft-apply session lets the existing convergence/timeout machinery
        // restore `restorePlaybackRate` once the local time catches up.
        const isSelfRestoringRateAdjust =
          adjustment.mode === "soft-apply" ||
          (adjustment.mode === "rate-only" &&
            Math.abs(adjustment.playbackRate - adjustment.restorePlaybackRate) >
              0.01);
        // A frozen `buffering` snapshot never moves the playhead, so it must
        // not tear down an in-flight catch-up (see the early return below).
        //
        // Clearing the cooldown is a separate question: that bookkeeping may
        // only be skipped when the apply genuinely wrote nothing. A buffering
        // update still carries the room's rate (and an `explicit-ratechange`
        // always applies), so treating those as no-ops would keep a stale
        // cooldown alive — and `shouldSuppressByCooldown` only screens
        // `playing` updates, so the next real position correction would be
        // suppressed with nothing to clear it.
        const isBufferingApply =
          adjustment.reason === "buffering-not-authoritative";
        if (
          !isSelfRestoringRateAdjust &&
          !(isBufferingApply && !adjustment.didChange)
        ) {
          softApply.clearSoftApplyCooldown();
        }
        args.debugLog(
          `Playback reconcile actor=${playback.actorId} playState=${playback.playState} url=${playback.url} ${formatPlaybackReconcileDecision(
            {
              mode: adjustment.mode,
              reason: adjustment.reason,
              delta: adjustment.delta,
            },
          )} wroteTime=${adjustment.didWriteCurrentTime} wroteRate=${adjustment.didWritePlaybackRate} targetTime=${adjustment.targetTime.toFixed(2)} appliedTime=${adjustment.currentTime.toFixed(2)} appliedRate=${adjustment.playbackRate.toFixed(2)} restoreRate=${adjustment.restorePlaybackRate.toFixed(2)}`,
        );
        if (isBufferingApply) {
          return;
        }
        if (isSelfRestoringRateAdjust) {
          const driftSeconds = Math.abs(
            adjustment.targetTime - adjustment.currentTime,
          );
          const isSoftApply = adjustment.mode === "soft-apply";
          // A rate-only catch-up only nudges the rate, so unlike a real
          // soft-apply it must NOT arm the soft-apply cooldown (doing so would
          // suppress the next genuine remote reconcile and leave residual drift
          // behind), and it must restore by relative-drift closure rather than
          // by reaching the now-stale snapshot target.
          softApply.upsertActiveSoftApply(playback, driftSeconds, {
            armCooldownOnConverge: isSoftApply,
            relativeDriftClose: isSoftApply
              ? undefined
              : {
                  driftSeconds,
                  rateOffsetSeconds:
                    adjustment.playbackRate - adjustment.restorePlaybackRate,
                },
          });
          return;
        }
        softApply.cancelActiveSoftApply(
          args.getVideoElement(),
          `apply-${adjustment.mode}`,
        );
      },
      markProgrammaticApply: (_signature, playback) => {
        armProgrammaticApplyWindow(_signature, "apply", playback.actorId);
      },
      debugLog: args.debugLog,
    });
    if (
      result.applied &&
      !result.didChange &&
      result.adjustment?.mode === "ignore"
    ) {
      args.debugLog(
        `Skipped noop playback apply because reconcile stayed within ignore threshold reason=${result.adjustment.reason} delta=${result.adjustment.delta.toFixed(2)}`,
      );
    }
  }

  function acceptInitialRoomStateHydration(): void {
    args.runtimeState.pendingRoomStateHydration = false;
    args.runtimeState.hasReceivedInitialRoomState = true;
  }

  function acceptInitialRoomStateHydrationIfPending(): void {
    if (args.runtimeState.pendingRoomStateHydration) {
      acceptInitialRoomStateHydration();
    }
  }

  // Mark the room's initial state as *received* without clearing
  // `pendingRoomStateHydration`. Used when the state is known but its
  // application is intentionally deferred (e.g. a remote `paused` held by the
  // flicker debounce): `hasReceivedInitialRoomState` gates `handleSyncStatus`'s
  // 150ms hydrate retry, so leaving it false while re-deferring the paused every
  // ~150ms (< the 250ms debounce) resets the defer timer forever, spamming
  // `sync:request` until the server rate-limits us. `pendingRoomStateHydration`
  // stays true so the longer initial pause hold / protection still apply when
  // the deferred snapshot finally fires and accepts hydration for real.
  function markInitialRoomStateReceived(): void {
    args.runtimeState.hasReceivedInitialRoomState = true;
  }

  function logIgnoredRemotePlayback(argsForLog: {
    playback: PlaybackState;
    video: HTMLVideoElement;
    result: string;
    extra?: string;
  }): void {
    logHeartbeatMessage(
      ignoredRemotePlaybackLogState,
      `${argsForLog.playback.actorId}|${argsForLog.playback.playState}|${argsForLog.result}|${args.normalizeUrl(argsForLog.playback.url) ?? argsForLog.playback.url}`,
      `Ignored remote playback ${formatPlaybackDiagnostic({
        actor: argsForLog.playback.actorId,
        playState: argsForLog.playback.playState,
        url: argsForLog.playback.url,
        localTime: argsForLog.video.currentTime,
        targetTime: argsForLog.playback.currentTime,
        result: argsForLog.result,
        extra: argsForLog.extra,
      })}`,
    );
  }

  function clearRemoteFollowPlayingWindow(): void {
    args.runtimeState.remoteFollowPlayingUntil = 0;
    args.runtimeState.remoteFollowPlayingUrl = null;
  }

  function rememberRemoteFollowPlayingWindow(playback: PlaybackState): void {
    if (playback.playState !== "playing") {
      clearRemoteFollowPlayingWindow();
      return;
    }

    args.runtimeState.remoteFollowPlayingUntil =
      nowOf() + args.remoteFollowPlayingWindowMs;
    args.runtimeState.remoteFollowPlayingUrl = args.normalizeUrl(playback.url);
  }

  function hasRecentRemoteStopIntent(currentVideoUrl: string): boolean {
    return hasRecentRemoteStopIntentGuard({
      now: nowOf(),
      pauseHoldUntil: args.runtimeState.pauseHoldUntil,
      normalizedCurrentUrl: args.normalizeUrl(currentVideoUrl),
      activeSharedUrl: args.runtimeState.activeSharedUrl,
      intendedPlayState: args.runtimeState.intendedPlayState,
      suppressedRemotePlayback: args.runtimeState.suppressedRemotePlayback,
    });
  }

  function rememberRemotePlaybackForSuppression(playback: PlaybackState): void {
    const url = args.normalizeUrl(playback.url);
    const remembered = rememberRemotePlaybackForSuppressionGuard({
      playback,
      normalizedUrl: url,
      now: nowOf(),
      remoteEchoSuppressionMs: args.remoteEchoSuppressionMs,
      remotePlayTransitionGuardMs: args.remotePlayTransitionGuardMs,
    });
    args.runtimeState.suppressedRemotePlayback =
      remembered.suppressedRemotePlayback;
    args.runtimeState.recentRemotePlayingIntent =
      remembered.recentRemotePlayingIntent;
    if (!url) {
      return;
    }
    args.debugLog(
      `Remember remote echo ${playback.playState} ${url} t=${playback.currentTime.toFixed(2)} rate=${playback.playbackRate.toFixed(2)}`,
    );
  }

  function shouldSuppressLocalEcho(
    video: HTMLVideoElement,
    currentVideo: SharedVideo,
    playState: PlaybackState["playState"],
  ): boolean {
    const decision = shouldSuppressLocalEchoGuard({
      suppressedRemotePlayback: args.runtimeState.suppressedRemotePlayback,
      normalizedCurrentUrl: args.normalizeUrl(currentVideo.url),
      playState,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      now: nowOf(),
    });

    if (
      args.runtimeState.suppressedRemotePlayback &&
      !decision.nextSuppressedRemotePlayback
    ) {
      args.debugLog(
        `Remote echo window expired for ${args.runtimeState.suppressedRemotePlayback.playState} ${args.runtimeState.suppressedRemotePlayback.url}`,
      );
      args.runtimeState.suppressedRemotePlayback =
        decision.nextSuppressedRemotePlayback;
    }

    if (
      args.runtimeState.suppressedRemotePlayback &&
      decision.nextSuppressedRemotePlayback &&
      args.normalizeUrl(currentVideo.url) !==
        args.runtimeState.suppressedRemotePlayback.url
    ) {
      args.debugLog(
        `Remote echo skipped by url ${currentVideo.url} != ${args.runtimeState.suppressedRemotePlayback.url}`,
      );
    } else if (
      args.runtimeState.suppressedRemotePlayback &&
      decision.nextSuppressedRemotePlayback &&
      playState !== args.runtimeState.suppressedRemotePlayback.playState
    ) {
      args.debugLog(
        `Remote echo skipped by playState ${playState} != ${args.runtimeState.suppressedRemotePlayback.playState}`,
      );
    } else if (
      args.runtimeState.suppressedRemotePlayback &&
      decision.nextSuppressedRemotePlayback &&
      Math.abs(
        video.playbackRate -
          args.runtimeState.suppressedRemotePlayback.playbackRate,
      ) > 0.01
    ) {
      args.debugLog(
        `Remote echo skipped by rate ${video.playbackRate.toFixed(2)} != ${args.runtimeState.suppressedRemotePlayback.playbackRate.toFixed(2)}`,
      );
    }

    const threshold = playState === "playing" ? 0.9 : 0.2;
    const delta = args.runtimeState.suppressedRemotePlayback
      ? Math.abs(
          video.currentTime -
            args.runtimeState.suppressedRemotePlayback.currentTime,
        )
      : Infinity;
    logHeartbeatMessage(
      localEchoLogState,
      `${decision.shouldSuppress ? "suppress" : "allow"}|${playState}|${args.normalizeUrl(currentVideo.url) ?? currentVideo.url}`,
      `${decision.shouldSuppress ? "Suppressed" : "Allowed"} local echo ${playState} ${currentVideo.url} delta=${delta.toFixed(2)} threshold=${threshold.toFixed(2)}`,
    );
    return decision.shouldSuppress;
  }

  function shouldSuppressRemotePlayTransition(
    currentVideo: SharedVideo,
    playState: PlaybackState["playState"],
    currentTime: number,
  ): boolean {
    const decision = shouldSuppressRemotePlayTransitionGuard({
      recentRemotePlayingIntent: args.runtimeState.recentRemotePlayingIntent,
      normalizedCurrentUrl: args.normalizeUrl(currentVideo.url),
      playState,
      currentTime,
      lastExplicitPlaybackAction: args.runtimeState.lastExplicitPlaybackAction,
      now: nowOf(),
      userGestureGraceMs: args.userGestureGraceMs,
    });

    if (
      args.runtimeState.recentRemotePlayingIntent &&
      decision.nextRecentRemotePlayingIntent &&
      args.runtimeState.lastExplicitPlaybackAction &&
      nowOf() - args.runtimeState.lastExplicitPlaybackAction.at <
        args.userGestureGraceMs &&
      args.runtimeState.lastExplicitPlaybackAction.playState === "paused" &&
      playState === "paused"
    ) {
      args.debugLog(
        `Allowed remote play transition echo by explicit action ${playState} ${currentVideo.url}`,
      );
    }
    args.runtimeState.recentRemotePlayingIntent =
      decision.nextRecentRemotePlayingIntent;

    const delta = args.runtimeState.recentRemotePlayingIntent
      ? Math.abs(
          currentTime - args.runtimeState.recentRemotePlayingIntent.currentTime,
        )
      : Infinity;
    if (decision.shouldSuppress) {
      args.debugLog(
        `Suppressed remote play transition echo ${formatPlaybackDiagnostic({
          playState,
          url: currentVideo.url,
          targetTime: currentTime,
          result: "remote-play-transition",
          extra: `intentDelta=${delta.toFixed(2)}`,
        })}`,
      );
    }
    return decision.shouldSuppress;
  }

  function shouldApplySelfPlayback(
    video: HTMLVideoElement,
    playback: PlaybackState,
  ): boolean {
    return shouldApplySelfPlaybackGuard({
      videoPaused: video.paused,
      videoCurrentTime: video.currentTime,
      videoPlaybackRate: video.playbackRate,
      playback,
    });
  }

  function shouldIgnoreRemotePlaybackApply(
    video: HTMLVideoElement,
    playback: PlaybackState,
    isSelfPlayback: boolean,
  ): boolean {
    if (isSelfPlayback || playback.playState !== "playing" || video.paused) {
      return false;
    }

    if (Math.abs(video.playbackRate - playback.playbackRate) > 0.01) {
      return false;
    }

    const reconcileDecision = decidePlaybackReconcileMode({
      localCurrentTime: video.currentTime,
      targetTime: playback.currentTime,
      playState: playback.playState,
      isExplicitSeek: shouldTreatAsExplicitSeek({
        syncIntent: playback.syncIntent,
        playState: playback.playState,
      }),
    });

    return reconcileDecision.mode === "ignore";
  }

  function shouldSuppressUnexpectedPlaybackRateBroadcast(input: {
    playbackRate: number;
    currentVideoUrl: string;
    eventSource: LocalPlaybackEventSource;
    now: number;
  }): boolean {
    const hasRecentExplicitUserAction =
      Boolean(args.runtimeState.lastExplicitUserAction) &&
      input.now - (args.runtimeState.lastExplicitUserAction?.at ?? 0) <
        args.userGestureGraceMs;
    const hasRecentExplicitRatechange =
      args.runtimeState.lastExplicitUserAction?.kind === "ratechange" &&
      input.now - args.runtimeState.lastExplicitUserAction.at <
        args.userGestureGraceMs;

    if (
      hasRecentExplicitRatechange ||
      (hasRecentExplicitUserAction &&
        (input.eventSource === "play" ||
          input.eventSource === "playing" ||
          input.eventSource === "ratechange"))
    ) {
      return false;
    }

    if (
      Math.abs(input.playbackRate - args.runtimeState.intendedPlaybackRate) <=
      0.01
    ) {
      return false;
    }

    args.debugLog(
      `Skip broadcast ${formatPlaybackDiagnostic({
        actor: args.runtimeState.localMemberId,
        playState: "playing",
        url: input.currentVideoUrl,
        localTime: null,
        targetTime: args.runtimeState.intendedPlaybackRate,
        result: `unexpected-rate-${input.eventSource}`,
        extra: `localRate=${input.playbackRate.toFixed(2)} expectedRate=${args.runtimeState.intendedPlaybackRate.toFixed(2)}`,
      })}`,
    );
    return true;
  }

  function getBroadcastPlayState(argsForBroadcast: {
    video: HTMLVideoElement;
    eventSource: LocalPlaybackEventSource;
    now: number;
  }): PlaybackState["playState"] {
    const basePlayState = getPlayState(
      argsForBroadcast.video,
      args.runtimeState.intendedPlayState,
    );
    // Mirrors `derivePlaybackSyncIntent`'s `hasActiveExplicitUserAction`: a seek
    // that predates a forced pause was invalidated by it and is not a user
    // intent any more. The old single branch got this for free from its
    // `intendedPlayState === "playing"` guard (a forced pause leaves that
    // `paused`); the seek-event branch below deliberately drops that guard, so
    // the check has to be stated here instead of inferred.
    //
    // The `programmaticApplyAt` check is the same rule `sync-guards` applies:
    // applying a remote state writes `currentTime`, which echoes back as
    // `seeking`/`seeked`. Those echoes are not a new gesture, but a REAL user
    // seek from moments earlier is still inside the grace window, so without
    // this they would inherit its intent — and because the seek branch returns
    // before the programmatic guard runs, a remote `paused` would be answered
    // with `playing` + `explicit-seek` and restart the room.
    const hasRecentExplicitSeek =
      args.runtimeState.lastExplicitUserAction?.kind === "seek" &&
      args.runtimeState.lastExplicitUserAction.at >
        args.runtimeState.lastForcedPauseAt &&
      args.runtimeState.lastExplicitUserAction.at >=
        args.runtimeState.programmaticApplyAt &&
      argsForBroadcast.now - args.runtimeState.lastExplicitUserAction.at <
        args.userGestureGraceMs;

    // Where the seek STARTED, not where this side is now — the first forced
    // `seeking` broadcast writes `intendedPlayState` back to `playing`, so the
    // current value cannot answer this for the rest of the same seek.
    const seekOrigin = hasRecentExplicitSeek
      ? args.runtimeState.explicitSeekOriginPlayState
      : null;

    // The seek events themselves are the jump, and they always carry
    // `explicit-seek`. Report them as `playing` even when this side was already
    // stalled: that is still a real change of room position, and leaving it as
    // `buffering` makes receivers ahead of the (frozen) target skip it via
    // `buffering-not-authoritative` until the stall resolves (#198).
    //
    // A seek that started from `paused` is excluded: scrubbing a paused video is
    // not a request to play, and forcing it would tell the room to start.
    if (
      hasRecentExplicitSeek &&
      seekOrigin !== "paused" &&
      (argsForBroadcast.eventSource === "seeking" ||
        argsForBroadcast.eventSource === "seeked")
    ) {
      return "playing";
    }

    // The stall events that FOLLOW a seek are a different matter. They are never
    // tagged `explicit-seek`, and their `currentTime` is frozen at the target
    // rather than playing from it, so forcing them to `playing` publishes a
    // frozen position as a healthy one. That is tolerable when the seek came
    // from healthy playback — the stall is the seek's own momentary rebuffer and
    // resolves immediately — but not when this side was already stalled, where
    // it would drag members who already followed the jump back to the frozen
    // target, which is exactly the yank #189 removed.
    if (
      hasRecentExplicitSeek &&
      seekOrigin !== "buffering" &&
      args.runtimeState.intendedPlayState === "playing" &&
      (argsForBroadcast.eventSource === "pause" ||
        argsForBroadcast.eventSource === "waiting" ||
        argsForBroadcast.eventSource === "stalled")
    ) {
      return "playing";
    }

    if (
      basePlayState === "paused" &&
      args.runtimeState.pauseClassifiedAsBuffer &&
      args.runtimeState.pauseStartedAt > 0 &&
      argsForBroadcast.now - args.runtimeState.pauseStartedAt <
        args.bufferPauseUpgradeMs
    ) {
      return "buffering";
    }

    return basePlayState;
  }

  function shouldLogSuppressedBroadcastDetail(
    eventSource: LocalPlaybackEventSource,
  ): boolean {
    return !(
      eventSource === "timeupdate" ||
      eventSource === "canplay" ||
      eventSource === "playing" ||
      eventSource === "seeked"
    );
  }

  async function broadcastPlayback(
    video: HTMLVideoElement,
    eventSource: LocalPlaybackEventSource = "manual",
    naturalEnd?: boolean,
  ): Promise<void> {
    const now = nowOf();
    if (!args.runtimeState.hydrationReady) {
      args.debugLog("Skip broadcast before hydration ready");
      logBroadcastTrace(
        "before-hydration",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: null,
          normalizedCurrentVideoUrl: null,
          playState: getPlayState(video, args.runtimeState.intendedPlayState),
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        null,
      );
      return;
    }
    if (args.runtimeState.pendingRoomStateHydration) {
      if (
        !shouldSkipBroadcastWhileHydrating({
          pendingRoomStateHydration:
            args.runtimeState.pendingRoomStateHydration,
          now,
          lastUserGestureAt: args.runtimeState.lastUserGestureAt,
          userGestureGraceMs: args.userGestureGraceMs,
        })
      ) {
        args.debugLog(
          `Allowed user-initiated broadcast while waiting for initial room state of ${args.runtimeState.activeRoomCode ?? "unknown-room"}`,
        );
      } else {
        args.debugLog(
          `Skip broadcast while waiting for initial room state of ${args.runtimeState.activeRoomCode ?? "unknown-room"}`,
        );
        logBroadcastTrace(
          "hydration-gate",
          eventSource,
          formatBroadcastTrace({
            eventSource,
            currentVideoUrl: null,
            normalizedCurrentVideoUrl: null,
            playState: getPlayState(video, args.runtimeState.intendedPlayState),
            currentTime: video.currentTime,
            playbackRate: video.playbackRate,
          }),
          null,
          now,
        );
        return;
      }
    }

    const currentVideo = await args.getCurrentPlaybackVideo();
    if (!currentVideo) {
      logBroadcastTrace(
        "no-current-video",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: null,
          normalizedCurrentVideoUrl: null,
          playState: getPlayState(video, args.runtimeState.intendedPlayState),
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        null,
        now,
      );
      return;
    }
    const hasRecentExplicitResumeIntent =
      (args.runtimeState.lastExplicitUserAction?.kind === "play" ||
        args.runtimeState.lastExplicitUserAction?.kind === "seek") &&
      now - args.runtimeState.lastExplicitUserAction.at <
        args.userGestureGraceMs;
    const normalizedCurrentVideoUrl = args.normalizeUrl(currentVideo.url);
    logBroadcastTrace(
      "enter",
      eventSource,
      formatBroadcastTrace({
        eventSource,
        currentVideoUrl: currentVideo.url,
        normalizedCurrentVideoUrl,
        playState: getPlayState(video, args.runtimeState.intendedPlayState),
        currentTime: video.currentTime,
        playbackRate: video.playbackRate,
      }),
      normalizedCurrentVideoUrl,
      now,
    );
    // Sharer end-of-video handoff gate.
    //
    // When the local sharer's own shared video reaches its natural end, the
    // browser emits an end `pause`, and when Bilibili autoplays the next episode
    // into the same element before the page URL refreshes, a `seek` back to 0
    // while the page bridge still resolves the *old* shared URL. Broadcasting
    // either would relay a misleading "paused"/"jumped to 0:00" against the
    // still-shared old video to every peer, moments before the auto-share of the
    // next video lands. Suppress broadcasts for the ended shared URL until the
    // next share confirms (which clears the marker via resetPlaybackSyncState),
    // a fresh user gesture replays it, the page moves on to a different URL, or
    // the bounded timeout elapses.
    const sharerEndedUrl = args.runtimeState.sharerEndedSuppressionUrl;
    if (sharerEndedUrl) {
      const expired = now >= args.runtimeState.sharerEndedSuppressionUntil;
      const movedOn = normalizedCurrentVideoUrl !== sharerEndedUrl;
      // Only a gesture that postdates the arming counts as a fresh replay. An
      // older gesture (the sharer dragging to the end / pressing play just
      // before the natural end) precedes the next-episode seek-to-0 we are
      // suppressing, so treating it as a replay would leak that seek out.
      const userReplayed =
        now - args.runtimeState.lastUserGestureAt < args.userGestureGraceMs &&
        args.runtimeState.lastUserGestureAt >
          args.runtimeState.sharerEndedSuppressionArmedAt;
      // Once the local member is no longer the sharer of this URL (e.g. another
      // member re-shared the same URL, which updates the sharer id without
      // changing the URL and so does not run resetPlaybackSyncState), the
      // suppression must release so the new sharer's takeover can be reported.
      const ownershipLost =
        !args.runtimeState.localMemberId ||
        args.runtimeState.activeSharedByMemberId !==
          args.runtimeState.localMemberId;
      if (!expired && !movedOn && !userReplayed && !ownershipLost) {
        if (shouldLogSuppressedBroadcastDetail(eventSource)) {
          args.debugLog(
            `Skip broadcast ${formatPlaybackDiagnostic({
              actor: args.runtimeState.localMemberId,
              playState: getPlayState(
                video,
                args.runtimeState.intendedPlayState,
              ),
              url: currentVideo.url,
              localTime: video.currentTime,
              targetTime: video.currentTime,
              result: "sharer-ended-handoff",
              extra: `endedUrl=${sharerEndedUrl}`,
            })}`,
          );
        }
        logBroadcastTrace(
          "sharer-ended-handoff",
          eventSource,
          formatBroadcastTrace({
            eventSource,
            currentVideoUrl: currentVideo.url,
            normalizedCurrentVideoUrl,
            playState: getPlayState(video, args.runtimeState.intendedPlayState),
            currentTime: video.currentTime,
            playbackRate: video.playbackRate,
          }),
          normalizedCurrentVideoUrl,
          now,
        );
        return;
      }
      args.runtimeState.sharerEndedSuppressionUrl = null;
      args.runtimeState.sharerEndedSuppressionUntil = 0;
      args.runtimeState.sharerEndedSuppressionArmedAt = 0;
      args.debugLog(
        `Cleared sharer end-of-video suppression (was ${sharerEndedUrl}, expired=${expired} movedOn=${movedOn} userReplayed=${userReplayed} ownershipLost=${ownershipLost})`,
      );
    }
    // Post-navigation settle gate.
    //
    // After in-room SPA navigation, the page bridge can briefly return the
    // previous bangumi's ep_id (because `__INITIAL_STATE__` and friends have
    // not yet refreshed). Broadcasting playback events derived from that
    // stale URL would silently overwrite the existing shared video's state
    // for other clients. Hold off on broadcasts until the page bridge resolves
    // to a URL different from the pre-navigation anchor (or the room's shared
    // video changes via `applyRoomState`, which clears the anchor there). The
    // gate is also bounded by the initial hydration hold so equivalent
    // bangumi /ep and /ss route transitions cannot block broadcasts forever.
    const postNavigationAnchor =
      args.runtimeState.postNavigationAnchorSharedUrl;
    if (postNavigationAnchor) {
      const anchorAge =
        args.runtimeState.postNavigationAnchorSetAt > 0
          ? now - args.runtimeState.postNavigationAnchorSetAt
          : 0;
      if (anchorAge >= args.initialRoomStatePauseHoldMs) {
        args.runtimeState.postNavigationAnchorSharedUrl = null;
        args.runtimeState.postNavigationAnchorSetAt = 0;
        args.debugLog(
          `Cleared post-navigation settle anchor after timeout (was ${postNavigationAnchor}, age=${anchorAge})`,
        );
      } else if (
        normalizedCurrentVideoUrl === null ||
        normalizedCurrentVideoUrl === postNavigationAnchor
      ) {
        if (shouldLogSuppressedBroadcastDetail(eventSource)) {
          args.debugLog(
            `Skip broadcast ${formatPlaybackDiagnostic({
              actor: args.runtimeState.localMemberId,
              playState: getPlayState(
                video,
                args.runtimeState.intendedPlayState,
              ),
              url: currentVideo.url,
              localTime: video.currentTime,
              targetTime: video.currentTime,
              result: "post-navigation-stale-url",
              extra: `anchor=${postNavigationAnchor}`,
            })}`,
          );
        }
        logBroadcastTrace(
          "post-navigation-stale-url",
          eventSource,
          formatBroadcastTrace({
            eventSource,
            currentVideoUrl: currentVideo.url,
            normalizedCurrentVideoUrl,
            playState: getPlayState(video, args.runtimeState.intendedPlayState),
            currentTime: video.currentTime,
            playbackRate: video.playbackRate,
          }),
          normalizedCurrentVideoUrl,
          now,
        );
        return;
      }
      if (args.runtimeState.postNavigationAnchorSharedUrl) {
        args.runtimeState.postNavigationAnchorSharedUrl = null;
        args.runtimeState.postNavigationAnchorSetAt = 0;
        args.debugLog(
          `Cleared post-navigation settle anchor (was ${postNavigationAnchor}, now broadcasting ${normalizedCurrentVideoUrl})`,
        );
      }
    }
    if (
      args.runtimeState.activeRoomCode &&
      args.runtimeState.activeSharedUrl &&
      normalizedCurrentVideoUrl !== args.runtimeState.activeSharedUrl
    ) {
      if (
        normalizedCurrentVideoUrl !== args.runtimeState.lastNonSharedGuardUrl &&
        normalizedCurrentVideoUrl !== null
      ) {
        args.runtimeState.lastNonSharedGuardUrl = normalizedCurrentVideoUrl;
        args.runtimeState.lastExplicitPlaybackAction = null;
      }
      if (
        shouldPauseForNonSharedBroadcast({
          activeRoomCode: args.runtimeState.activeRoomCode,
          activeSharedUrl: args.runtimeState.activeSharedUrl,
          normalizedCurrentVideoUrl,
          explicitNonSharedPlaybackUrl:
            args.runtimeState.explicitNonSharedPlaybackUrl,
          playState: getPlayState(video, args.runtimeState.intendedPlayState),
          lastExplicitPlaybackAction:
            args.runtimeState.lastExplicitPlaybackAction,
          now,
          userGestureGraceMs: args.userGestureGraceMs,
        })
      ) {
        args.debugLog(
          `Suppressed non-shared playback broadcast for ${currentVideo.url}`,
        );
      }
      logBroadcastTrace(
        "non-shared-page",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState: getPlayState(video, args.runtimeState.intendedPlayState),
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
      );
      return;
    }

    args.runtimeState.lastNonSharedGuardUrl = null;

    const playState = getBroadcastPlayState({
      video,
      eventSource,
      now,
    });
    const hasExplicitUserActionAfterForcedPause = Boolean(
      args.runtimeState.lastExplicitUserAction &&
      args.runtimeState.lastExplicitUserAction.at >
        args.runtimeState.lastForcedPauseAt &&
      now - args.runtimeState.lastExplicitUserAction.at <
        args.userGestureGraceMs,
    );
    if (
      eventSource === "pause" &&
      playState === "paused" &&
      args.runtimeState.suppressedLocalEndPauseUrl &&
      now < args.runtimeState.suppressedLocalEndPauseUntil &&
      normalizedCurrentVideoUrl ===
        args.runtimeState.suppressedLocalEndPauseUrl &&
      !hasExplicitUserActionAfterForcedPause
    ) {
      args.debugLog(
        `Skip broadcast ${formatPlaybackDiagnostic({
          actor: args.runtimeState.localMemberId,
          playState,
          url: currentVideo.url,
          localTime: video.currentTime,
          targetTime: video.currentTime,
          result: "local-end-pause-suppress",
        })}`,
      );
      logBroadcastTrace(
        "local-end-pause-suppress",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
      );
      return;
    }
    if (
      args.runtimeState.suppressedLocalEndPauseUrl &&
      now >= args.runtimeState.suppressedLocalEndPauseUntil
    ) {
      args.runtimeState.suppressedLocalEndPauseUrl = null;
      args.runtimeState.suppressedLocalEndPauseUntil = 0;
    }
    const programmaticDecision = shouldSuppressProgrammaticEventGuard({
      programmaticApplyUntil: args.runtimeState.programmaticApplyUntil,
      programmaticApplyAt: args.runtimeState.programmaticApplyAt,
      programmaticApplyScope: args.runtimeState.programmaticApplyScope,
      programmaticApplySignature: args.runtimeState.programmaticApplySignature,
      normalizedCurrentUrl: normalizedCurrentVideoUrl,
      playState,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      eventSource,
      lastExplicitUserAction: args.runtimeState.lastExplicitUserAction,
      now,
      userGestureGraceMs: args.userGestureGraceMs,
    });
    args.runtimeState.programmaticApplyUntil =
      programmaticDecision.nextProgrammaticApplyUntil;
    args.runtimeState.programmaticApplySignature =
      programmaticDecision.nextProgrammaticApplySignature;
    if (programmaticDecision.shouldSuppress) {
      if (shouldLogSuppressedBroadcastDetail(eventSource)) {
        args.debugLog(
          `Skip broadcast ${formatPlaybackDiagnostic({
            actor: args.runtimeState.localMemberId,
            playState,
            url: currentVideo.url,
            localTime: video.currentTime,
            targetTime:
              programmaticDecision.nextProgrammaticApplySignature
                ?.currentTime ?? video.currentTime,
            result: `programmatic-${eventSource}`,
          })}`,
        );
      }
      logBroadcastTrace(
        "programmatic-suppress",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
      );
      return;
    }
    if (
      hasExplicitUserActionAfterForcedPause &&
      (eventSource === "play" ||
        eventSource === "playing" ||
        eventSource === "pause" ||
        eventSource === "seeking" ||
        eventSource === "seeked" ||
        eventSource === "ratechange")
    ) {
      args.debugLog(
        `Allowed explicit user event actor=${args.runtimeState.localMemberId ?? "local"} playState=${playState} url=${currentVideo.url} delta=n/a result=${eventSource}`,
      );
    }
    // A genuine non-playing state (real stall / pause) interrupting a *pure*
    // rate-only catch-up: abandon the catch-up before any suppression runs. This
    // restores the base rate so the authoritative payload carries the steady
    // rate (not the temporary catch-up rate), drops the active session so it
    // can no longer suppress the broadcast, and clears the remote-follow window
    // since a real local stall is positive evidence, not a follow echo. Without
    // this the buffering/paused would be swallowed and/or leak the catch-up rate
    // into room state.
    if (
      playState !== "playing" &&
      softApply.isActiveRateOnlyCatchUp(normalizedCurrentVideoUrl)
    ) {
      softApply.cancelActiveSoftApply(video, "buffer-interrupt");
      clearRemoteFollowPlayingWindow();
      args.debugLog(
        `Abandoned rate-only catch-up for real ${playState} url=${currentVideo.url} source=${eventSource}`,
      );
    }
    if (
      softApply.shouldSuppressActiveSoftApplyBroadcast({
        normalizedCurrentUrl: normalizedCurrentVideoUrl,
        playState,
        eventSource,
        now,
      })
    ) {
      args.debugLog(
        `Skip broadcast ${formatPlaybackDiagnostic({
          actor: args.runtimeState.localMemberId,
          playState,
          url: currentVideo.url,
          localTime: null,
          targetTime: video.currentTime,
          result: `soft-apply-follow-${eventSource}`,
        })}`,
      );
      logBroadcastTrace(
        "soft-apply-suppress",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
      );
      return;
    }
    if (
      shouldSuppressUnexpectedPlaybackRateBroadcast({
        playbackRate: video.playbackRate,
        currentVideoUrl: currentVideo.url,
        eventSource,
        now,
      })
    ) {
      logBroadcastTrace(
        "unexpected-rate-suppress",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
      );
      return;
    }
    const followupDecision = shouldSuppressRemoteFollowupBroadcastGuard({
      remoteFollowPlayingUntil: args.runtimeState.remoteFollowPlayingUntil,
      remoteFollowPlayingUrl: args.runtimeState.remoteFollowPlayingUrl,
      normalizedCurrentUrl: normalizedCurrentVideoUrl,
      playState,
      eventSource,
      lastExplicitUserAction: args.runtimeState.lastExplicitUserAction,
      now,
      userGestureGraceMs: args.userGestureGraceMs,
    });
    args.runtimeState.remoteFollowPlayingUntil =
      followupDecision.nextRemoteFollowPlayingUntil;
    args.runtimeState.remoteFollowPlayingUrl =
      followupDecision.nextRemoteFollowPlayingUrl;
    if (followupDecision.shouldSuppress) {
      if (shouldLogSuppressedBroadcastDetail(eventSource)) {
        args.debugLog(
          `Skip broadcast ${formatPlaybackDiagnostic({
            actor: args.runtimeState.localMemberId,
            playState,
            url: currentVideo.url,
            localTime: video.currentTime,
            targetTime: video.currentTime,
            result: `remote-follow-${eventSource}`,
          })}`,
        );
      }
      logBroadcastTrace(
        "remote-follow-suppress",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
      );
      return;
    }

    if (
      playState === "playing" &&
      hasRecentRemoteStopIntent(currentVideo.url) &&
      !hasRecentExplicitResumeIntent &&
      now - args.runtimeState.lastUserGestureAt >= args.userGestureGraceMs
    ) {
      args.debugLog(
        `Skip broadcast ${formatPlaybackDiagnostic({
          actor: args.runtimeState.localMemberId,
          playState,
          url: currentVideo.url,
          localTime: video.currentTime,
          targetTime: video.currentTime,
          result: "remote-stop-hold",
        })}`,
      );
      args.runtimeState.intendedPlayState = "paused";
      args.runtimeState.lastForcedPauseAt = now;
      window.setTimeout(() => {
        if (!video.paused) {
          pauseVideo(video);
        }
      }, 0);
      logBroadcastTrace(
        "remote-stop-hold",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
      );
      return;
    }
    if (shouldSuppressLocalEcho(video, currentVideo, playState)) {
      logBroadcastTrace(
        "local-echo-suppress",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
      );
      return;
    }
    if (
      shouldSuppressRemotePlayTransition(
        currentVideo,
        playState,
        video.currentTime,
      )
    ) {
      logBroadcastTrace(
        "remote-play-transition-suppress",
        eventSource,
        formatBroadcastTrace({
          eventSource,
          currentVideoUrl: currentVideo.url,
          normalizedCurrentVideoUrl,
          playState,
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
        }),
        normalizedCurrentVideoUrl,
        now,
      );
      return;
    }

    const syncIntent = derivePlaybackSyncIntent({
      eventSource,
      lastExplicitUserAction: args.runtimeState.lastExplicitUserAction,
      lastForcedPauseAt: args.runtimeState.lastForcedPauseAt,
      now,
      userGestureGraceMs: args.userGestureGraceMs,
    });
    const userInitiated = deriveUserInitiatedPause({
      eventSource,
      playState,
      lastExplicitUserAction: args.runtimeState.lastExplicitUserAction,
      lastForcedPauseAt: args.runtimeState.lastForcedPauseAt,
      programmaticApplyUntil: args.runtimeState.programmaticApplyUntil,
      // A ratechange-scoped window only restored a playback rate, so its
      // signature playState is incidental (it is whatever the element happened
      // to be doing) and must not veto the user-initiated flag on a real pause.
      programmaticApplyPlayState:
        args.runtimeState.programmaticApplyScope === "all"
          ? (args.runtimeState.programmaticApplySignature?.playState ?? null)
          : null,
      now,
      userGestureGraceMs: args.userGestureGraceMs,
    });

    // Collapse the burst a single player event produces. One stall emits
    // seeking/seeked/canplay (each broadcasting) plus their 120-180ms follow-up
    // re-broadcasts, so one hiccup shipped 8-9 identical `playback:update`
    // messages — all carrying the same frozen currentTime, only the seq
    // differing. Peers learn nothing from the repeats and it is the dominant
    // source of server rate-limit pressure.
    //
    // The skip must be a genuine no-op, so it requires the local state below to
    // already match what the duplicate would write: an identical payload that
    // would nonetheless move `intendedPlayState`/`intendedPlaybackRate` is still
    // sent. Anything peers act on differently — playState, url, rate, seek /
    // ratechange intent, the user-initiated and natural-end flags, or a
    // currentTime that actually advanced — makes this not a duplicate.
    const duplicate = roomConfirmedBroadcast;
    if (
      duplicate &&
      now - duplicate.at < args.duplicateBroadcastWindowMs &&
      duplicate.normalizedUrl === normalizedCurrentVideoUrl &&
      duplicate.playState === playState &&
      duplicate.syncIntent === syncIntent &&
      duplicate.userInitiated === userInitiated &&
      duplicate.naturalEnd === (naturalEnd === true) &&
      Math.abs(duplicate.currentTime - video.currentTime) <=
        DUPLICATE_BROADCAST_TIME_EPSILON_SECONDS &&
      Math.abs(duplicate.playbackRate - video.playbackRate) <= 0.01 &&
      args.runtimeState.intendedPlayState === playState &&
      Math.abs(args.runtimeState.intendedPlaybackRate - video.playbackRate) <=
        0.01
    ) {
      // Skipping the *message* must not skip the local-intent guard. That
      // window (playback-apply's `ignore-local-guard`) is what stops a stale
      // remote `playing` from overriding a pause we just made; the repeats a
      // player event emits used to keep pushing it forward, so dropping them
      // silently would shorten the protection.
      args.runtimeState.lastLocalIntentAt = now;
      args.runtimeState.lastLocalIntentPlayState = playState;
      logHeartbeatMessage(
        duplicateBroadcastLogState,
        `${playState}|${normalizedCurrentVideoUrl ?? currentVideo.url}`,
        `Skipped duplicate playback update playState=${playState} url=${currentVideo.url} t=${video.currentTime.toFixed(2)} source=${eventSource} sinceMs=${now - duplicate.at}`,
        now,
      );
      return;
    }

    args.markBroadcastAt(now);
    args.runtimeState.intendedPlayState = playState;
    args.runtimeState.intendedPlaybackRate = video.playbackRate;
    args.runtimeState.lastLocalIntentAt = now;
    args.runtimeState.lastLocalIntentPlayState = playState;
    const payload = createPlaybackBroadcastPayload({
      currentVideo,
      currentTime: video.currentTime,
      playState,
      syncIntent,
      naturalEnd,
      userInitiated,
      playbackRate: video.playbackRate,
      actorId: args.runtimeState.localMemberId ?? "local",
      seq: args.nextSeq(),
      now,
    });
    pendingLocalOverride.rememberPendingLocalPlaybackOverride(payload, now);

    if (eventSource === "timeupdate") {
      logHeartbeatMessage(
        dispatchPlaybackLogState,
        `${payload.playState}|${args.normalizeUrl(payload.url) ?? payload.url}|dispatch`,
        `Dispatch playback update actor=${payload.actorId} playState=${payload.playState} url=${payload.url} delta=0.00 result=dispatch seq=${payload.seq} source=${eventSource} intent=${payload.syncIntent ?? "none"} rate=${payload.playbackRate.toFixed(2)}`,
        now,
      );
    } else {
      args.debugLog(
        `Dispatch playback update actor=${payload.actorId} playState=${payload.playState} url=${payload.url} delta=0.00 result=dispatch seq=${payload.seq} source=${eventSource} intent=${payload.syncIntent ?? "none"} rate=${payload.playbackRate.toFixed(2)}`,
      );
    }

    const response = await args.runtimeSendMessage({
      type: "content:playback-update",
      payload,
    });
    if (response === null) {
      args.debugLog(
        `Dropped playback update actor=${payload.actorId} playState=${payload.playState} url=${payload.url} delta=0.00 result=no-response seq=${payload.seq} source=${eventSource} intent=${payload.syncIntent ?? "none"} rate=${payload.playbackRate.toFixed(2)}`,
      );
      return;
    }
    args.runtimeState.lastLocalPlaybackVersion = {
      serverTime: payload.serverTime,
      seq: payload.seq,
    };

    if (
      args.shouldLogHeartbeat(
        args.broadcastLogState,
        `${playState}|${args.normalizeUrl(currentVideo.url) ?? currentVideo.url}`,
        now,
      )
    ) {
      args.debugLog(
        `Broadcast playback ${formatPlaybackDiagnostic({
          actor: payload.actorId,
          playState,
          url: currentVideo.url,
          localTime: video.currentTime,
          targetTime: payload.currentTime,
          result: "broadcast",
          extra: `seq=${payload.seq} source=${eventSource} intent=${payload.syncIntent ?? "none"} rate=${payload.playbackRate.toFixed(2)}`,
        })}`,
      );
    }
  }

  const roomStateApplyController = createRoomStateApplyController({
    runtimeState: args.runtimeState,
    lastAppliedVersionByActor: args.lastAppliedVersionByActor,
    ignoredSelfPlaybackLogState: args.ignoredSelfPlaybackLogState,
    localIntentGuardMs: args.localIntentGuardMs,
    pauseHoldMs: args.pauseHoldMs,
    initialRoomStatePauseHoldMs: args.initialRoomStatePauseHoldMs,
    userGestureGraceMs: args.userGestureGraceMs,
    remotePauseDebounceMs: args.remotePauseDebounceMs,
    getNow: args.getNow,
    debugLog: args.debugLog,
    shouldLogHeartbeat: args.shouldLogHeartbeat,
    runtimeSendMessage: args.runtimeSendMessage,
    getVideoElement: args.getVideoElement,
    getSharedVideo: args.getSharedVideo,
    normalizeUrl: args.normalizeUrl,
    notifyRoomStateToasts: args.notifyRoomStateToasts,
    maybeShowSharedVideoToast: args.maybeShowSharedVideoToast,
    cancelActiveSoftApply: softApply.cancelActiveSoftApply,
    resetPlaybackSyncState,
    activatePauseHold,
    clearRemoteFollowPlayingWindow,
    acceptInitialRoomStateHydration,
    acceptInitialRoomStateHydrationIfPending,
    markInitialRoomStateReceived,
    logIgnoredRemotePlayback,
    getPendingLocalPlaybackOverrideDecision:
      pendingLocalOverride.getPendingLocalPlaybackOverrideDecision,
    shouldCancelActiveSoftApplyForPlayback:
      softApply.shouldCancelActiveSoftApplyForPlayback,
    shouldApplySelfPlayback,
    shouldIgnoreRemotePlaybackApply,
    shouldSuppressRemotePlaybackByCooldown: softApply.shouldSuppressByCooldown,
    rememberRemoteFollowPlayingWindow,
    rememberRemotePlaybackForSuppression,
    armProgrammaticApplyWindow,
    applyPendingPlaybackApplication,
    formatPlaybackDiagnostic,
  });

  /**
   * A `room:state` whose playback is attributed to us is the room telling us it
   * holds that exact state — the only acknowledgement in the protocol that a
   * `playback:update` actually landed. Record it as the dedupe baseline, then
   * hand the state to the normal apply path unchanged.
   */
  async function recordRoomConfirmedBroadcast(
    state: RoomState,
    shareToast?: SharedVideoToastPayload | null,
  ): Promise<void> {
    const playback = state.playback;
    if (
      playback &&
      args.runtimeState.localMemberId &&
      playback.actorId === args.runtimeState.localMemberId
    ) {
      roomConfirmedBroadcast = {
        normalizedUrl: args.normalizeUrl(playback.url),
        playState: playback.playState,
        syncIntent: playback.syncIntent,
        userInitiated: playback.userInitiated === true,
        naturalEnd: playback.naturalEnd === true,
        currentTime: playback.currentTime,
        playbackRate: playback.playbackRate,
        at: nowOf(),
      };
    }
    await roomStateApplyController.applyRoomState(state, shareToast);
  }

  return {
    resetPlaybackSyncState,
    hasRecentRemoteStopIntent,
    cancelActiveSoftApply: softApply.cancelActiveSoftApply,
    maintainActiveSoftApply: softApply.maintainActiveSoftApply,
    applyPendingPlaybackApplication,
    broadcastPlayback,
    applyRoomState: recordRoomConfirmedBroadcast,
    hydrateRoomState: roomStateApplyController.hydrateRoomState,
    scheduleHydrationRetry: roomStateApplyController.scheduleHydrationRetry,
    destroy() {
      softApply.destroy();
      roomStateApplyController.destroy();
    },
  };
}
