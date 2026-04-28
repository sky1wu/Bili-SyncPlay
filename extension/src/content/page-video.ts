import {
  parseBilibiliVideoRef,
  type PlaybackState,
  type SharedVideo,
} from "@bili-syncplay/protocol";

export interface PageVideoSource {
  pageUrl: string;
  pathname: string;
  documentTitle: string;
  headingTitle: string | null;
  currentPartTitle: string | null;
  pageSnapshot?: {
    videoId: string;
    url: string;
    title: string;
  } | null;
  festivalSnapshot: {
    videoId: string;
    url: string;
    title: string;
  } | null;
}

export interface VideoPlaybackSnapshot {
  currentTime: number;
  playbackRate: number;
  playState: PlaybackState["playState"];
}

export function resolvePageSharedVideo(
  source: PageVideoSource,
): SharedVideo | null {
  if (source.pageSnapshot) {
    return {
      videoId: source.pageSnapshot.videoId,
      url: source.pageSnapshot.url,
      title: source.pageSnapshot.title,
    };
  }

  if (source.pathname.startsWith("/festival/") && source.festivalSnapshot) {
    return {
      videoId: source.festivalSnapshot.videoId,
      url: source.festivalSnapshot.url,
      title: source.festivalSnapshot.title,
    };
  }

  const fallbackVideoRef = parseBilibiliVideoRef(source.pageUrl);
  if (!fallbackVideoRef) {
    return null;
  }

  return {
    videoId: fallbackVideoRef.videoId,
    url: fallbackVideoRef.normalizedUrl,
    title: resolveSharedVideoTitle(source),
  };
}

export function resolveSharedVideoTitle(
  source: Pick<
    PageVideoSource,
    "documentTitle" | "headingTitle" | "currentPartTitle"
  >,
): string {
  return (
    source.currentPartTitle ||
    source.headingTitle ||
    source.documentTitle.split("_")[0]?.trim() ||
    source.documentTitle.trim()
  );
}

export function createSharePayload(args: {
  sharedVideo: SharedVideo;
  playback: VideoPlaybackSnapshot | null;
  actorId: string;
  seq: number;
  now: number;
}): { video: SharedVideo; playback: PlaybackState | null } {
  if (!args.playback) {
    return {
      video: args.sharedVideo,
      playback: null,
    };
  }

  return {
    video: args.sharedVideo,
    playback: {
      url: args.sharedVideo.url,
      currentTime: args.playback.currentTime,
      playState: args.playback.playState,
      playbackRate: args.playback.playbackRate,
      updatedAt: args.now,
      serverTime: 0,
      actorId: args.actorId,
      seq: args.seq,
    },
  };
}

export function buildFestivalShareUrl(
  pageUrl: string,
  bvid: string,
  cid: string,
): string {
  const parsed = new URL(pageUrl);
  parsed.searchParams.set("bvid", bvid);
  parsed.searchParams.set("cid", cid);
  parsed.hash = "";
  return parsed.toString();
}

export function buildBvidCidShareUrl(bvid: string, cid: string): string {
  return `https://www.bilibili.com/video/${bvid}?cid=${cid}`;
}

export function buildBangumiEpisodeShareUrl(epId: string): string {
  const normalizedEpId = epId.startsWith("ep") ? epId : `ep${epId}`;
  return `https://www.bilibili.com/bangumi/play/${normalizedEpId}`;
}
