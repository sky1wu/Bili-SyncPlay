import type { PlaybackState, SharedVideo } from "@bili-syncplay/protocol";
import { getReportedPlayState, getVideoElement } from "./player-binding";
import {
  createSharePayload as createPageSharePayload,
  resolvePageSharedVideo,
} from "./page-video";
import type { ContentRuntimeState } from "./runtime-state";
import {
  isAddressBarOpaqueVideoUrl,
  normalizePageVisitUrl,
} from "./video-identity";

export interface ShareController {
  getSharedVideo(): SharedVideo | null;
  /** Records a real page visit so address-bar identity evidence cannot leak across it. */
  observePageVisit(pageUrl: string): void;
  getCurrentPlaybackVideo(): Promise<SharedVideo | null>;
  getCurrentSharePayload(): {
    video: SharedVideo;
    playback: PlaybackState | null;
  } | null;
  resolveCurrentSharePayload(): Promise<{
    video: SharedVideo;
    playback: PlaybackState | null;
  } | null>;
  refreshFestivalSnapshot(maxAgeMs?: number): Promise<SharedVideo | null>;
}

interface CachedPageSnapshot extends SharedVideo {
  updatedAt: number;
  epId?: string;
  cid?: string;
  pathname?: string;
  pageUrl?: string;
}

interface CurrentPartIdentity {
  title: string | null;
  epId: string | null;
  cid: string | null;
}

export function shouldIncludePlaybackInSharePayload(args: {
  activeRoomCode: string | null;
  activeSharedUrl: string | null;
  nextSharedUrl: string;
}): boolean {
  void args;
  return true;
}

