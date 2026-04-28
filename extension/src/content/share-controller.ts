import type { PlaybackState, SharedVideo } from "@bili-syncplay/protocol";
import { getPlayState, getVideoElement } from "./player-binding";
import {
  createSharePayload as createPageSharePayload,
  resolvePageSharedVideo,
} from "./page-video";
import type { ContentRuntimeState } from "./runtime-state";

export interface ShareController {
  getSharedVideo(): SharedVideo | null;
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
    snapshot: CachedPageSnapshot | null;
    currentPart: CurrentPartIdentity;
  }): boolean {
    if (!argsForMatch.snapshot) {
      return false;
    }
    if (canUseCachedPageSnapshot(argsForMatch.pathname)) {
      return (
        argsForMatch.snapshot.pathname?.startsWith("/festival/") === true &&
        hasMatchingCachedPagePathname(argsForMatch)
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
        "[data-epid].active",
      ].join(", "),
    );
    const rawEpId =
      active?.getAttribute("data-ep-id") ??
      active?.getAttribute("data-episode-id") ??
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
            playbackRate: video.playbackRate,
            playState: getPlayState(video, args.runtimeState.intendedPlayState),
          }
        : null,
      actorId: args.runtimeState.localMemberId ?? "local",
      seq: args.nextSeq(),
      now: Date.now(),
    });
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
        snapshot: festivalSnapshot,
        currentPart,
      })
        ? {
            videoId: festivalSnapshot.videoId,
            url: festivalSnapshot.url,
            title: festivalSnapshot.title,
          }
        : null;
    return resolvePageSharedVideo({
      pageUrl,
      pathname,
      documentTitle: document.title,
      headingTitle: document.querySelector("h1")?.textContent?.trim() ?? null,
      currentPartTitle: currentPart.title,
      pageSnapshot: matchingFestivalSnapshot,
      festivalSnapshot: matchingFestivalSnapshot,
    });
  }

  async function refreshFestivalSnapshot(
    maxAgeMs = args.festivalSnapshotTtlMs,
  ): Promise<SharedVideo | null> {
    const nextSnapshot = await args.refreshFestivalBridge({
      pathname: window.location.pathname,
      pageUrl: window.location.href.split("#")[0],
      maxAgeMs,
    });
    if (!nextSnapshot) {
      return null;
    }
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
    getCurrentPlaybackVideo,
    getCurrentSharePayload,
    resolveCurrentSharePayload,
    refreshFestivalSnapshot,
  };
}
