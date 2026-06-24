import type { SharedVideo } from "@bili-syncplay/protocol";

export function hasStableSharedVideoIdentity(
  video: SharedVideo | null,
): boolean {
  if (!video) {
    return false;
  }

  return !(
    video.videoId.startsWith("/festival/") || /^ss\d+$/i.test(video.videoId)
  );
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
