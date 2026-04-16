export interface BilibiliVideoRef {
  videoId: string;
  normalizedUrl: string;
}

const SUPPORTED_BILIBILI_HOSTS = new Set(["www.bilibili.com"]);

function isSupportedBilibiliHost(hostname: string): boolean {
  return SUPPORTED_BILIBILI_HOSTS.has(hostname);
}

function parseSupportedBilibiliPath(pathname: string): {
  kind: "video" | "bangumi" | "festival" | "watchlater";
  id: string;
} | null {
  const normalizedPath = pathname.replace(/\/+$/, "");
  const videoMatch = normalizedPath.match(/^\/video\/([^/?]+)$/);
  if (videoMatch) {
    return { kind: "video", id: videoMatch[1] };
  }

  const bangumiMatch = normalizedPath.match(/^\/bangumi\/play\/([^/?]+)$/);
  if (bangumiMatch) {
    return { kind: "bangumi", id: bangumiMatch[1] };
  }

  if (/^\/festival\/[^/?]+$/.test(normalizedPath)) {
    return { kind: "festival", id: normalizedPath };
  }

  if (
    normalizedPath === "/list/watchlater" ||
    normalizedPath === "/medialist/play/watchlater"
  ) {
    return { kind: "watchlater", id: normalizedPath };
  }

  return null;
}

export function parseBilibiliVideoRef(
  url: string | undefined | null,
): BilibiliVideoRef | null {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (!isSupportedBilibiliHost(parsed.hostname)) {
      return null;
    }

    const supportedPath = parseSupportedBilibiliPath(parsed.pathname);
    if (!supportedPath) {
      return null;
    }

    const bvid = parsed.searchParams.get("bvid");
    if (
      (supportedPath.kind === "festival" ||
        supportedPath.kind === "watchlater") &&
      bvid
    ) {
      const cid = parsed.searchParams.get("cid");
      const p = parsed.searchParams.get("p");
      return {
        videoId: cid ? `${bvid}:${cid}` : p ? `${bvid}:p${p}` : bvid,
        normalizedUrl: cid
          ? `https://www.bilibili.com/video/${bvid}?cid=${cid}`
          : p
            ? `https://www.bilibili.com/video/${bvid}?p=${p}`
            : `https://www.bilibili.com/video/${bvid}`,
      };
    }

    if (supportedPath.kind === "watchlater") {
      return null;
    }

    const p = parsed.searchParams.get("p");
    const cid =
      supportedPath.kind === "video" ? parsed.searchParams.get("cid") : null;
    const basePath = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
    const videoId = cid
      ? `${supportedPath.id}:${cid}`
      : p
        ? `${supportedPath.id}:p${p}`
        : supportedPath.id;
    const normalizedUrl = cid
      ? `${basePath}?cid=${cid}`
      : p
        ? `${basePath}?p=${p}`
        : basePath;
    return { videoId, normalizedUrl };
  } catch (err) {
    if (
      !(err instanceof TypeError) &&
      (typeof process === "undefined" || process.env.NODE_ENV !== "production")
    ) {
      console.debug(
        "[bili-syncplay] parseBilibiliVideoRef: unexpected error parsing URL",
        url,
        err,
      );
    }
    return null;
  }
}

export function normalizeBilibiliUrl(
  url: string | undefined | null,
): string | null {
  return parseBilibiliVideoRef(url)?.normalizedUrl ?? null;
}
