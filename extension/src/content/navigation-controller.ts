import {
  resetUserGestureState,
  type ContentRuntimeState,
} from "./runtime-state";
import {
  isAddressBarOpaqueVideoUrl,
  isUnstableSharedVideoUrl,
} from "./video-identity";

export interface NavigationController {
  start(): void;
  destroy(): void;
}

export function createNavigationController(args: {
  runtimeState: ContentRuntimeState;
  intervalMs: number;
  userGestureGraceMs: number;
  initialRoomStatePauseHoldMs: number;
  getCurrentPageUrl: () => string;
  normalizeVideoPageUrl: (url: string) => string | null;
  /**
   * Resolves the in-player video URL for pages whose address bar does not reflect
   * the currently playing video. Festival pages keep a fixed `/festival/<id>`
   * route in the address bar while the player swaps videos, so `getCurrentPageUrl`
   * never changes across an autoplay-next and the navigation watcher would never
   * observe it. This returns the page-bridge snapshot's resolved share URL (with
   * `bvid`/`cid`) when available, or `null` to fall back to
   * {@link getCurrentPageUrl} (e.g. before the snapshot resolves, or on pages
   * whose address bar already reflects the video such as `/video/` and bangumi
   * episode pages).
   */
  getResolvedVideoUrl?: () => string | null;
  isSupportedVideoPage: (url: string) => boolean;
  clearFestivalSnapshot: () => void;
  attachPlaybackListeners: () => void;
  getVideoElement: () => HTMLVideoElement | null;
  pauseVideo: (video: HTMLVideoElement) => void;
  hydrateRoomState: () => Promise<void>;
  activatePauseHold: (durationMs?: number) => void;
  scheduleAutoShareNextVideo?: (input: {
    previousSharedUrl: string;
    nextNormalizedPageUrl: string;
    /**
     * The sharer's own in-flight auto-share target this navigation advanced FROM
     * (the previous chain step), or `null` when this is not a chained step (it
     * came straight from the room's confirmed shared video). A `null` value marks
     * a fresh chain so the auto-share controller resets its sent-target lineage;
     * a non-null value continues the current chain.
     */
    previousAutoShareTargetUrl: string | null;
  }) => void;
  cancelAutoShareNextVideo?: () => void;
  debugLog: (message: string) => void;
  getNow?: () => number;
}): NavigationController {
  const nowOf = () => args.getNow?.() ?? Date.now();
  // Compares the path portion of two page URLs (ignoring query/hash), used to
  // tell a same-page festival autoplay from a navigation to a different page.
  const samePathname = (a: string, b: string): boolean => {
    try {
      return (
        new URL(a).pathname.replace(/\/+$/, "") ===
        new URL(b).pathname.replace(/\/+$/, "")
      );
    } catch {
      return a === b;
    }
  };
  // The observed page identity: the resolved in-player video URL when available
  // (festival pages), otherwise the address bar. Used to seed the initial
  // baseline so a later resolution is recognised as a change.
  const readObservedPageUrl = (): string =>
    args.getResolvedVideoUrl?.() ?? args.getCurrentPageUrl();
  let navigationWatchTimer: number | null = null;
  let lastObservedPageUrl = readObservedPageUrl();
  let lastObservedNormalizedPageUrl =
    args.normalizeVideoPageUrl(lastObservedPageUrl);

  function handlePotentialNavigation(): void {
    const rawPageUrl = args.getCurrentPageUrl();
    const resolvedVideoUrl = args.getResolvedVideoUrl?.() ?? null;
    // On an address-bar-opaque page (festival) the URL never reflects the
    // in-player video, so the page-bridge snapshot is the only reliable identity.
    // While it has not resolved yet — including the brief window right after a
    // same-page autoplay clears it — defer instead of falling back to the address
    // bar: that URL would masquerade as a navigation away from the resolved video
    // and spuriously cancel the just-scheduled auto-share / pause it. Detect the
    // page by its `/festival/` pathname, NOT by whether the normalized URL is
    // unstable: a festival page opened from a share link keeps a frozen
    // `?bvid=A&cid=...` that normalizes to a *stable* old `/video/...`, which the
    // unstable check would miss. A real navigation to a different path is still
    // handled immediately so autoplay there stays suppressed until room state.
    if (
      resolvedVideoUrl === null &&
      args.getResolvedVideoUrl !== undefined &&
      isAddressBarOpaqueVideoUrl(rawPageUrl) &&
      samePathname(rawPageUrl, lastObservedPageUrl)
    ) {
      return;
    }
    const nextPageUrl = resolvedVideoUrl ?? rawPageUrl;
    if (nextPageUrl === lastObservedPageUrl) {
      return;
    }

    const nextNormalizedPageUrl = args.normalizeVideoPageUrl(nextPageUrl);

    // The room shares THIS page by its bare (unstable) festival route — the page
    // bridge could not resolve a `bvid`/`cid` when it was shared. Resolving it now
    // is discovery of that share's concrete video.
    const sharedUrlForDiscovery = args.runtimeState.activeSharedUrl;
    const sharedIsUnstableSamePageRoute =
      isUnstableSharedVideoUrl(sharedUrlForDiscovery) &&
      samePathname(sharedUrlForDiscovery, nextPageUrl);
    // The first snapshot resolution of a bare-route festival share to its concrete
    // stable `/video/...`. Record it as the stable "from" anchor for the next
    // same-page autoplay (`activeSharedUrl` itself stays the unstable route until
    // the room confirms a concrete video). This must run even when the resolved URL
    // is unchanged from the baseline: a festival page opened from a share link
    // keeps a frozen `?bvid=A&cid=...` whose baseline already normalizes to the
    // same stable `/video/A`, so the resolution hits the "normalized unchanged"
    // short-circuit below before reaching the discovery guard further down —
    // without this it would never anchor and the later A→B autoplay could not be
    // classified as the room share's autoplay.
    const isBareRouteShareResolution =
      resolvedVideoUrl !== null &&
      nextNormalizedPageUrl !== null &&
      !isUnstableSharedVideoUrl(nextNormalizedPageUrl) &&
      sharedIsUnstableSamePageRoute;

    if (
      nextNormalizedPageUrl !== null &&
      nextNormalizedPageUrl === lastObservedNormalizedPageUrl
    ) {
      if (isBareRouteShareResolution) {
        args.runtimeState.resolvedSharedVideoUrl = nextNormalizedPageUrl;
      }
      lastObservedPageUrl = nextPageUrl;
      return;
    }

    // The normalized video page the tab was showing *before* this navigation.
    // Used to confirm an autoplay actually started from the room's shared video
    // rather than from a local detour the user manually navigated to.
    const previousNormalizedPageUrl = lastObservedNormalizedPageUrl;

    // First concrete resolution of an unstable route (festival): the page-bridge
    // snapshot just resolved the in-player video to a stable `/video/...` URL.
    // This is the *discovery* of the already-playing video, not an autoplay
    // navigation, so adopt the resolved identity silently instead of running the
    // suppress/pause/auto-share path below — otherwise the sharer's own
    // just-resolved video would be needlessly paused on load. Genuine festival
    // autoplay-next transitions are stable→stable (a resolved video to another
    // resolved video) and skip this guard, so they still schedule the auto-share.
    // Gated on the identity coming from the snapshot (`resolvedVideoUrl`) so a
    // bangumi season→episode navigation, whose address bar genuinely changes, is
    // never silently swallowed here.
    //
    // Restricted to the discovery of a video we cannot confirm as *different* from
    // the room's share. We can confirm "different" only against a stable, known,
    // different shared url; treat as discovery when:
    //   - we are not in a room (no room state governs playback), or
    //   - the resolved video equals `activeSharedUrl`, or
    //   - `activeSharedUrl` is itself an unstable route on this same page (e.g. a
    //     manual share whose page bridge failed fell back to the bare
    //     `/festival/<id>` url) — the route may well resolve to this very video,
    //     so resolving it is discovery, not a switch.
    // Deliberately NOT a discovery when we are in a room but `activeSharedUrl` is
    // still null (joined but the initial `room:state` has not arrived): fall
    // through to the in-room hydration/pause path so a festival video already
    // playing is suppressed until the room's actual shared video is known. If the
    // first resolution is already a confirmably different video — the shared video
    // ended and the player auto-advanced before the snapshot resolved — likewise
    // fall through so the sharer still schedules the auto-share and a non-sharer
    // is still paused.
    if (
      resolvedVideoUrl !== null &&
      isUnstableSharedVideoUrl(previousNormalizedPageUrl) &&
      nextNormalizedPageUrl !== null &&
      !isUnstableSharedVideoUrl(nextNormalizedPageUrl) &&
      (!args.runtimeState.activeRoomCode ||
        nextNormalizedPageUrl === sharedUrlForDiscovery ||
        sharedIsUnstableSamePageRoute)
    ) {
      // Record the resolved identity of a bare-route festival share so the next
      // same-page autoplay can use it as a stable "from" anchor (`activeSharedUrl`
      // itself stays the unstable route until the room confirms a concrete video).
      if (sharedIsUnstableSamePageRoute) {
        args.runtimeState.resolvedSharedVideoUrl = nextNormalizedPageUrl;
      }
      lastObservedPageUrl = nextPageUrl;
      lastObservedNormalizedPageUrl = nextNormalizedPageUrl;
      args.debugLog(
        `Adopted resolved video identity ${nextNormalizedPageUrl} from ${previousNormalizedPageUrl} without treating snapshot resolution as a navigation`,
      );
      return;
    }
    // The local video the user was explicitly watching before this navigation
    // (if any). Captured before the reset below so an explicit local-playback
    // intent can be transferred across a detour that auto-advances.
    const previousExplicitNonSharedPlaybackUrl =
      args.runtimeState.explicitNonSharedPlaybackUrl;
    // The next video the local sharer auto-shared but the room has not yet
    // confirmed (`activeSharedUrl` still lags it). Captured before the reset so a
    // chained autoplay whose previous page is this in-flight target is still
    // recognised as a sharer autoplay below. Re-armed only when this navigation
    // is itself a sharer autoplay-next.
    const previousPendingAutoShareTargetUrl =
      args.runtimeState.pendingAutoShareTargetUrl;
    // The resolved identity of a bare-route festival share, captured before the
    // reset below clears it. Used as the stable "from" anchor for a same-page
    // autoplay off a share whose `activeSharedUrl` is still the unstable route.
    const previousResolvedSharedVideoUrl =
      args.runtimeState.resolvedSharedVideoUrl;
    lastObservedPageUrl = nextPageUrl;
    lastObservedNormalizedPageUrl = nextNormalizedPageUrl;
    args.clearFestivalSnapshot();
    args.runtimeState.pendingPlaybackApplication = null;
    args.runtimeState.explicitNonSharedPlaybackUrl = null;
    args.runtimeState.pendingAutoShareTargetUrl = null;
    args.runtimeState.resolvedSharedVideoUrl = null;
    // Any genuine navigation invalidates an auto-share scheduled by an earlier
    // autoplay. A manual detour — even one that returns to the same target — must
    // not let a stale settle timer fire and auto-share without the manual
    // confirmation. The local-sharer autoplay branch below re-schedules when this
    // navigation is itself a sharer autoplay-next.
    args.cancelAutoShareNextVideo?.();

    if (
      !args.runtimeState.activeRoomCode ||
      !args.isSupportedVideoPage(nextPageUrl)
    ) {
      // DIAGNOSTIC: this early bail runs *after* cancelAutoShareNextVideo above,
      // so a transient non-video URL (e.g. a mid-SPA redirect during bangumi
      // autoplay) silently cancels a still-pending auto-share without logging.
      // Surface it so we can confirm whether it is what drops the auto-share.
      args.debugLog(
        `Navigation to ${nextPageUrl} bailed early (activeRoom=${Boolean(
          args.runtimeState.activeRoomCode,
        )} supportedVideoPage=${args.isSupportedVideoPage(
          nextPageUrl,
        )}); any pending auto-share was cancelled`,
      );
      return;
    }

    const activeSharedUrl = args.runtimeState.activeSharedUrl;
    // The stable anchor for the room's share. Normally `activeSharedUrl`, but when
    // the room shares an address-bar-opaque *route* (a bare-route festival share),
    // `activeSharedUrl` is unstable; fall back to the resolved identity captured
    // for it so a same-page autoplay off that share can still be classified. The
    // background still receives the bare `activeSharedUrl` as `previousSharedUrl`
    // (it must match the room's stored share), so this only affects classification.
    const effectiveSharedUrl =
      activeSharedUrl !== null && isUnstableSharedVideoUrl(activeSharedUrl)
        ? (previousResolvedSharedVideoUrl ?? activeSharedUrl)
        : activeSharedUrl;
    const now = nowOf();
    // Captured before `resetUserGestureState` below zeroes it, so the
    // natural-end check can tell whether a gesture postdates the natural end.
    const lastUserGestureAt = args.runtimeState.lastUserGestureAt;
    const hadRecentUserGesture =
      lastUserGestureAt > 0 &&
      now - lastUserGestureAt <= args.userGestureGraceMs;
    // We can only positively confirm the navigated page is a *different*
    // (non-shared) video when the room's shared URL and the navigated page URL
    // are both present, stable (not a festival / bangumi-season identity), and
    // different. In every other case the page may still be the shared video:
    //   - page URL equals the shared URL — it is the shared video;
    //   - either URL is still an unstable identity (e.g. a paused shared season
    //     `.../play/ss73077` whose page resolved to `.../play/ep...`, or a
    //     festival route) — we cannot tell whether it is the shared video;
    //   - the shared URL is not yet known (just joined/switched room before the
    //     initial room state arrives) — the page may well be the shared video.
    const canConfirmDifferentVideo =
      effectiveSharedUrl !== null &&
      !isUnstableSharedVideoUrl(effectiveSharedUrl) &&
      nextNormalizedPageUrl !== null &&
      !isUnstableSharedVideoUrl(nextNormalizedPageUrl) &&
      nextNormalizedPageUrl !== effectiveSharedUrl;

    // Anchor the previous shared URL so that broadcasts stay suppressed until
    // the page bridge resolves the new page to a different normalized URL or
    // a fresh shared-video room state arrives. This prevents stale
    // `__INITIAL_STATE__` data captured mid-SPA from being broadcast as
    // updates to the still-shared previous video.
    //
    // Skip the anchor when the user is navigating directly to the shared
    // video URL itself (e.g. coming back to the original episode after a
    // detour) — in that case the page-bridge will correctly resolve to that
    // URL and broadcasts are not at risk of leaking stale data.
    if (activeSharedUrl && nextNormalizedPageUrl !== activeSharedUrl) {
      args.runtimeState.postNavigationAnchorSharedUrl = activeSharedUrl;
      args.runtimeState.postNavigationAnchorSetAt = now;
    } else {
      args.runtimeState.postNavigationAnchorSharedUrl = null;
      args.runtimeState.postNavigationAnchorSetAt = 0;
    }
    resetUserGestureState(args.runtimeState);
    args.attachPlaybackListeners();

    if (canConfirmDifferentVideo) {
      const isLocalSharedSource =
        args.runtimeState.localMemberId !== null &&
        args.runtimeState.activeSharedByMemberId ===
          args.runtimeState.localMemberId;
      // Only treat this as a room-video autoplay when the tab actually
      // autoplayed *from* the shared video. If the page before this navigation
      // was a local detour (e.g. the sharer manually opened video X off the
      // shared A, then X auto-advanced to Y), this is not the room advancing:
      // auto-sharing Y with `previousSharedUrl=A` or pausing a non-sharer's own
      // detour would both be wrong.
      //
      // Also accept the previous page being the sharer's own in-flight auto-share
      // target: during chained autoplay (A→B→C) the player can advance B→C before
      // B's `room:state` returns, so `activeSharedUrl` is still A while the page
      // came from B. Without this the B→C step would look like a local detour and
      // C would never be shared, stranding the room behind the sharer. (The
      // background still defers/skips if the room is not actually behind our
      // share, so a stale target cannot force an out-of-turn share.)
      // A URL-form-independent signal that the shared video just naturally ended
      // on this page, so this navigation is its autoplay-next. It covers two
      // cases the page-URL comparison misses:
      //   - bangumi season pages keep the season URL (`/bangumi/play/ss<id>`) in
      //     the address bar while playing the resolved episode the room shares
      //     (`/bangumi/play/ep<id>`), so the previous page URL never equals
      //     `activeSharedUrl`;
      //   - a seek to the last seconds leaves the gesture window warm at the
      //     autoplay, which would otherwise look like a manual switch.
      // The durable `sharedVideoNaturalEnd*` timestamp is used (not the
      // broadcast-suppression markers) because the gate clears those eagerly —
      // often before this watcher runs — whereas this one survives until the
      // shared URL changes. Bounded by the hold window so a stale end cannot turn
      // a later unrelated navigation into a misclassified autoplay. This is the
      // `navFromShared` half (it recognises a season-page autoplay even when no
      // gesture is involved), so it deliberately does NOT depend on the gesture.
      const navigatedFromSharedVideoEnd =
        activeSharedUrl !== null &&
        args.runtimeState.sharedVideoNaturalEndUrl === activeSharedUrl &&
        now - args.runtimeState.sharedVideoNaturalEndAt <
          args.initialRoomStatePauseHoldMs;
      // Classify as the shared video's autoplay only on *provable* evidence that
      // the advance came from the room's shared video:
      //   - a durable natural-end marker for it (`navigatedFromSharedVideoEnd`), or
      //   - the previous page equals the shared anchor — either `activeSharedUrl`
      //     directly, the resolved identity of a bare-route festival share
      //     (`effectiveSharedUrl`), or our own in-flight chained target.
      // We deliberately do NOT infer it from "the first resolution of this festival
      // page landed on some different video": when the page bridge resolves a
      // manually opened/clicked festival page slowly (past `userGestureGraceMs`, or
      // when the navigation was not gesture-tracked), the previous identity is
      // still the bare route and that heuristic would auto-share a manual detour
      // (and pause non-sharers) without proof it came from the shared video. The
      // cost is that an autoplay-next whose page bridge resolves only after the
      // player already advanced past the shared video — and which left no natural-
      // end marker — is not auto-shared; that ambiguous case is indistinguishable
      // from a manual detour, so we err on the side of not hijacking the room.
      const navigatedFromSharedVideo =
        navigatedFromSharedVideoEnd ||
        (previousNormalizedPageUrl !== null &&
          (previousNormalizedPageUrl === effectiveSharedUrl ||
            previousNormalizedPageUrl === previousPendingAutoShareTargetUrl));
      // The ONLY recent gesture that should not block autoplay classification is
      // a seek-to-end: the sharer dragged to the last seconds and let the video
      // auto-advance. Two conditions together:
      //   - the end itself was recorded as preceded by a seek
      //     (`sharedVideoNaturalEndAfterSeek`), so a manual click that records no
      //     fresh seek — even one the watcher polls just after the old video
      //     fires `ended` — does not qualify; and
      //   - no gesture postdates the natural end (`lastUserGestureAt <=
      //     sharedVideoNaturalEndAt`), so a click on another episode *after* a
      //     genuine seek-to-end (the flag is still set from that earlier end)
      //     stays a manual navigation rather than reusing the stale flag.
      const recentGestureIsSeekToEnd =
        navigatedFromSharedVideoEnd &&
        args.runtimeState.sharedVideoNaturalEndAfterSeek &&
        lastUserGestureAt <= args.runtimeState.sharedVideoNaturalEndAt;
      const shouldTreatAsAutoplay =
        (!hadRecentUserGesture || recentGestureIsSeekToEnd) &&
        navigatedFromSharedVideo &&
        activeSharedUrl !== null &&
        nextNormalizedPageUrl !== null;
      const shouldPauseNonSharerAutoplay =
        shouldTreatAsAutoplay && !isLocalSharedSource;
      // User-driven local browsing that lands on a non-shared video: either the
      // user manually navigated here (recent gesture), or a local detour the
      // user was already explicitly watching auto-advanced to the next video.
      // Mark the target as explicit local playback so the paused-room autoplay
      // guard lets the user watch it — the navigation reset above clears
      // `lastUserGestureAt`, so without this the later `play` event would look
      // like an autoplay and be paused.
      const isUserDrivenLocalNavigation =
        !shouldTreatAsAutoplay &&
        (hadRecentUserGesture ||
          (previousNormalizedPageUrl !== null &&
            previousNormalizedPageUrl ===
              previousExplicitNonSharedPlaybackUrl));

      if (shouldTreatAsAutoplay && isLocalSharedSource) {
        args.runtimeState.explicitNonSharedPlaybackUrl = nextNormalizedPageUrl;
        // Advance FROM the room's confirmed shared video (`activeSharedUrl`), not
        // the page we navigated from. A multi-part / chained autoplay that outruns
        // room confirmation (A→B→C→D before any `room:state` returns) can't replay
        // the intermediate videos — once the tab moves past B/C the background's
        // tab-resolution check rejects them — so the room must jump straight to the
        // latest video the sharer is actually on. The auto-share controller already
        // collapses rapid navigations to the latest target via supersede; pairing
        // that target with the room's confirmed video as `previousSharedUrl` lets
        // the background advance the room directly to it (room A → latest). In the
        // normal single-step case `navigatedFromSharedVideo` guarantees
        // `previousNormalizedPageUrl === activeSharedUrl`, so this is unchanged.
        //
        // `activeSharedUrl` is the anchor as of *now*. If a step our own chain
        // already sent confirms during the settle window, the room moves to it
        // while this anchor goes stale; the auto-share controller re-anchors to the
        // live shared video, but only when it is one of its own sent targets — so
        // an unrelated video the room moved to (e.g. a manual share confirmed in
        // the same window) is never adopted and the stale auto-share is correctly
        // skipped as moved-on. `previousPendingAutoShareTargetUrl` tells the
        // controller whether this is a chained step (continue the lineage) or a
        // fresh start (reset it).
        args.scheduleAutoShareNextVideo?.({
          previousSharedUrl: activeSharedUrl,
          nextNormalizedPageUrl,
          previousAutoShareTargetUrl: previousPendingAutoShareTargetUrl,
        });
        // Remember this target so the next chained autoplay (next → next+1) is
        // recognised as a sharer autoplay even before the room confirms it.
        args.runtimeState.pendingAutoShareTargetUrl = nextNormalizedPageUrl;
        // When the room's share is still a bare festival route (its `room:state`
        // has not yet confirmed a concrete next video), keep the resolved anchor
        // advancing to the latest auto-shared target so a further same-page
        // autoplay (B→C) still resolves a stable `effectiveSharedUrl` and chains.
        if (
          activeSharedUrl !== null &&
          isUnstableSharedVideoUrl(activeSharedUrl)
        ) {
          args.runtimeState.resolvedSharedVideoUrl = nextNormalizedPageUrl;
        }
      } else if (shouldPauseNonSharerAutoplay) {
        args.runtimeState.intendedPlayState = "paused";
        // Mark this as a non-sharer autoplay page so the playback binding will
        // force-pause a delayed `play` here even after the pause hold expires.
        // Only pages reached through this in-SPA autoplay get the marker, so a
        // video the user manually opens via full-page navigation stays playable.
        args.runtimeState.nonSharerAutoplayHoldUrl = nextNormalizedPageUrl;
        args.activatePauseHold(args.initialRoomStatePauseHoldMs);
        const video = args.getVideoElement();
        if (video && !video.paused) {
          args.runtimeState.lastForcedPauseAt = now;
          args.debugLog(`Suppressed non-sharer autoplay to ${nextPageUrl}`);
          args.pauseVideo(video);
        }
      } else if (isUserDrivenLocalNavigation) {
        args.runtimeState.explicitNonSharedPlaybackUrl = nextNormalizedPageUrl;
      }
      // For manual non-shared navigation and local-sharer autoplay, clear any
      // pause hold inherited from the previously shared video. For non-sharer
      // autoplay, keep the freshly armed pause hold so a delayed play event is
      // still stopped.
      if (!shouldPauseNonSharerAutoplay) {
        args.runtimeState.pauseHoldUntil = 0;
      }
      // DIAGNOSTIC: the previous single message could not tell whether the
      // auto-share branch actually ran (it logged "skipping autoplay
      // suppression" for both the scheduled-auto-share case and the
      // user-driven/no-op case). Spell out the decision inputs so a failed
      // auto-continue can be traced to the exact false condition.
      const navOutcome = shouldPauseNonSharerAutoplay
        ? "holding paused state (non-sharer autoplay)"
        : shouldTreatAsAutoplay && isLocalSharedSource
          ? "scheduled auto-share"
          : isUserDrivenLocalNavigation
            ? "user-driven local navigation, no auto-share"
            : "no autoplay branch taken, no auto-share";
      args.debugLog(
        `Nav decision to ${nextPageUrl}: ${navOutcome} ` +
          `[autoplay=${shouldTreatAsAutoplay} localSharer=${isLocalSharedSource} ` +
          `navFromShared=${navigatedFromSharedVideo} navFromSharedEnd=${navigatedFromSharedVideoEnd} seekToEnd=${recentGestureIsSeekToEnd} recentGesture=${hadRecentUserGesture} ` +
          `prevPage=${previousNormalizedPageUrl} activeShared=${activeSharedUrl} ` +
          `prevAutoShareTarget=${previousPendingAutoShareTargetUrl}]`,
      );
      void args.hydrateRoomState();
      return;
    }

    // The navigated page may be the shared video, so suppress autoplay through
    // the navigation/hydration window until room state confirms playback.
    // Pause an already-playing video immediately too: waiting for a later
    // `play` event is not enough because it never fires for a video that is
    // already playing when navigation completes.
    args.runtimeState.hasReceivedInitialRoomState = false;
    args.runtimeState.pendingRoomStateHydration = true;
    args.runtimeState.intendedPlayState = "paused";
    args.activatePauseHold(args.initialRoomStatePauseHoldMs);
    args.debugLog(
      `Detected in-room navigation to ${nextPageUrl}, waiting for room state`,
    );
    const video = args.getVideoElement();
    if (video && !video.paused) {
      args.debugLog(
        `Suppressed autoplay immediately after in-room navigation to ${nextPageUrl}`,
      );
      args.pauseVideo(video);
    }
    void args.hydrateRoomState();
  }

  return {
    start() {
      handlePotentialNavigation();
      if (navigationWatchTimer === null) {
        navigationWatchTimer = window.setInterval(
          handlePotentialNavigation,
          args.intervalMs,
        );
      }
    },
    destroy() {
      if (navigationWatchTimer !== null) {
        window.clearInterval(navigationWatchTimer);
        navigationWatchTimer = null;
      }
    },
  };
}
