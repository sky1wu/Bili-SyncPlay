import type {
  PlaybackState,
  RoomState,
  SharedVideo,
} from "@bili-syncplay/protocol";
import type { SharedVideoToastPayload } from "../shared/messages";
import { decidePlaybackApplication } from "./playback-apply";
import {
  canApplyPlaybackImmediately,
  createProgrammaticPlaybackSignature,
  pauseVideo,
} from "./player-binding";
import type { ContentRuntimeState } from "./runtime-state";

export interface RoomStateApplyController {
  applyRoomState(
    state: RoomState,
    shareToast?: SharedVideoToastPayload | null,
  ): Promise<void>;
  hydrateRoomState(): Promise<void>;
  scheduleHydrationRetry(delayMs?: number): void;
  destroy(): void;
}

export function createRoomStateApplyController(args: {
  runtimeState: ContentRuntimeState;
  lastAppliedVersionByActor: Map<string, { serverTime: number; seq: number }>;
  ignoredSelfPlaybackLogState: { key: string | null; at: number };
  localIntentGuardMs: number;
  pauseHoldMs: number;
  initialRoomStatePauseHoldMs: number;
  userGestureGraceMs: number;
  getNow?: () => number;
  debugLog: (message: string) => void;
  shouldLogHeartbeat: (
    state: { key: string | null; at: number },
    key: string,
    now?: number,
  ) => boolean;
  runtimeSendMessage: <T>(message: unknown) => Promise<T | null>;
  getVideoElement: () => HTMLVideoElement | null;
  getSharedVideo: () => SharedVideo | null;
  normalizeUrl: (url: string | undefined | null) => string | null;
  notifyRoomStateToasts: (state: RoomState) => void;
  maybeShowSharedVideoToast: (
    toast: SharedVideoToastPayload | null | undefined,
    state: RoomState,
  ) => void;
  cancelActiveSoftApply: (
    video: HTMLVideoElement | null,
    reason: string,
  ) => void;
  resetPlaybackSyncState: (reason: string) => void;
  activatePauseHold: (durationMs?: number) => void;
  clearRemoteFollowPlayingWindow: () => void;
  acceptInitialRoomStateHydration: () => void;
  acceptInitialRoomStateHydrationIfPending: () => void;
  logIgnoredRemotePlayback: (argsForLog: {
    playback: PlaybackState;
    video: HTMLVideoElement;
    result: string;
    extra?: string;
  }) => void;
  getPendingLocalPlaybackOverrideDecision: (playback: PlaybackState | null) => {
    shouldIgnore: boolean;
    reason?: string;
    extra?: string;
  };
  shouldCancelActiveSoftApplyForPlayback: (
    playback: PlaybackState | null,
  ) => string | null;
  shouldApplySelfPlayback: (
    video: HTMLVideoElement,
    playback: PlaybackState,
  ) => boolean;
  shouldIgnoreRemotePlaybackApply: (
    video: HTMLVideoElement,
    playback: PlaybackState,
    isSelfPlayback: boolean,
  ) => boolean;
  shouldSuppressRemotePlaybackByCooldown: (
    video: HTMLVideoElement,
    playback: PlaybackState,
  ) => boolean;
  rememberRemoteFollowPlayingWindow: (playback: PlaybackState) => void;
  rememberRemotePlaybackForSuppression: (playback: PlaybackState) => void;
  armProgrammaticApplyWindow: (
    signature: ReturnType<typeof createProgrammaticPlaybackSignature>,
    reason: "pending" | "apply",
    actorId?: string,
  ) => void;
  applyPendingPlaybackApplication: (video: HTMLVideoElement) => void;
  formatPlaybackDiagnostic: (argsForLog: {
    actor?: string | null;
    playState: PlaybackState["playState"];
    url: string;
    localTime?: number | null;
    targetTime: number;
    result: string;
    extra?: string;
  }) => string;
}): RoomStateApplyController {
  const ignoredRoomStateLogState = { key: null as string | null, at: 0 };
  const nowOf = () => args.getNow?.() ?? Date.now();
  let hydrateRetryTimer: number | null = null;
  let destroyed = false;

  /**
   * When hydrating an empty room, suppress autoplay only if the video was not
   * already intentionally playing. This distinguishes two scenarios:
   *
   * - **In-room navigation**: the navigation controller sets
   *   `intendedPlayState = "paused"` before hydration, so autoplay from the
   *   browser's SPA transition is correctly suppressed.
   * - **Room creation on an already-playing page**: `intendedPlayState` is
   *   `"playing"` (updated by broadcast logic), so we skip suppression to
   *   avoid interrupting the user's active playback.
   *
   * The `lastUserGestureAt` check is retained here (unlike the simplified
   * `sync-guards` path) because the navigation controller already resets
   * gesture timestamps via `resetUserGestureState` on navigation — so this
   * check only has practical effect in non-navigation contexts where a genuine
   * recent gesture should be respected.
   */
  function maybeSuppressAutoplayForEmptyRoom(roomCode: string): void {
    const wasAlreadyIntendedPlaying =
      args.runtimeState.intendedPlayState === "playing";
    if (wasAlreadyIntendedPlaying) {
      return;
    }
    args.runtimeState.intendedPlayState = "paused";
    args.activatePauseHold(args.initialRoomStatePauseHoldMs);
    const video = args.getVideoElement();
    if (
      video &&
      !video.paused &&
      nowOf() - args.runtimeState.lastUserGestureAt >= args.userGestureGraceMs
    ) {
      args.debugLog(`Suppressed autoplay for empty room ${roomCode}`);
      pauseVideo(video);
    }
  }

  function scheduleHydrationRetry(delayMs = 350): void {
    if (destroyed || hydrateRetryTimer !== null) {
      return;
    }
    const timer = window.setTimeout(() => {
      hydrateRetryTimer = null;
      void hydrateRoomState();
    }, delayMs);
    hydrateRetryTimer = timer;
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
      lastLocalPlaybackVersion: args.runtimeState.lastLocalPlaybackVersion,
      localMemberId: args.runtimeState.localMemberId,
    });

    if (decision.kind === "empty-room") {
      args.cancelActiveSoftApply(args.getVideoElement(), "room-empty");
      args.runtimeState.activeSharedUrl = null;
      args.clearRemoteFollowPlayingWindow();
      if (decision.acceptedHydration) {
        args.debugLog(`Accepted empty room state for ${state.roomCode}`);
        maybeSuppressAutoplayForEmptyRoom(state.roomCode);
        args.acceptInitialRoomStateHydration();
      }
      return;
    }

    if (decision.kind === "no-current-video") {
      args.cancelActiveSoftApply(args.getVideoElement(), "no-current-video");
      return;
    }

    if (args.runtimeState.activeSharedUrl !== normalizedSharedUrl) {
      args.runtimeState.activeSharedUrl = normalizedSharedUrl ?? null;
      args.resetPlaybackSyncState(
        `shared url changed to ${state.sharedVideo?.url ?? "none"}`,
      );
      args.runtimeState.intendedPlayState = "paused";
      args.runtimeState.intendedPlaybackRate = 1;
      args.debugLog(
        `Reset local sync state for shared url ${state.sharedVideo?.url ?? "none"}`,
      );
    }

    if (decision.kind === "ignore-non-shared") {
      args.cancelActiveSoftApply(args.getVideoElement(), "non-shared-page");
      if (
        args.shouldLogHeartbeat(
          ignoredRoomStateLogState,
          `${normalizedSharedUrl ?? "none"}|${normalizedCurrentUrl ?? "none"}`,
        )
      ) {
        args.debugLog(
          `Ignored room state for ${state.sharedVideo?.url ?? "none"} on current page ${currentVideo?.url ?? "none"}`,
        );
      }
      if (decision.acceptedHydration) {
        args.acceptInitialRoomStateHydration();
        args.runtimeState.intendedPlayState = "paused";
        args.runtimeState.intendedPlaybackRate = 1;
        args.activatePauseHold(args.initialRoomStatePauseHoldMs);
        const video = args.getVideoElement();
        if (video && !video.paused && decision.shouldPauseNonSharedVideo) {
          args.runtimeState.lastForcedPauseAt = Date.now();
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
      args.acceptInitialRoomStateHydrationIfPending();
      args.logIgnoredRemotePlayback({
        playback: state.playback,
        video,
        result: "local-intent-guard",
        extra: `seq=${state.playback.seq} localIntent=${args.runtimeState.lastLocalIntentPlayState ?? "none"}`,
      });
      return;
    }

    const pendingLocalPlaybackOverrideDecision =
      args.getPendingLocalPlaybackOverrideDecision(state.playback);
    if (pendingLocalPlaybackOverrideDecision.shouldIgnore) {
      args.acceptInitialRoomStateHydrationIfPending();
      args.logIgnoredRemotePlayback({
        playback: state.playback,
        video,
        result:
          pendingLocalPlaybackOverrideDecision.reason ??
          "pending-local-playback-override",
        extra: pendingLocalPlaybackOverrideDecision.extra,
      });
      return;
    }

    if (decision.kind === "ignore-stale-playback") {
      args.acceptInitialRoomStateHydrationIfPending();
      args.logIgnoredRemotePlayback({
        playback: state.playback,
        video,
        result: "stale-playback",
        extra: `seq=${state.playback.seq}`,
      });
      return;
    }

    if (decision.kind === "ignore-self-playback-version") {
      args.acceptInitialRoomStateHydrationIfPending();
      if (
        args.shouldLogHeartbeat(
          args.ignoredSelfPlaybackLogState,
          `${state.playback.actorId}|${state.playback.seq}|${args.normalizeUrl(state.playback.url) ?? state.playback.url}`,
        )
      ) {
        args.debugLog(
          `Ignored self playback ${args.formatPlaybackDiagnostic({
            actor: state.playback.actorId,
            playState: state.playback.playState,
            url: state.playback.url,
            localTime: video.currentTime,
            targetTime: state.playback.currentTime,
            result: "self-playback-version-noop",
            extra: `seq=${state.playback.seq} localSeq=${args.runtimeState.lastLocalPlaybackVersion?.seq ?? "none"}`,
          })}`,
        );
      }
      return;
    }

    const softApplyCancelReason = args.shouldCancelActiveSoftApplyForPlayback(
      state.playback,
    );
    if (softApplyCancelReason) {
      args.cancelActiveSoftApply(video, softApplyCancelReason);
    }

    args.lastAppliedVersionByActor.set(state.playback.actorId, {
      serverTime: state.playback.serverTime,
      seq: state.playback.seq,
    });

    if (
      decision.isSelfPlayback &&
      !args.shouldApplySelfPlayback(video, state.playback)
    ) {
      if (
        args.shouldLogHeartbeat(
          args.ignoredSelfPlaybackLogState,
          `${state.playback.actorId}|${state.playback.playState}|${args.normalizeUrl(state.playback.url) ?? state.playback.url}`,
        )
      ) {
        args.debugLog(
          `Ignored self playback ${args.formatPlaybackDiagnostic({
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

    if (
      args.shouldIgnoreRemotePlaybackApply(
        video,
        state.playback,
        decision.isSelfPlayback,
      )
    ) {
      args.acceptInitialRoomStateHydrationIfPending();
      args.rememberRemoteFollowPlayingWindow(state.playback);
      args.runtimeState.intendedPlayState = state.playback.playState;
      args.runtimeState.intendedPlaybackRate = state.playback.playbackRate;
      args.logIgnoredRemotePlayback({
        playback: state.playback,
        video,
        result: "within-threshold-noop",
        extra: `seq=${state.playback.seq}`,
      });
      return;
    }

    if (args.shouldSuppressRemotePlaybackByCooldown(video, state.playback)) {
      args.acceptInitialRoomStateHydrationIfPending();
      args.runtimeState.intendedPlayState = state.playback.playState;
      args.runtimeState.intendedPlaybackRate = state.playback.playbackRate;
      args.logIgnoredRemotePlayback({
        playback: state.playback,
        video,
        result: "cooldown-suppress",
        extra: `seq=${state.playback.seq} cooldownUntil=${args.runtimeState.softApplyCooldownUntil}`,
      });
      return;
    }

    args.rememberRemotePlaybackForSuppression(state.playback);
    if (
      state.playback.playState === "paused" ||
      state.playback.playState === "buffering"
    ) {
      args.clearRemoteFollowPlayingWindow();
      args.activatePauseHold(
        args.runtimeState.pendingRoomStateHydration ||
          !args.runtimeState.hasReceivedInitialRoomState
          ? args.initialRoomStatePauseHoldMs
          : args.pauseHoldMs,
      );
    } else if (!decision.isSelfPlayback) {
      args.rememberRemoteFollowPlayingWindow(state.playback);
    }

    args.runtimeState.intendedPlayState = state.playback.playState;
    args.runtimeState.intendedPlaybackRate = state.playback.playbackRate;
    args.debugLog(
      `Apply playback ${args.formatPlaybackDiagnostic({
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
    if (canApplyPlaybackImmediately(video)) {
      args.applyPendingPlaybackApplication(video);
    } else {
      args.armProgrammaticApplyWindow(
        createProgrammaticPlaybackSignature(state.playback),
        "pending",
        state.playback.actorId,
      );
      args.debugLog(
        `Deferred playback apply until metadata is ready ${state.sharedVideo.url}`,
      );
    }

    args.acceptInitialRoomStateHydration();
  }

  async function hydrateRoomState(): Promise<void> {
    if (destroyed) {
      return;
    }
    if (hydrateRetryTimer !== null) {
      window.clearTimeout(hydrateRetryTimer);
      hydrateRetryTimer = null;
    }

    const response = await args.runtimeSendMessage<{
      ok?: boolean;
      roomState?: RoomState;
      memberId?: string | null;
      roomCode?: string | null;
    }>({
      type: "content:get-room-state",
    });
    if (destroyed || response === null) {
      if (!destroyed) args.runtimeState.hydrationReady = true;
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
        args.activatePauseHold(args.initialRoomStatePauseHoldMs);
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

  function destroy(): void {
    destroyed = true;
    if (hydrateRetryTimer !== null) {
      window.clearTimeout(hydrateRetryTimer);
      hydrateRetryTimer = null;
    }
  }

  return {
    applyRoomState,
    hydrateRoomState,
    scheduleHydrationRetry,
    destroy,
  };
}
