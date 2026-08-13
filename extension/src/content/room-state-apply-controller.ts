import type {
  PlaybackState,
  RoomState,
  SharedVideo,
} from "@bili-syncplay/protocol";
import type {
  RoomStateHydrationResponse,
  SharedVideoToastPayload,
} from "../shared/messages";
import { decidePlaybackApplication } from "./playback-apply";
import {
  canApplyPlaybackImmediately,
  createProgrammaticPlaybackSignature,
  forcePauseVideo,
} from "./player-binding";
import { setRoomMembership, type ContentRuntimeState } from "./runtime-state";

/**
 * Ceiling for the exponential hydration-retry backoff.
 *
 * Every wait this retry serves is unbounded — the page bridge, the `<video>`
 * element, the room state itself — and none is guaranteed to arrive, so the
 * retry must decay rather than re-arm a fixed delay forever: a tab whose player
 * never produced a `<video>` used to re-hydrate every 350ms for the life of the
 * tab, and each pass reached the server (#229).
 *
 * The ceiling is a real latency, not a formality: it is the worst case before a
 * wait that has NO terminating event notices the world changed. Only one of
 * these waits has such an event — `notifyVideoElementBound` for the `<video>`
 * element. The page-bridge identity behind `no-current-video` has none and
 * cannot cheaply get one: `getSharedVideo()` derives from `location`, the
 * document title and the DOM on every call, so there is no update to hook, and
 * adding a watcher would recreate the duplicate poller this change removed.
 *
 * So it is sized as if every wait were timer-only. 10s means a stuck tab wakes
 * 6 times/min; the limiter allows 36/min per browser session (tabs share one
 * WebSocket, so they share one limiter), leaving headroom for six simultaneously
 * stuck tabs before anything is rejected. For comparison the pre-fix spin sent
 * ~171/min from a single tab.
 */
const HYDRATION_RETRY_MAX_DELAY_MS = 10_000;

/**
 * Base delay for the hydration re-armed by a `<video>` element binding. Short
 * enough to read as immediate, but routed through the backoff so a player that
 * rebuilds its element in a loop cannot drive one hydration per rebuild.
 */
const BOUND_VIDEO_HYDRATION_DELAY_MS = 50;

