import type {
  PlaybackState,
  RoomState,
  SharedVideo,
} from "@bili-syncplay/protocol";
import type { SharedVideoToastPayload } from "../shared/messages";
import { decidePlaybackApplication } from "./playback-apply";
import {
  createPlaybackBroadcastPayload,
  shouldPauseForNonSharedBroadcast,
  shouldSkipBroadcastWhileHydrating,
} from "./playback-broadcast";
import {
  applyPendingPlaybackApplication as applyPendingPlaybackApplicationWithBinding,
  canApplyPlaybackImmediately,
  createProgrammaticPlaybackSignature,
  getPlayState,
  pauseVideo,
} from "./player-binding";
import {
  hasRecentRemoteStopIntent as hasRecentRemoteStopIntentGuard,
  rememberRemotePlaybackForSuppression as rememberRemotePlaybackForSuppressionGuard,
  shouldApplySelfPlayback as shouldApplySelfPlaybackGuard,
  shouldSuppressLocalEcho as shouldSuppressLocalEchoGuard,
  shouldSuppressProgrammaticEvent as shouldSuppressProgrammaticEventGuard,
  shouldSuppressRemotePlayTransition as shouldSuppressRemotePlayTransitionGuard,
} from "./sync-guards";
import type {
  ContentRuntimeState,
  LocalPlaybackEventSource,
} from "./runtime-state";

export interface SyncController {
  resetPlaybackSyncState(reason: string): void;
  hasRecentRemoteStopIntent(currentVideoUrl: string): boolean;
  applyPendingPlaybackApplication(video: HTMLVideoElement): void;
  broadcastPlayback(
    video: HTMLVideoElement,
    eventSource?: LocalPlaybackEventSource,
  ): Promise<void>;
  applyRoomState(
    state: RoomState,
    shareToast?: SharedVideoToastPayload | null,
  ): Promise<void>;
  hydrateRoomState(): Promise<void>;
  scheduleHydrationRetry(delayMs?: number): void;
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
  programmaticApplyWindowMs: number;
  userGestureGraceMs: number;
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
  getHydrateRetryTimer: () => number | null;
  setHydrateRetryTimer: (timer: number | null) => void;
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

  function formatPlaybackDiagnostic(args: {
    actor?: string | null;
    playState: PlaybackState["playState"];
    url: string;
    localTime?: number | null;
    targetTime: number;
    result: string;
    extra?: string;
  }): string {
    const localTime = args.localTime ?? null;
    const delta =
      localTime === null ? "n/a" : Math.abs(localTime - args.targetTime).toFixed(2);
    const parts = [
      `actor=${args.actor ?? "unknown"}`,
      `playState=${args.playState}`,
      `url=${args.url}`,
      `delta=${delta}`,
      `result=${args.result}`,
    ];
    if (args.extra) {
      parts.push(args.extra);
    }
    return parts.join(" ");
  }

  function activatePauseHold(durationMs = args.pauseHoldMs): void {
    args.runtimeState.pauseHoldUntil = nowOf() + durationMs;
  }

  function armProgrammaticApplyWindow(
    playback: PlaybackState,
    reason: "pending" | "apply",
  ): void {
    const signature = createProgrammaticPlaybackSignature(playback);
    args.runtimeState.programmaticApplySignature = signature;
    args.runtimeState.programmaticApplyUntil =
      nowOf() + args.programmaticApplyWindowMs;
    args.debugLog(
      `Programmatic apply window armed actor=${playback.actorId} playState=${playback.playState} url=${playback.url} delta=n/a result=${reason} until=${args.runtimeState.programmaticApplyUntil}`,
    );
  }

  function resetPlaybackSyncState(reason: string): void {
    args.lastAppliedVersionByActor.clear();
    args.runtimeState.suppressedRemotePlayback = null;
    args.runtimeState.recentRemotePlayingIntent = null;
    args.runtimeState.pendingPlaybackApplication = null;
    args.runtimeState.programmaticApplyUntil = 0;
    args.runtimeState.programmaticApplySignature = null;
    args.debugLog(`Reset playback sync state: ${reason}`);
  }

  function scheduleHydrationRetry(delayMs = 350): void {
    if (args.getHydrateRetryTimer() !== null) {
      return;
    }
    const timer = window.setTimeout(() => {
      args.setHydrateRetryTimer(null);
      void hydrateRoomState();
    }, delayMs);
    args.setHydrateRetryTimer(timer);
  }

