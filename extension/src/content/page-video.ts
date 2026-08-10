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
  /**
   * Titles PROVEN to name the video this page has already left — on
   * `/bangumi/play/epNNN`, the previous episode's (#274).
   *
   * Refuting only the source that carried the proof is not enough: the title
   * sources below are all page globals lagging the same SPA episode switch, so
   * the resolver would step from the highlighted list item onto an `h1` holding
   * the identical string and rebuild the record the refutation existed to
   * prevent — the new episode's `videoId` wearing the old episode's name. A
   * refuted title is refuted wherever it turns up.
   */
  refutedTitles?: readonly string[];
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
    // When every title on the page is refuted, the identity itself is the only
    // truthful label left. Blank would be worse than plain: `ep396139` says
    // nothing false, whereas the previous episode's name does.
    title: resolveSharedVideoTitle(source) || fallbackVideoRef.videoId,
  };
}

export function resolveSharedVideoTitle(
  source: Pick<
    PageVideoSource,
    "documentTitle" | "headingTitle" | "currentPartTitle" | "refutedTitles"
  >,
): string {
  const refutedKeys = new Set(
    (source.refutedTitles ?? []).map(titleRecordKey).filter(Boolean),
  );
  // `<episode>_番剧_bilibili` and the `<episode>` cut out of it are one record,
  // not two candidates. Listing them separately lets a refuted title back in
  // wearing its site suffix — the same stale name, still false (#274).
  const documentTitle =
    source.documentTitle.split("_")[0]?.trim() || source.documentTitle.trim();
  for (const candidate of [
    source.currentPartTitle,
    source.headingTitle,
    documentTitle,
  ]) {
    const title = candidate?.trim();
    if (title && !refutedKeys.has(titleRecordKey(title))) {
      return title;
    }
  }
  return "";
}

/**
 * Reduces a title to the form the resolver compares on. Both sides must go
 * through it: the resolver cuts `document.title` at its first `_` to shed the
 * site suffix, and that cut is applied to a title whose own text may contain one
 * — so a refuted `OVA_1` has to refute the `OVA` derived from
 * `OVA_1_番剧_bilibili` too. Comparing a derived candidate against raw refuted
 * strings lets the derivation launder the stale name past the refutation (#274).
 *
 * That the cut also truncates a genuine `OVA_1` down to `OVA` is older than this
 * function and applies to the current episode's title just the same; it is a
 * display-quality question, not an episode-identity one.
 */
function titleRecordKey(title: string): string {
  return title.split("_")[0]?.trim() || title.trim();
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
