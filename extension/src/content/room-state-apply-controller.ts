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
  /**
   * Delay before applying a remote `paused` room state, to absorb the
   * "pause→play within ~1s" flicker emitted by peers experiencing buffer
   * stalls. When 0 the debounce is disabled and paused is applied
   * synchronously.
   */
  remotePauseDebounceMs?: number;
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
  const remotePauseDebounceMs = args.remotePauseDebounceMs ?? 0;
  const scheduleDeferTimer = (cb: () => void, ms: number): number | null => {
    if (
      typeof globalThis.window !== "undefined" &&
      typeof globalThis.window.setTimeout === "function"
    ) {
      return globalThis.window.setTimeout(cb, ms) as unknown as number;
    }
    if (typeof globalThis.setTimeout === "function") {
      return globalThis.setTimeout(cb, ms) as unknown as number;
    }
    return null;
  };
  const cancelDeferTimer = (id: number): void => {
    if (
      typeof globalThis.window !== "undefined" &&
      typeof globalThis.window.clearTimeout === "function"
    ) {
      globalThis.window.clearTimeout(id);
      return;
    }
    if (typeof globalThis.clearTimeout === "function") {
      globalThis.clearTimeout(id);
    }
  };
  const clearDeferredRemotePaused = (): void => {
    if (args.runtimeState.deferredRemotePausedTimerId !== null) {
      cancelDeferTimer(args.runtimeState.deferredRemotePausedTimerId);
      args.runtimeState.deferredRemotePausedTimerId = null;
    }
    args.runtimeState.deferredRemotePausedState = null;
  };

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
    fromDebounce = false,
  ): Promise<void> {
    // Before any other handling, decide whether an existing deferred paused
    // should be dropped because a newer room state has just arrived. We must
    // do this BEFORE deferring a new paused so that paused→paused chains
    // (e.g. duplicate paused echoes) don't accidentally drop themselves; the
    // version comparison only matters relative to the *currently-stashed*
    // deferred state.
    if (!fromDebounce && args.runtimeState.deferredRemotePausedState) {
      const deferredState = args.runtimeState.deferredRemotePausedState;
      const deferredPlayback = deferredState.playback;
      if (deferredPlayback) {
        if (!state.playback) {
          // Room emptied (no current playback) — the deferred snapshot's
          // sharedVideo no longer reflects reality. Letting the timer fire
          // would re-introduce the stale URL via the activeSharedUrl reset.
          clearDeferredRemotePaused();
          args.debugLog(
            `Dropped stale deferred paused seq=${deferredPlayback.seq} superseded by empty playback`,
          );
        } else {
          const sameUrl =
            args.normalizeUrl(state.playback.url) ===
            args.normalizeUrl(deferredPlayback.url);
          const closeT =
            Math.abs(
              state.playback.currentTime - deferredPlayback.currentTime,
            ) < 0.5;
          const isMatchingFlicker =
            state.playback.playState === "playing" && sameUrl && closeT;
          const isNewerVersion =
            state.playback.serverTime > deferredPlayback.serverTime ||
            (state.playback.serverTime === deferredPlayback.serverTime &&
              state.playback.seq > deferredPlayback.seq);
          if (isMatchingFlicker) {
            clearDeferredRemotePaused();
            args.debugLog(
              `Dropped flicker paused seq=${deferredPlayback.seq} superseded by playing seq=${state.playback.seq}`,
            );
          } else if (isNewerVersion) {
            // Any newer state supersedes the deferred paused — keeping it
            // would let the timer fire later and clobber freshly applied
            // state via the unconditional activeSharedUrl/intendedPlayState
            // reset further down.
            clearDeferredRemotePaused();
            args.debugLog(
              `Dropped stale deferred paused seq=${deferredPlayback.seq} superseded by ${state.playback.playState} seq=${state.playback.seq}`,
            );
          }
        }
      }
    }

    if (
      !fromDebounce &&
      remotePauseDebounceMs > 0 &&
      state.playback &&
      state.playback.playState === "paused" &&
      args.runtimeState.localMemberId !== null &&
      state.playback.actorId !== args.runtimeState.localMemberId
    ) {
      if (args.runtimeState.deferredRemotePausedTimerId !== null) {
        cancelDeferTimer(args.runtimeState.deferredRemotePausedTimerId);
        args.runtimeState.deferredRemotePausedTimerId = null;
      }
      const deferredPlayback = state.playback;
      args.runtimeState.deferredRemotePausedState = state;
      args.runtimeState.deferredRemotePausedTimerId = scheduleDeferTimer(() => {
        args.runtimeState.deferredRemotePausedTimerId = null;
        const pending = args.runtimeState.deferredRemotePausedState;
        args.runtimeState.deferredRemotePausedState = null;
        if (!pending || destroyed) {
          return;
        }
        // Freshness check: a newer version for this actor may have been
        // applied while we were deferring (when the newer state's URL or
        // t-delta didn't match the flicker shape). Re-entering applyRoomState
        // with the stale snapshot would hit the unconditional
        // activeSharedUrl/intendedPlayState reset and clobber the newer
        // state — so drop it here.
        const pendingPlayback = pending.playback;
        if (pendingPlayback) {
          const lastApplied = args.lastAppliedVersionByActor.get(
            pendingPlayback.actorId,
          );
          if (
            lastApplied &&
            (lastApplied.serverTime > pendingPlayback.serverTime ||
              (lastApplied.serverTime === pendingPlayback.serverTime &&
                lastApplied.seq >= pendingPlayback.seq))
          ) {
            args.debugLog(
              `Dropped deferred paused seq=${pendingPlayback.seq} at fire time (newer version ${lastApplied.seq} already applied)`,
            );
            return;
          }
        }
        void applyRoomState(pending, null, true);
      }, remotePauseDebounceMs);
      args.debugLog(
        `Deferred remote paused url=${deferredPlayback.url} seq=${deferredPlayback.seq} for ${remotePauseDebounceMs}ms`,
      );
      return;
    }

    args.notifyRoomStateToasts(state);
    args.maybeShowSharedVideoToast(shareToast, state);

    const currentVideo = args.getSharedVideo();
    const normalizedSharedUrl = args.normalizeUrl(state.sharedVideo?.url);
    const normalizedCurrentUrl = args.normalizeUrl(currentVideo?.url);
    const normalizedPlaybackUrl = args.normalizeUrl(state.playback?.url);

    // Lift the post-navigation settle anchor as soon as the room reports a
    // shared video that differs from what we recorded before navigation. This
    // covers the cases where the local user (or another member) successfully
    // re-shares to a new URL after SPA navigation, or where the room becomes
    // empty — in both situations the broadcast suppression is no longer
    // protecting against stale page-bridge data.
    if (
      args.runtimeState.postNavigationAnchorSharedUrl &&
      args.runtimeState.postNavigationAnchorSharedUrl !== normalizedSharedUrl
    ) {
      args.debugLog(
        `Cleared post-navigation settle anchor (was ${args.runtimeState.postNavigationAnchorSharedUrl}, room shared changed to ${normalizedSharedUrl ?? "none"})`,
      );
      args.runtimeState.postNavigationAnchorSharedUrl = null;
      args.runtimeState.postNavigationAnchorSetAt = 0;
    }

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
    clearDeferredRemotePaused();
  }

  return {
    applyRoomState,
    hydrateRoomState,
    scheduleHydrationRetry,
    destroy,
  };
}
