import type { SharedVideo } from "@bili-syncplay/protocol";

export function hasStableSharedVideoIdentity(
  video: SharedVideo | null,
): boolean {
  if (!video) {
    return false;
  }

  return !(
    video.videoId.startsWith("/festival/") ||
    /^ss\d+(?::p[1-9]\d*)?$/i.test(video.videoId)
  );
}

/**
 * Pages whose address bar never reflects the in-player video. Festival pages keep
 * a fixed `/festival/<id>` route while the player swaps videos; any `bvid`/`cid`
 * query carried in from a share link stays frozen at the entry video, so the
 * normalized URL can look stable yet point at the wrong (old) video. The
 * in-player video is only knowable via the page-bridge snapshot. Detect these by
 * pathname rather than by whether the normalized URL is unstable.
 */
export function isAddressBarOpaqueVideoUrl(url: string | null): boolean {
  if (!url) {
    return false;
  }
  try {
    return new URL(url).pathname.startsWith("/festival/");
  } catch {
    return false;
  }
}

const BANGUMI_EPISODE_PATHNAME = /^\/bangumi\/play\/(ep\d+)$/i;

/**
 * The episode a `/bangumi/play/epNNN` address bar names, or `null` on every
 * other page.
 *
 * This is the exact opposite polarity of {@link isAddressBarOpaqueVideoUrl}: on
 * an `epNNN` route the address bar *is* the authoritative identity of the video
 * in the player, because reaching another episode changes it (via `pushState`
 * for an in-page switch). `/festival/<id>` and `/bangumi/play/ssNNN` name no
 * episode at all, so they answer `null` and nothing about them is refuted here.
 */
export function readAddressBarEpisodeId(pathname: string): string | null {
  const match = BANGUMI_EPISODE_PATHNAME.exec(pathname.replace(/\/+$/, ""));
  return match ? match[1].toLowerCase() : null;
}

/**
 * Whether an in-page identity has NOT been confirmed to be the episode the
 * address bar names — the gate for using it as this page's video.
 *
 * Every source of in-player identity — the episode list's highlighted item,
 * `__INITIAL_STATE__`, `__playinfo__` — is a page global, and an SPA episode
 * switch updates the address bar before it updates those (#274). On an `epNNN`
 * route the burden of proof therefore runs against the page: an identity that
 * cannot be confirmed to name this episode is "not resolved yet", and that
 * includes one naming no episode at all. The page bridge answers `bvid:cid` for
 * a bangumi page whose globals expose no `epId`, and in the switch window those
 * are the *previous* episode's `bvid`/`cid` — indistinguishable from the current
 * one's by inspection, which is the whole reason this cannot be a two-sided
 * comparison.
 *
 * Rejecting an unconfirmed identity costs nothing here: the address bar names
 * the episode completely, so the fallback is already the right answer. Routes
 * that name no episode — `/festival/`, `/bangumi/play/ssNNN` — have nothing to
 * confirm against and are never gated.
 */
export function lacksAddressBarEpisodeConfirmation(args: {
  pathname: string;
  episodeId: string | null | undefined;
}): boolean {
  const addressBarEpisodeId = readAddressBarEpisodeId(args.pathname);
  if (addressBarEpisodeId === null) {
    return false;
  }
  return args.episodeId?.toLowerCase() !== addressBarEpisodeId;
}

/**
 * Whether an in-page identity is PROVEN to be a different episode than the one
 * the address bar names — strictly stronger than
 * {@link lacksAddressBarEpisodeConfirmation}, and used where the answer must be
 * proof rather than mere doubt.
 *
 * The asymmetry between the two is deliberate. For identity, an unconfirmed
 * snapshot is free to reject because the address bar already answers completely.
 * For a *label* — the highlighted item's title — the address bar answers
 * nothing, so dropping one on suspicion trades a possibly-correct title for a
 * possibly-worse one. Doubt is enough to refuse a video; only proof is enough to
 * discard a record.
 *
 * Both sides must be known: an unknown `episodeId` proves nothing, and neither
 * does a page whose address bar names no episode.
 */
export function contradictsAddressBarEpisode(args: {
  pathname: string;
  episodeId: string | null | undefined;
}): boolean {
  if (!args.episodeId) {
    return false;
  }
  return lacksAddressBarEpisodeConfirmation(args);
}

/**
 * Stable key for one address-bar page visit. Hash changes and trailing-slash
 * variants do not create a new visit; a different query does. That distinction
 * matters on festival pages: in-player autoplay never changes location.href,
 * while opening another share link on the same pathname supplies a new bvid/cid
 * that is authoritative until the bridge resolves its first snapshot.
 */
export function normalizePageVisitUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if (parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return url.split("#")[0]?.replace(/\/+$/, "") ?? url;
  }
}

export function isUnstableSharedVideoUrl(url: string | null): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return (
      parsed.pathname.startsWith("/festival/") ||
      /^\/bangumi\/play\/ss\d+$/i.test(parsed.pathname.replace(/\/+$/, ""))
    );
  } catch {
    return false;
  }
}

export function isConfirmedDifferentSharedVideo(args: {
  currentVideo: SharedVideo | null;
  sharedVideo: SharedVideo | null;
  normalizedCurrentUrl: string | null;
  normalizedSharedUrl: string | null;
}): boolean {
  if (!args.currentVideo || !args.sharedVideo) {
    return false;
  }

  if (args.currentVideo.videoId === args.sharedVideo.videoId) {
    return false;
  }

  if (
    !hasStableSharedVideoIdentity(args.currentVideo) ||
    !hasStableSharedVideoIdentity(args.sharedVideo) ||
    !args.normalizedCurrentUrl ||
    !args.normalizedSharedUrl
  ) {
    return false;
  }

  return args.normalizedCurrentUrl !== args.normalizedSharedUrl;
}
