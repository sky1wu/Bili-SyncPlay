export interface BilibiliVideoRef {
  videoId: string;
  normalizedUrl: string;
}

const SUPPORTED_BILIBILI_HOSTS = new Set(["www.bilibili.com"]);

function isSupportedBilibiliHost(hostname: string): boolean {
  return SUPPORTED_BILIBILI_HOSTS.has(hostname);
}

function parseSupportedBilibiliPath(pathname: string): { kind: "video" | "bangumi" | "festival" | "watchlater"; id: string } | null {
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

  if (normalizedPath === "/list/watchlater" || normalizedPath === "/medialist/play/watchlater") {
    return { kind: "watchlater", id: normalizedPath };
  }

  return null;
}

export function parseBilibiliVideoRef(url: string | undefined | null): BilibiliVideoRef | null {
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
    if ((supportedPath.kind === "festival" || supportedPath.kind === "watchlater") && bvid) {
      const cid = parsed.searchParams.get("cid");
      const p = parsed.searchParams.get("p");
      return {
        videoId: cid ? `${bvid}:${cid}` : p ? `${bvid}:p${p}` : bvid,
        normalizedUrl: cid
          ? `https://www.bilibili.com/video/${bvid}?cid=${cid}`
          : p
            ? `https://www.bilibili.com/video/${bvid}?p=${p}`
            : `https://www.bilibili.com/video/${bvid}`
      };
    }

    if (supportedPath.kind === "watchlater") {
      return null;
    }

    const p = parsed.searchParams.get("p");
    return {
      videoId: p ? `${supportedPath.id}:p${p}` : supportedPath.id,
      normalizedUrl: p ? `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}?p=${p}` : `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`
    };
  } catch {
    return null;
  }
}

export function normalizeBilibiliUrl(url: string | undefined | null): string | null {
  return parseBilibiliVideoRef(url)?.normalizedUrl ?? null;
}