export function createShareController(args: {
  runtimeState: ContentRuntimeState;
  festivalSnapshotTtlMs: number;
  nextSeq: () => number;
  getFestivalSnapshot: () => CachedPageSnapshot | null;
  refreshFestivalBridge: (input: {
    pathname: string;
    pageUrl: string;
    maxAgeMs: number;
  }) => Promise<SharedVideo | null>;
  /**
   * The room's base playback rate while a rate catch-up is running for this url,
   * or `null` when none is. A share payload must report it for the same reason a
   * `playback:update` must: during a catch-up `video.playbackRate` is a temporary
   * offset this client added to close its own drift, and the server persists
   * whatever a `video:share` carries — so re-sharing mid-catch-up would write the
   * temporary rate straight into room state (#238).
   */
  getActiveCorrectionBaseRate: (
    url: string | undefined | null,
  ) => number | null;
  /** See {@link getReportedPlayState}; the share snapshot reports through it. */
  bufferPauseUpgradeMs: number;
  /** Monotonic clock, matching every other window measured in this codebase. */
  getMonotonicNow: () => number;
  debugLog: (message: string) => void;
}): ShareController {
  function canUsePageSnapshot(pathname: string): boolean {
    return (
      pathname.startsWith("/festival/") || pathname.startsWith("/bangumi/play/")
    );
  }

  function canUseCachedPageSnapshot(pathname: string): boolean {
    return pathname.startsWith("/festival/");
  }

  function normalizeCachedPagePathname(pathname: string): string {
    return pathname.replace(/\/+$/, "");
  }

  function hasMatchingCachedPagePathname(argsForMatch: {
    pathname: string;
    snapshot: CachedPageSnapshot;
  }): boolean {
    return (
      argsForMatch.snapshot.pathname !== undefined &&
      normalizeCachedPagePathname(argsForMatch.snapshot.pathname) ===
        normalizeCachedPagePathname(argsForMatch.pathname)
    );
  }

  function canUseMatchingCachedPageSnapshot(argsForMatch: {
    pathname: string;
    pageUrl: string;
    snapshot: CachedPageSnapshot | null;
    currentPart: CurrentPartIdentity;
  }): boolean {
    if (!argsForMatch.snapshot) {
      return false;
    }
    if (canUseCachedPageSnapshot(argsForMatch.pathname)) {
      return (
        argsForMatch.snapshot.pathname?.startsWith("/festival/") === true &&
        hasMatchingCachedPagePathname(argsForMatch) &&
        argsForMatch.snapshot.pageUrl !== undefined &&
        normalizePageVisitUrl(argsForMatch.snapshot.pageUrl) ===
          normalizePageVisitUrl(argsForMatch.pageUrl)
      );
    }
    const snapshotEpId =
      argsForMatch.snapshot.epId ??
      (argsForMatch.snapshot.videoId.startsWith("ep")
        ? argsForMatch.snapshot.videoId
        : null);
    const snapshotCid =
      argsForMatch.snapshot.cid ??
      (argsForMatch.snapshot.videoId.includes(":")
        ? (argsForMatch.snapshot.videoId.split(":").at(-1) ?? null)
        : null);
    const titleMatches =
      argsForMatch.currentPart.title !== null &&
      argsForMatch.snapshot.title.trim() === argsForMatch.currentPart.title;
    return (
      argsForMatch.pathname.startsWith("/bangumi/play/") &&
      hasMatchingCachedPagePathname(argsForMatch) &&
      ((snapshotEpId !== null &&
        snapshotEpId === argsForMatch.currentPart.epId) ||
        (snapshotCid !== null &&
          snapshotCid === argsForMatch.currentPart.cid) ||
        titleMatches)
    );
  }

  function getCurrentPartIdentity(): CurrentPartIdentity {
    const active = document.querySelector<HTMLElement>(
      [
        "li.bpx-state-multi-active-item",
        ".video-section-list li.on",
        ".video-section-list li.active",
        "li[data-cid].bpx-state-active",
        "[data-cid].bpx-state-active",
        "[data-cid].bpx-state-multi-active-item",
        "[data-cid].active",
        "[data-cid].selected",
        "[data-ep-id].active",
        "[data-episode-id].active",
        "[data-episodeid].active",
        "[data-epid].active",
      ].join(", "),
    );
    const rawEpId =
      active?.getAttribute("data-ep-id") ??
      active?.getAttribute("data-episode-id") ??
      active?.getAttribute("data-episodeid") ??
      active?.getAttribute("data-epid") ??
      null;
    const title = active?.textContent?.trim() || null;
    return {
      title,
      epId: rawEpId
        ? rawEpId.startsWith("ep")
          ? rawEpId
          : `ep${rawEpId}`
        : null,
      cid: active?.getAttribute("data-cid") ?? null,
    };
  }

  function createSharePayload(sharedVideo: SharedVideo): {
    video: SharedVideo;
    playback: PlaybackState | null;
  } {
    const video = getVideoElement();
    return createPageSharePayload({
      sharedVideo,
      playback: video
        ? {
            currentTime: video.currentTime,
            playbackRate:
              args.getActiveCorrectionBaseRate(sharedVideo.url) ??
              video.playbackRate,
            // Same classification the broadcast funnel uses. A share snapshot
            // is a full play state on the wire, so it must be able to say
            // `paused` for a video that is paused — reporting `buffering` there
            // tells receivers "we are trying to play", and they neither pause
            // for it nor let their pause hold act on it (#258).
            playState: getReportedPlayState({
              video,
              pauseClassifiedAsBuffer:
                args.runtimeState.pauseClassifiedAsBuffer,
              pauseStartedAt: args.runtimeState.pauseStartedAt,
              now: args.getMonotonicNow(),
              bufferPauseUpgradeMs: args.bufferPauseUpgradeMs,
            }),
          }
        : null,
      actorId: args.runtimeState.localMemberId ?? "local",
      seq: args.nextSeq(),
      // Wall clock on purpose: this one goes on the wire. Everything the content
      // script measures a duration with reads the monotonic clock instead.
      updatedAt: Date.now(),
    });
  }

  /**
   * The address-bar-opaque page visit whose in-player identity a snapshot has
   * already resolved at least once. From that point on the address bar's frozen
   * `?bvid=` is known to be stale — see
   * {@link PageVideoSource.addressBarIdentityRefuted}.
   *
   * This is keyed by the full page URL, not only its pathname: after leaving a
   * festival and opening the same route from another share link, the new
   * `?bvid=&cid=` is the only correct identity until its first snapshot resolves.
   * Observing any different page also clears the old visit, which covers leaving
   * and returning through the same link.
   */
  let snapshotResolvedPageUrl: string | null = null;

  function observePageVisit(pageUrl: string): void {
    const pageVisitUrl = normalizePageVisitUrl(pageUrl);
    if (
      snapshotResolvedPageUrl !== null &&
      snapshotResolvedPageUrl !== pageVisitUrl
    ) {
      snapshotResolvedPageUrl = null;
    }
  }

  function rememberSnapshotResolved(pageUrl: string): void {
    observePageVisit(pageUrl);
    if (isAddressBarOpaqueVideoUrl(pageUrl)) {
      snapshotResolvedPageUrl = normalizePageVisitUrl(pageUrl);
    }
  }

  function hasRefutedAddressBarIdentity(pageUrl: string): boolean {
    observePageVisit(pageUrl);
    return (
      isAddressBarOpaqueVideoUrl(pageUrl) &&
      snapshotResolvedPageUrl === normalizePageVisitUrl(pageUrl)
    );
  }

  function getSharedVideo(): SharedVideo | null {
    const festivalSnapshot = args.getFestivalSnapshot();
    const pathname = window.location.pathname;
    const pageUrl = window.location.href.split("#")[0];
    const currentPart = getCurrentPartIdentity();
    const matchingFestivalSnapshot =
      festivalSnapshot &&
      canUseMatchingCachedPageSnapshot({
        pathname,
        pageUrl,
        snapshot: festivalSnapshot,
        currentPart,
      })
        ? {
            videoId: festivalSnapshot.videoId,
            url: festivalSnapshot.url,
            title: festivalSnapshot.title,
          }
        : null;
    if (matchingFestivalSnapshot) {
      rememberSnapshotResolved(pageUrl);
    }
    return resolvePageSharedVideo({
      pageUrl,
      pathname,
      documentTitle: document.title,
      headingTitle: document.querySelector("h1")?.textContent?.trim() ?? null,
      currentPartTitle: currentPart.title,
      pageSnapshot: matchingFestivalSnapshot,
      festivalSnapshot: matchingFestivalSnapshot,
      addressBarIdentityRefuted: hasRefutedAddressBarIdentity(pageUrl),
    });
  }

  async function refreshFestivalSnapshot(
    maxAgeMs = args.festivalSnapshotTtlMs,
  ): Promise<SharedVideo | null> {
    const pathname = window.location.pathname;
    const pageUrl = window.location.href.split("#")[0];
    observePageVisit(pageUrl);
    const nextSnapshot = await args.refreshFestivalBridge({
      pathname,
      pageUrl,
      maxAgeMs,
    });
    const currentPageUrl = window.location.href.split("#")[0];
    if (
      normalizePageVisitUrl(currentPageUrl) !== normalizePageVisitUrl(pageUrl)
    ) {
      observePageVisit(currentPageUrl);
      args.debugLog(
        `Discarded page video snapshot for stale visit ${pageUrl}; current page is ${currentPageUrl}`,
      );
      return null;
    }
    if (!nextSnapshot) {
      return null;
    }
    // Recorded here as well as in `getSharedVideo`: a refresh is the
    // authoritative resolution, and it can happen while no caller is reading the
    // cached snapshot — the address bar is stale from this moment on either way.
    rememberSnapshotResolved(pageUrl);
    args.debugLog(
      `Page video snapshot detected id=${nextSnapshot.videoId} title=${nextSnapshot.title} url=${nextSnapshot.url}`,
    );
    return nextSnapshot;
  }

  async function getCurrentPlaybackVideo(): Promise<SharedVideo | null> {
    if (canUsePageSnapshot(window.location.pathname)) {
      const refreshed = await refreshFestivalSnapshot(0);
      if (refreshed) {
        return refreshed;
      }
    }

    return getSharedVideo();
  }

  function getCurrentSharePayload(): {
    video: SharedVideo;
    playback: PlaybackState | null;
  } | null {
    const currentVideo = getSharedVideo();
    if (currentVideo && window.location.pathname.startsWith("/festival/")) {
      args.debugLog(
        `Festival video detected id=${currentVideo.videoId} title=${currentVideo.title} url=${currentVideo.url}`,
      );
    }
    return currentVideo ? createSharePayload(currentVideo) : null;
  }

  async function resolveCurrentSharePayload(): Promise<{
    video: SharedVideo;
    playback: PlaybackState | null;
  } | null> {
    if (canUsePageSnapshot(window.location.pathname)) {
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const refreshed = await refreshFestivalSnapshot(
          window.location.pathname.startsWith("/bangumi/play/") || attempt === 1
            ? 0
            : args.festivalSnapshotTtlMs,
        );
        if (refreshed) {
          args.debugLog(
            `Page video payload stabilized after retry ${attempt}: ${refreshed.videoId}`,
          );
          return createSharePayload(refreshed);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }

      args.debugLog("Page video payload fell back to URL-based detection");
    }

    return getCurrentSharePayload();
  }

  return {
    getSharedVideo,
    observePageVisit,
    getCurrentPlaybackVideo,
    getCurrentSharePayload,
    resolveCurrentSharePayload,
    refreshFestivalSnapshot,
  };
}