  function applyPendingPlaybackApplication(video: HTMLVideoElement): void {
    applyPendingPlaybackApplicationWithBinding({
      video,
      pendingPlaybackApplication: args.runtimeState.pendingPlaybackApplication,
      clearPendingPlaybackApplication: () => {
        args.runtimeState.pendingPlaybackApplication = null;
      },
      markProgrammaticApply: (_signature, playback) => {
        armProgrammaticApplyWindow(playback, "apply");
      },
      debugLog: args.debugLog,
    });
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
    args.debugLog(
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

  async function broadcastPlayback(
    video: HTMLVideoElement,
    eventSource: LocalPlaybackEventSource = "manual",
  ): Promise<void> {
    if (!args.runtimeState.hydrationReady) {
      args.debugLog("Skip broadcast before hydration ready");
      return;
    }
    const now = nowOf();
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
        return;
      }
    }

    const currentVideo = await args.getCurrentPlaybackVideo();
    if (!currentVideo) {
      return;
    }
    const normalizedCurrentVideoUrl = args.normalizeUrl(currentVideo.url);
    if (
      args.runtimeState.activeRoomCode &&
      args.runtimeState.activeSharedUrl &&
      normalizedCurrentVideoUrl !== args.runtimeState.activeSharedUrl
    ) {
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
        args.runtimeState.intendedPlayState = "paused";
        activatePauseHold(args.initialRoomStatePauseHoldMs);
        window.setTimeout(() => {
          if (!video.paused) {
            pauseVideo(video);
          }
        }, 0);
      }
      return;
    }

    args.markBroadcastAt(now);
    const playState = getPlayState(video, args.runtimeState.intendedPlayState);
    const programmaticDecision = shouldSuppressProgrammaticEventGuard({
      programmaticApplyUntil: args.runtimeState.programmaticApplyUntil,
      programmaticApplySignature: args.runtimeState.programmaticApplySignature,
      normalizedCurrentUrl: normalizedCurrentVideoUrl,
      playState,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      eventSource,
      now,
    });
    args.runtimeState.programmaticApplyUntil =
      programmaticDecision.nextProgrammaticApplyUntil;
    args.runtimeState.programmaticApplySignature =
      programmaticDecision.nextProgrammaticApplySignature;
    if (programmaticDecision.shouldSuppress) {
      args.debugLog(
        `Skip broadcast ${formatPlaybackDiagnostic({
          actor: args.runtimeState.localMemberId,
          playState,
          url: currentVideo.url,
          localTime: video.currentTime,
          targetTime:
            programmaticDecision.nextProgrammaticApplySignature?.currentTime ??
            video.currentTime,
          result: `programmatic-${eventSource}`,
        })}`,
      );
      return;
    }

    if (
      playState === "playing" &&
      hasRecentRemoteStopIntent(currentVideo.url) &&
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
      window.setTimeout(() => {
        if (!video.paused) {
          pauseVideo(video);
        }
      }, 0);
      return;
    }
    if (shouldSuppressLocalEcho(video, currentVideo, playState)) {
      return;
    }
    if (
      shouldSuppressRemotePlayTransition(
        currentVideo,
        playState,
        video.currentTime,
      )
    ) {
      return;
    }

    args.runtimeState.intendedPlayState = playState;
    args.runtimeState.lastLocalIntentAt = now;
    args.runtimeState.lastLocalIntentPlayState = playState;

    const payload = createPlaybackBroadcastPayload({
      currentVideo,
      currentTime: video.currentTime,
      playState,
      playbackRate: video.playbackRate,
      actorId: args.runtimeState.localMemberId ?? "local",
      seq: args.nextSeq(),
      now,
    });