export interface RoomStateApplyController {
  applyRoomState(
    state: RoomState,
    shareToast?: SharedVideoToastPayload | null,
  ): Promise<void>;
  hydrateRoomState(): Promise<void>;
  scheduleHydrationRetry(delayMs?: number): void;
  notifyVideoElementBound(): void;
  resetHydrationRetry(): void;
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
  /**
   * Monotonic time source for the hydration retry deadline. Must not be the
   * wall clock — see {@link preemptHydrationRetry}.
   */
  getMonotonicNow?: () => number;
  debugLog: (message: string) => void;
  shouldLogHeartbeat: (
    state: { key: string | null; at: number },
    key: string,
    now?: number,
  ) => boolean;
  /** 发 `content:get-room-state` 并等其响应。 */
  requestRoomStateHydration: () => Promise<RoomStateHydrationResponse | null>;
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
  markInitialRoomStateReceived: () => void;
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
  const monotonicNow = () => args.getMonotonicNow?.() ?? performance.now();
  let hydrateRetryTimer: number | null = null;
  /**
   * When the pending retry is due, or `null` when none is armed. Kept beside
   * the timer id — and only ever cleared through `clearHydrationRetryTimer` —
   * so `preemptHydrationRetry` can refuse to push the deadline later.
   */
  let hydrateRetryDeadline: number | null = null;
  let hydrateRetryAttempt = 0;
  let boundVideoAttempt = 0;
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
  const isPausedOrBufferingPlayback = (
    playback: PlaybackState | null,
  ): playback is PlaybackState =>
    playback?.playState === "paused" || playback?.playState === "buffering";
  const shouldPreserveInitialPauseProtection = (input: {
    currentVideo: SharedVideo | null;
    playback: PlaybackState | null;
    normalizedSharedUrl: string | null;
    normalizedCurrentUrl: string | null;
    normalizedPlaybackUrl: string | null;
  }): boolean => {
    if (
      !isPausedOrBufferingPlayback(input.playback) ||
      !input.normalizedSharedUrl ||
      input.normalizedPlaybackUrl !== input.normalizedSharedUrl
    ) {
      return false;
    }

    return (
      !input.currentVideo ||
      !input.normalizedCurrentUrl ||
      input.normalizedCurrentUrl === input.normalizedSharedUrl
    );
  };
  /**
   * Switch `activeSharedUrl` to a new shared video and clear any playback sync
   * state stranded by the previous shared video. Mirrors the reset performed on
   * the main `applyRoomState` apply path so the early pause-protection paths
   * (page-bridge-not-ready hydration) cannot leave a previous video's
   * `pendingPlaybackApplication`, soft-apply, or local override active on the
   * new shared page — which could otherwise be applied after the new video's
   * `loadedmetadata`. No-op when the shared URL is unchanged.
   */
  const switchActiveSharedUrlWithReset = (
    normalizedSharedUrl: string | null,
    sharedVideoUrl: string | null | undefined,
    sharedByMemberId: string | null | undefined,
  ): void => {
    const previousSharedByMemberId = args.runtimeState.activeSharedByMemberId;
    args.runtimeState.activeSharedByMemberId = sharedByMemberId ?? null;
    // Clear the resolved identity tracked for a bare-route festival share when the
    // share changes owner, even if its (bare) URL is unchanged: another member
    // re-sharing the same `/festival/<id>` route makes the previous sharer's
    // resolved `/video/A` anchor stale. Leaving it set would let a same-page A→B
    // autoplay be misclassified as the current room share's autoplay (wrongly
    // pausing/holding a non-sharer). The shared-url-changed reset below covers the
    // differing-URL case; this covers the same-URL ownership transfer that returns
    // early before reaching it.
    if ((sharedByMemberId ?? null) !== previousSharedByMemberId) {
      args.runtimeState.resolvedSharedVideoUrl = null;
    }
    // Clear the chained auto-share target once the room confirms it, or once
    // another member takes over the share: the in-flight chain marker that lets a
    // sharer schedule the next autoplay before `room:state` catches up is no
    // longer pending. Leaving it set could later make an unrelated autoplay look
    // like a chain continuation.
    if (
      args.runtimeState.pendingAutoShareTargetUrl !== null &&
      (normalizedSharedUrl === args.runtimeState.pendingAutoShareTargetUrl ||
        (sharedByMemberId ?? null) !== args.runtimeState.localMemberId)
    ) {
      args.runtimeState.pendingAutoShareTargetUrl = null;
    }
    if (args.runtimeState.activeSharedUrl === normalizedSharedUrl) {
      return;
    }
    args.runtimeState.activeSharedUrl = normalizedSharedUrl ?? null;
    // The room moved to a different shared video, so any resolved identity tracked
    // for a previous bare-route festival share no longer applies.
    args.runtimeState.resolvedSharedVideoUrl = null;
    args.resetPlaybackSyncState(
      `shared url changed to ${sharedVideoUrl ?? "none"}`,
    );
    args.runtimeState.intendedPlayState = "paused";
    args.runtimeState.intendedPlaybackRate = 1;
    args.debugLog(
      `Reset local sync state for shared url ${sharedVideoUrl ?? "none"}`,
    );
  };
  const activateInitialPauseProtection = (input: {
    playback: PlaybackState;
    normalizedSharedUrl: string;
    sharedVideoUrl: string | null | undefined;
    sharedByMemberId: string | null | undefined;
    roomCode: string;
    logReason: string;
  }): void => {
    switchActiveSharedUrlWithReset(
      input.normalizedSharedUrl,
      input.sharedVideoUrl,
      input.sharedByMemberId,
    );
    args.runtimeState.intendedPlayState = input.playback.playState;
    args.runtimeState.intendedPlaybackRate = input.playback.playbackRate;
    args.activatePauseHold(args.initialRoomStatePauseHoldMs);
    const video = args.getVideoElement();
    if (video && !video.paused) {
      args.debugLog(`${input.logReason} for ${input.roomCode}`);
      forcePauseVideo({
        runtimeState: args.runtimeState,
        video,
        getMonotonicNow: monotonicNow,
      });
    }
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
      monotonicNow() - args.runtimeState.lastUserGestureAt >=
        args.userGestureGraceMs
    ) {
      args.debugLog(`Suppressed autoplay for empty room ${roomCode}`);
      forcePauseVideo({
        runtimeState: args.runtimeState,
        video,
        getMonotonicNow: monotonicNow,
      });
    }
  }

  /**
   * Back off consecutive hydration retries instead of re-arming the caller's
   * fixed delay forever. Every wait this retry serves — the page bridge, the
   * `<video>` element, the room state itself — is unbounded: none of them is
   * guaranteed to arrive, and a tab whose player never produces a `<video>`
   * used to re-hydrate every 350ms for the lifetime of the tab (#229).
   *
   * The delay the caller passes is the *first* interval; each consecutive retry
   * doubles it up to {@link HYDRATION_RETRY_MAX_DELAY_MS}. The counter resets
   * as soon as one hydration cycle finishes without arming another retry
   * (see {@link hydrateRoomState}), so an isolated retry always starts fast.
   */
  function clearHydrationRetryTimer(): void {
    if (hydrateRetryTimer !== null) {
      window.clearTimeout(hydrateRetryTimer);
      hydrateRetryTimer = null;
    }
    hydrateRetryDeadline = null;
  }

  /**
   * Arm the single hydration retry timer at `baseDelayMs` backed off by
   * `attempt` doublings. Returns whether it armed, so the caller only advances
   * its own streak when it actually consumed one.
   */
  function armHydrationRetry(baseDelayMs: number, attempt: number): boolean {
    if (destroyed || hydrateRetryTimer !== null) {
      return false;
    }
    const backedOffDelayMs = Math.min(
      baseDelayMs * 2 ** attempt,
      HYDRATION_RETRY_MAX_DELAY_MS,
    );
    hydrateRetryDeadline = monotonicNow() + backedOffDelayMs;
    hydrateRetryTimer = window.setTimeout(() => {
      hydrateRetryTimer = null;
      hydrateRetryDeadline = null;
      // Not `hydrateRoomState`: this is a consecutive retry, so it must keep
      // the streaks that make it back off.
      void runHydration();
    }, backedOffDelayMs);
    return true;
  }

  /**
   * Replace the pending retry only when the replacement fires *sooner*.
   *
   * The armed deadline must never move later, or a repeating event starves the
   * timer: a player rebuilding its `<video>` reports a bind every ~250ms, and
   * once the bind backoff passes that interval each bind cancelled the pending
   * timer and armed a longer one, so the callback never ran at all and the
   * pending room state was held forever. Refusing to postpone makes the
   * deadline monotonically non-increasing until it fires, which bounds the wait
   * by whatever armed it first no matter how often the event repeats.
   *
   * Both readings come from a monotonic clock, never the wall clock. The
   * deadline is a `monotonicNow()`-style reading captured when the timer was armed, so
   * a *backward* wall-clock step would shrink `now + delay` and make the
   * candidate look earlier than a deadline it is not — the comparison would
   * preempt, cancel a timer that was about to fire, and restart the full delay,
   * up to the 10s ceiling once the bind streak has grown. `setTimeout` itself is
   * immune to clock steps, so the deadline that is compared against it must be
   * too.
   */
  function preemptHydrationRetry(
    baseDelayMs: number,
    attempt: number,
  ): boolean {
    if (destroyed || hydrateRetryTimer === null) {
      return false;
    }
    const backedOffDelayMs = Math.min(
      baseDelayMs * 2 ** attempt,
      HYDRATION_RETRY_MAX_DELAY_MS,
    );
    if (
      hydrateRetryDeadline !== null &&
      monotonicNow() + backedOffDelayMs >= hydrateRetryDeadline
    ) {
      return false;
    }
    clearHydrationRetryTimer();
    return armHydrationRetry(baseDelayMs, attempt);
  }

  function scheduleHydrationRetry(delayMs = 350): void {
    if (armHydrationRetry(delayMs, hydrateRetryAttempt)) {
      hydrateRetryAttempt += 1;
    }
  }

  async function applyRoomState(
    state: RoomState,
    shareToast: SharedVideoToastPayload | null = null,
    fromDebounce = false,
  ): Promise<void> {
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
      now: monotonicNow(),
      lastLocalIntentAt: args.runtimeState.lastLocalIntentAt,
      lastLocalIntentPlayState: args.runtimeState.lastLocalIntentPlayState,
      localIntentGuardMs: args.localIntentGuardMs,
      lastAppliedVersion: state.playback
        ? (args.lastAppliedVersionByActor.get(state.playback.actorId) ?? null)
        : null,
      lastLocalPlaybackVersion: args.runtimeState.lastLocalPlaybackVersion,
      localMemberId: args.runtimeState.localMemberId,
    });

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

    // A peer-marked user-initiated pause bypasses the flicker debounce: by
    // convention the sender only sets the flag for explicit gestures (never
    // for buffer-induced pauses or remote-state echoes), so we can apply
    // immediately and avoid the visible 250ms lag that the debounce otherwise
    // adds to legitimate user pauses.
    //
    // The short-circuit is gated on the deferred slot already being clear —
    // the upstream version-comparison block above clears it when the incoming
    // state genuinely supersedes the deferred snapshot. If a deferred is
    // still present here, the incoming state did NOT supersede it (older
    // serverTime/seq, not a matching flicker), so taking the short-circuit
    // would invert the version ordering. Yield to the normal path instead.
    const userInitiatedRemotePause =
      !fromDebounce &&
      state.playback &&
      state.playback.playState === "paused" &&
      state.playback.userInitiated === true &&
      args.runtimeState.localMemberId !== null &&
      state.playback.actorId !== args.runtimeState.localMemberId &&
      args.runtimeState.deferredRemotePausedState === null;

    if (
      !fromDebounce &&
      !userInitiatedRemotePause &&
      remotePauseDebounceMs > 0 &&
      state.playback &&
      state.playback.playState === "paused" &&
      decision.kind === "apply" &&
      args.runtimeState.localMemberId !== null &&
      state.playback.actorId !== args.runtimeState.localMemberId
    ) {
      // Mirror the upstream version-comparison block: if a deferred snapshot
      // is still present after that block ran, the incoming state was deemed
      // older (or otherwise non-superseding). Overwriting the deferred slot
      // here would invert the version ordering — the older state would fire
      // 250ms later and clobber the newer one. Drop the incoming instead.
      // This is especially important now that incoming paused can carry
      // userInitiated:true: a delayed hydrate response landing after a newer
      // realtime push must not get a "skip the debounce" express ticket via
      // an overwrite-then-fire path.
      const existingDeferred = args.runtimeState.deferredRemotePausedState;
      const existingDeferredPlayback = existingDeferred?.playback;
      if (existingDeferredPlayback) {
        const incomingIsOlder =
          state.playback.serverTime < existingDeferredPlayback.serverTime ||
          (state.playback.serverTime === existingDeferredPlayback.serverTime &&
            state.playback.seq < existingDeferredPlayback.seq);
        if (incomingIsOlder) {
          args.debugLog(
            `Dropped incoming paused seq=${state.playback.seq} (older than deferred seq=${existingDeferredPlayback.seq})`,
          );
          return;
        }
      }
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
      // The room's initial state is now known (we are merely debouncing the
      // paused frame). Mark it received so `handleSyncStatus` stops re-arming a
      // 150ms hydrate retry: otherwise each retry re-enters here and resets this
      // 250ms defer timer (150ms < 250ms), so it never fires, hydration never
      // completes, and the retry loop floods the server with `sync:request`
      // until it rate-limits us. `pendingRoomStateHydration` is deliberately
      // left true — it clears only when the deferred snapshot fires and applies.
      args.markInitialRoomStateReceived();
      return;
    }

    args.notifyRoomStateToasts(state);
    args.maybeShowSharedVideoToast(shareToast, state);

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

    if (decision.kind === "empty-room") {
      args.cancelActiveSoftApply(args.getVideoElement(), "room-empty");
      args.runtimeState.activeSharedUrl = null;
      args.runtimeState.activeSharedByMemberId = null;
      args.runtimeState.pendingAutoShareTargetUrl = null;
      args.runtimeState.resolvedSharedVideoUrl = null;
      args.runtimeState.suppressedLocalEndPauseUrl = null;
      args.runtimeState.suppressedLocalEndPauseUntil = 0;
      args.runtimeState.nonSharerAutoplayHoldUrl = null;
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
      // Keep the cached shared-video identity (URL *and* sharer) in sync with the
      // room even when the page bridge briefly returns no current video (this
      // branch otherwise returns without touching it). If the room switches from
      // A to B during this window, a stale `activeSharedUrl` (still A) would make
      // the navigation controller miss a later B→C autoplay
      // (`previousNormalizedPageUrl !== activeSharedUrl`): the sharer would not
      // auto-share C and a non-sharer would not hold, so local playback runs
      // ahead of the room. Mirror the normal apply path's reset so both the URL
      // and the sharer id follow the room.
      switchActiveSharedUrlWithReset(
        normalizedSharedUrl,
        state.sharedVideo?.url,
        state.sharedVideo?.sharedByMemberId,
      );
      if (
        args.runtimeState.pendingRoomStateHydration &&
        state.playback &&
        normalizedSharedUrl &&
        shouldPreserveInitialPauseProtection({
          currentVideo,
          playback: state.playback,
          normalizedSharedUrl,
          normalizedCurrentUrl,
          normalizedPlaybackUrl,
        })
      ) {
        activateInitialPauseProtection({
          playback: state.playback,
          normalizedSharedUrl,
          sharedVideoUrl: state.sharedVideo?.url,
          sharedByMemberId: state.sharedVideo?.sharedByMemberId,
          roomCode: state.roomCode,
          logReason:
            "Suppressed autoplay while waiting for page bridge during hydrate",
        });
        scheduleHydrationRetry();
      }
      return;
    }

    switchActiveSharedUrlWithReset(
      normalizedSharedUrl,
      state.sharedVideo?.url,
      state.sharedVideo?.sharedByMemberId,
    );

    if (decision.kind === "ignore-non-shared") {
      args.cancelActiveSoftApply(args.getVideoElement(), "non-shared-page");
      if (decision.shouldPauseNonSharedVideo && state.playback) {
        const video = args.getVideoElement();
        args.runtimeState.intendedPlayState = state.playback.playState;
        args.activatePauseHold(args.initialRoomStatePauseHoldMs);
        if (video && !video.paused) {
          args.debugLog(
            `Suppressed autoplay during unstable shared url hydration for ${state.roomCode}`,
          );
          forcePauseVideo({
            runtimeState: args.runtimeState,
            video,
            getMonotonicNow: monotonicNow,
          });
        }
      }
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

  /**
   * Hydration driven from outside this controller — a first load, or an SPA
   * navigation within the same room.
   *
   * Such a call is a fresh start, so it drops the retry state first. Both
   * streaks describe how long the *previous* page's wait had been failing, and
   * that page is gone: inheriting them would make the new page's very first
   * retry wait at the ceiling. Nothing wakes it early either — Bilibili reuses
   * the same `<video>` element across an SPA navigation, so no bind is reported
   * — leaving the new page behind the hydration gate with broadcasts suppressed
   * and a pause held (#229).
   *
   * The streak is meant to grow only across *consecutive timer-driven* retries,
   * which is why the timer callback goes to {@link runHydration} instead.
   */
  async function hydrateRoomState(): Promise<void> {
    if (destroyed) {
      return;
    }
    resetHydrationRetry();
    await runHydration();
  }

  /** One hydration attempt, preserving the retry streaks. */
  async function runHydration(): Promise<void> {
    if (destroyed) {
      return;
    }
    clearHydrationRetryTimer();
    try {
      await runHydrationCycle();
    } finally {
      // A cycle that ends without arming another retry is not part of a retry
      // loop, so the next isolated retry starts from its caller's delay again.
      // Checked here rather than at the cycle's several exits because the retry
      // can be armed from deep inside `applyRoomState`. Clears both streaks:
      // reaching here means the hydration made progress, which is exactly what
      // ends a rebind storm too.
      if (!destroyed && hydrateRetryTimer === null) {
        hydrateRetryAttempt = 0;
        boundVideoAttempt = 0;
      }
    }
  }

  async function runHydrationCycle(): Promise<void> {
    const response = await args.requestRoomStateHydration();
    if (destroyed || response === null) {
      if (!destroyed) args.runtimeState.hydrationReady = true;
      return;
    }
    setRoomMembership(
      args.runtimeState,
      response?.roomCode ?? args.runtimeState.activeRoomCode,
      response?.memberId ?? null,
    );

    if (response?.ok && response.roomState) {
      args.debugLog(
        `Hydrate room state success for ${response.roomState.roomCode}`,
      );
      const video = args.getVideoElement();
      const currentVideo = args.getSharedVideo();
      const playback = response.roomState.playback ?? null;
      const normalizedSharedUrl = args.normalizeUrl(
        response.roomState.sharedVideo?.url,
      );
      const normalizedCurrentUrl = args.normalizeUrl(currentVideo?.url);
      const normalizedPlaybackUrl = args.normalizeUrl(playback?.url);
      const shouldPreserveInitialPause = shouldPreserveInitialPauseProtection({
        currentVideo,
        playback,
        normalizedSharedUrl,
        normalizedCurrentUrl,
        normalizedPlaybackUrl,
      });
      if (playback && normalizedSharedUrl && shouldPreserveInitialPause) {
        switchActiveSharedUrlWithReset(
          normalizedSharedUrl,
          response.roomState.sharedVideo?.url,
          response.roomState.sharedVideo?.sharedByMemberId,
        );
        args.runtimeState.intendedPlayState = playback.playState;
        args.runtimeState.intendedPlaybackRate = playback.playbackRate;
        args.activatePauseHold(args.initialRoomStatePauseHoldMs);
      }
      if (
        video &&
        !video.paused &&
        playback &&
        shouldPreserveInitialPause &&
        monotonicNow() - args.runtimeState.lastUserGestureAt >=
          args.userGestureGraceMs
      ) {
        args.runtimeState.intendedPlayState = playback.playState;
        args.debugLog(
          `Suppressed autoplay during hydrate for ${response.roomState.roomCode}`,
        );
        forcePauseVideo({
          runtimeState: args.runtimeState,
          video,
          getMonotonicNow: monotonicNow,
        });
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

  /**
   * The `<video>` element a deferred hydration was waiting for now exists.
   *
   * A no-op unless a retry is actually pending: a player rebuild during
   * ordinary playback also rebinds, and hydrating on every rebind would put the
   * `sync:request` back on a timer — the opposite of the point.
   *
   * A binding and a fruitless wait are two different sequences, so they get two
   * streaks. The wait streak is *spent* here: the element it was waiting for
   * exists, so the pending room state must apply promptly no matter how long
   * the wait ran. Sharing one counter meant a two-minute wait had grown it to
   * ~10, and the nominal 50ms below became `50 * 2**10`, capped at the 30s
   * ceiling — half a minute of suppressed broadcasts and a held pause *after*
   * the video was usable.
   *
   * Repeated bindings that still fail to apply are the second sequence, and are
   * unbounded in their own right: a player rebuilding its element reports a
   * bind every time, and hydrating inline on each one would run up to four a
   * second at the 250ms bind interval. So they back off on `boundVideoAttempt`,
   * which — like the wait streak — clears once a cycle ends without re-arming.
   *
   * Goes through {@link preemptHydrationRetry} rather than cancel-and-re-arm,
   * so a bind can only ever pull the hydration *earlier*. Cancelling
   * unconditionally starved it outright: once the bind backoff passed the
   * ~250ms bind interval, every bind cancelled the pending timer and armed a
   * longer one, so the callback never ran and the pending state was held for
   * as long as the player kept rebuilding.
   */
  function notifyVideoElementBound(): void {
    if (destroyed || hydrateRetryTimer === null) {
      return;
    }
    // Counted on every notification, not only on the ones that win: the streak
    // measures how often this element has been rebinding, and a rebuild loop
    // reports just as many binds whether or not each one manages to preempt.
    // Advancing it only on wins let a storm hold the delay near the base value
    // and kept hydration running ~1.6x/s — bounded, but still above the
    // limiter's budget.
    const attempt = boundVideoAttempt;
    boundVideoAttempt += 1;
    if (!preemptHydrationRetry(BOUND_VIDEO_HYDRATION_DELAY_MS, attempt)) {
      // Declined because this bind would fire no sooner than what is already
      // armed — the signature of a rebind storm rather than of the element
      // finally arriving. Nothing is reset, so the wait streak goes on growing,
      // which is what makes the storm decay.
      return;
    }
    // The preemption won, so this bind really did carry news. The wait streak
    // it accumulated is spent: a wait that follows must start over rather than
    // resume at the ceiling.
    hydrateRetryAttempt = 0;
  }

  /**
   * Drop everything the hydration retry accumulated for the previous room.
   *
   * Both streaks measure "how long has *this* wait been failing", so they are
   * meaningless across a room switch — and actively harmful: a tab that
   * saturated them on the old room would either have the new room's 150ms
   * bootstrap retry stretched to the ceiling, or have it refused outright by
   * the single-timer guard because the old room's timer is still armed. The new
   * room would then sit behind the hydration gate, suppressing broadcasts and
   * holding a pause, if its bootstrap push happened to be lost.
   */
  function resetHydrationRetry(): void {
    clearHydrationRetryTimer();
    hydrateRetryAttempt = 0;
    boundVideoAttempt = 0;
  }

  function destroy(): void {
    destroyed = true;
    hydrateRetryAttempt = 0;
    boundVideoAttempt = 0;
    clearHydrationRetryTimer();
    clearDeferredRemotePaused();
  }

  return {
    applyRoomState,
    hydrateRoomState,
    scheduleHydrationRetry,
    notifyVideoElementBound,
    resetHydrationRetry,
    destroy,
  };
}
