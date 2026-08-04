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
