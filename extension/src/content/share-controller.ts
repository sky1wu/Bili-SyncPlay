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
  getFestivalSnapshot: () => {
    videoId: string;
    url: string;
    title: string;
    updatedAt: number;
  } | null;
  refreshFestivalBridge: (input: {
    pathname: string;
    pageUrl: string;
    maxAgeMs: number;
  }) => Promise<SharedVideo | null>;
  debugLog: (message: string) => void;
}): ShareController {
  function getCurrentPartTitle(): string | null {
    return (
      document
        .querySelector("li.bpx-state-multi-active-item")
        ?.textContent?.trim() ||
      document
        .querySelector(
          ".video-section-list li.on, .video-section-list li.active, [data-cid].bpx-state-multi-active-item",
        )
        ?.textContent?.trim() ||
      null
    );
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
    return resolvePageSharedVideo({
      pageUrl: window.location.href.split("#")[0],
      pathname: window.location.pathname,
      documentTitle: document.title,
      headingTitle: document.querySelector("h1")?.textContent?.trim() ?? null,
      currentPartTitle: getCurrentPartTitle(),
      festivalSnapshot: festivalSnapshot
        ? {
            videoId: festivalSnapshot.videoId,
            url: festivalSnapshot.url,
            title: festivalSnapshot.title,
          }
        : null,
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
      `Festival video detected id=${nextSnapshot.videoId} title=${nextSnapshot.title} url=${nextSnapshot.url}`,
    );
    return nextSnapshot;
  }

  async function getCurrentPlaybackVideo(): Promise<SharedVideo | null> {
    if (window.location.pathname.startsWith("/festival/")) {
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
    if (window.location.pathname.startsWith("/festival/")) {
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const refreshed = await refreshFestivalSnapshot(
          attempt === 1 ? 0 : args.festivalSnapshotTtlMs,
        );
        if (refreshed) {
          args.debugLog(
            `Festival payload stabilized after retry ${attempt}: ${refreshed.videoId}`,
          );
          return createSharePayload(refreshed);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }

      args.debugLog("Festival payload fell back to URL-based detection");
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