    const response = await args.runtimeSendMessage({
      type: "content:playback-update",
      payload,
    });
    if (response === null) {
      return;
    }
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
          extra: `seq=${payload.seq}`,
        })}`,
      );
    }
  }

  async function applyRoomState(
    state: RoomState,
    shareToast: SharedVideoToastPayload | null = null,
  ): Promise<void> {
    args.notifyRoomStateToasts(state);
    args.maybeShowSharedVideoToast(shareToast, state);

    const currentVideo = args.getSharedVideo();
    const normalizedSharedUrl = args.normalizeUrl(state.sharedVideo?.url);
    const normalizedCurrentUrl = args.normalizeUrl(currentVideo?.url);
    const normalizedPlaybackUrl = args.normalizeUrl(state.playback?.url);

    const decision = decidePlaybackApplication({
      roomState: state,
      currentVideo,
      normalizedSharedUrl,
      normalizedCurrentUrl,
      normalizedPlaybackUrl,
      pendingRoomStateHydration: args.runtimeState.pendingRoomStateHydration,
      explicitNonSharedPlaybackUrl:
        args.runtimeState.explicitNonSharedPlaybackUrl,
      now: nowOf(),
      lastLocalIntentAt: args.runtimeState.lastLocalIntentAt,
      lastLocalIntentPlayState: args.runtimeState.lastLocalIntentPlayState,
      localIntentGuardMs: args.localIntentGuardMs,
      lastAppliedVersion: state.playback
        ? (args.lastAppliedVersionByActor.get(state.playback.actorId) ?? null)
        : null,
      localMemberId: args.runtimeState.localMemberId,
    });

    if (decision.kind === "empty-room") {
      args.runtimeState.activeSharedUrl = null;
      if (decision.acceptedHydration) {
        args.debugLog(`Accepted empty room state for ${state.roomCode}`);
        args.runtimeState.pendingRoomStateHydration = false;
        args.runtimeState.hasReceivedInitialRoomState = true;
      }
      return;
    }

    if (decision.kind === "no-current-video") {
      return;
    }

    if (args.runtimeState.activeSharedUrl !== normalizedSharedUrl) {
      args.runtimeState.activeSharedUrl = normalizedSharedUrl ?? null;
      resetPlaybackSyncState(
        `shared url changed to ${state.sharedVideo?.url ?? "none"}`,
      );
      args.runtimeState.intendedPlayState = "paused";
      args.debugLog(
        `Reset local sync state for shared url ${state.sharedVideo?.url ?? "none"}`,
      );
    }

    if (decision.kind === "ignore-non-shared") {
      args.debugLog(
        `Ignored room state for ${state.sharedVideo?.url ?? "none"} on current page ${currentVideo?.url ?? "none"}`,
      );
      if (decision.acceptedHydration) {
        args.runtimeState.hasReceivedInitialRoomState = true;
        args.runtimeState.pendingRoomStateHydration = false;
        args.runtimeState.intendedPlayState = "paused";
        activatePauseHold(args.initialRoomStatePauseHoldMs);
        const video = args.getVideoElement();
        if (video && !video.paused && decision.shouldPauseNonSharedVideo) {
          pauseVideo(video);
        }
      }
      return;
    }

    const video = args.getVideoElement();
    if (!video) {
      args.debugLog(
        `Deferred room state because video element is not ready for ${state.sharedVideo.url}`,
      );
      scheduleHydrationRetry();
      return;
    }

    if (decision.kind === "ignore-local-guard") {
      args.debugLog(
        `Ignored remote playback ${formatPlaybackDiagnostic({
          actor: state.playback.actorId,
          playState: state.playback.playState,
          url: state.playback.url,
          localTime: video.currentTime,
          targetTime: state.playback.currentTime,
          result: "local-intent-guard",
          extra: `seq=${state.playback.seq} localIntent=${args.runtimeState.lastLocalIntentPlayState ?? "none"}`,
        })}`,
      );
      return;
    }

    if (decision.kind === "ignore-stale-playback") {
      args.debugLog(
        `Ignored remote playback ${formatPlaybackDiagnostic({
          actor: state.playback.actorId,
          playState: state.playback.playState,
          url: state.playback.url,
          localTime: video.currentTime,
          targetTime: state.playback.currentTime,
          result: "stale-playback",
          extra: `seq=${state.playback.seq}`,
        })}`,
      );
      return;
    }

    args.lastAppliedVersionByActor.set(state.playback.actorId, {
      serverTime: state.playback.serverTime,
      seq: state.playback.seq,
    });

    if (
      decision.isSelfPlayback &&
      !shouldApplySelfPlayback(video, state.playback)
    ) {
      if (
        args.shouldLogHeartbeat(
          args.ignoredSelfPlaybackLogState,
          `${state.playback.actorId}|${state.playback.playState}|${args.normalizeUrl(state.playback.url) ?? state.playback.url}`,
        )
      ) {
        args.debugLog(
          `Ignored self playback ${formatPlaybackDiagnostic({
            actor: state.playback.actorId,
            playState: state.playback.playState,
            url: state.playback.url,
            localTime: video.currentTime,
            targetTime: state.playback.currentTime,
            result: "self-playback-noop",
            extra: `seq=${state.playback.seq} localPaused=${video.paused}`,
          })}`,
        );
      }
      return;
    }

    rememberRemotePlaybackForSuppression(state.playback);
    if (
      state.playback.playState === "paused" ||
      state.playback.playState === "buffering"
    ) {
      activatePauseHold(
        args.runtimeState.pendingRoomStateHydration ||
          !args.runtimeState.hasReceivedInitialRoomState
          ? args.initialRoomStatePauseHoldMs
          : args.pauseHoldMs,
      );
    }

    args.runtimeState.intendedPlayState = state.playback.playState;
    args.debugLog(
      `Apply playback ${formatPlaybackDiagnostic({
        actor: state.playback.actorId,
        playState: state.playback.playState,
        url: state.sharedVideo.url,
        localTime: video.currentTime,
        targetTime: state.playback.currentTime,
        result: "apply",
        extra: `seq=${state.playback.seq}`,
      })}`,
    );

    args.runtimeState.pendingPlaybackApplication = { ...state.playback };
    armProgrammaticApplyWindow(state.playback, "pending");
    if (canApplyPlaybackImmediately(video)) {
      applyPendingPlaybackApplication(video);
    } else {
      args.debugLog(
        `Deferred playback apply until metadata is ready ${state.sharedVideo.url}`,
      );
    }

    args.runtimeState.pendingRoomStateHydration = false;
    args.runtimeState.hasReceivedInitialRoomState = true;
  }

  async function hydrateRoomState(): Promise<void> {
    const retryTimer = args.getHydrateRetryTimer();
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      args.setHydrateRetryTimer(null);
    }

    const response = await args.runtimeSendMessage<{
      ok?: boolean;
      roomState?: RoomState;
      memberId?: string | null;
      roomCode?: string | null;
    }>({
      type: "content:get-room-state",
    });
    if (response === null) {
      args.runtimeState.hydrationReady = true;
      return;
    }
    args.runtimeState.localMemberId = response?.memberId ?? null;
    args.runtimeState.activeRoomCode =
      response?.roomCode ?? args.runtimeState.activeRoomCode;

    if (response?.ok && response.roomState) {
      args.debugLog(
        `Hydrate room state success for ${response.roomState.roomCode}`,
      );
      if (
        response.roomState.playback?.playState === "paused" ||
        response.roomState.playback?.playState === "buffering"
      ) {
        args.runtimeState.intendedPlayState =
          response.roomState.playback.playState;
        activatePauseHold(args.initialRoomStatePauseHoldMs);
      }
      const video = args.getVideoElement();
      if (
        video &&
        !video.paused &&
        (response.roomState.playback?.playState === "paused" ||
          response.roomState.playback?.playState === "buffering") &&
        nowOf() - args.runtimeState.lastUserGestureAt >= args.userGestureGraceMs
      ) {
        args.runtimeState.intendedPlayState =
          response.roomState.playback.playState;
        args.debugLog(
          `Suppressed autoplay during hydrate for ${response.roomState.roomCode}`,
        );
        pauseVideo(video);
      }
      await applyRoomState(response.roomState as RoomState);
      args.runtimeState.hydrationReady = true;
      return;
    }

    if (!response?.roomCode) {
      args.runtimeState.pendingRoomStateHydration = false;
    }

    if (!response?.memberId) {
      args.debugLog("Hydrate skipped without member id");
      args.runtimeState.hydrationReady = true;
      return;
    }

    args.debugLog(
      `Hydrate pending for ${response.roomCode ?? args.runtimeState.activeRoomCode ?? "unknown-room"}, retry scheduled`,
    );
    scheduleHydrationRetry(1500);
  }

  return {
    resetPlaybackSyncState,
    hasRecentRemoteStopIntent,
    applyPendingPlaybackApplication,
    broadcastPlayback,
    applyRoomState,
    hydrateRoomState,
    scheduleHydrationRetry,
  };
}
