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
  /**
   * Whether the address bar has been PROVEN stale as an identity for this page,
   * so the `parseBilibiliVideoRef(pageUrl)` fallback below must not be used.
   *
   * A festival page keeps whatever `?bvid=` it was opened with while the player
   * runs through the whole playlist, so once a snapshot has resolved even once
   * we know the address bar names some earlier video — very likely not the one
   * playing. The fallback then does not degrade gracefully: it answers with a
   * confident, *wrong* `/video/<frozen bvid>` identity, which reads as "some
   * other, non-shared video" and gets the page force-paused (and remote room
   * states discarded as "not this page"). Answering `null` — "not known yet" —
   * routes those callers to their unresolved-identity paths, which is what the
   * situation actually is.
   *
   * Left false until a snapshot has resolved: a festival page opened from a
   * share link carries `?bvid=A&cid=...` for the video it is about to play, and
   * until the bridge resolves that is the only identity available.
   */
  addressBarIdentityRefuted?: boolean;
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

  if (source.addressBarIdentityRefuted) {
    return null;
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

/**
 * `updatedAt` goes on the wire as the protocol's "sender timestamp (ms)", so it
 * is a WALL-CLOCK reading — unlike every elapsed-duration reading in the content
 * script. See {@link createPlaybackBroadcastPayload} for the full reasoning.
 */
export function createSharePayload(args: {
  sharedVideo: SharedVideo;
  playback: VideoPlaybackSnapshot | null;
  actorId: string;
  seq: number;
  updatedAt: number;
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
      updatedAt: args.updatedAt,
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
