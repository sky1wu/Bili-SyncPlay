import type { SharedVideo } from "@bili-syncplay/protocol";
import {
  buildBangumiEpisodeShareUrl,
  buildBvidCidShareUrl,
  buildFestivalShareUrl,
} from "./page-video";

export interface FestivalSnapshot {
  videoId: string;
  url: string;
  title: string;
  updatedAt: number;
  epId?: string;
  cid?: string;
  pathname?: string;
  pageUrl?: string;
}

interface PageVideoSnapshot extends SharedVideo {
  epId?: string;
  cid?: string;
}

export interface FestivalBridgeController {
  clearSnapshot: () => void;
  getSnapshot: () => FestivalSnapshot | null;
  refreshSnapshot: (args: {
    pathname: string;
    pageUrl: string;
    maxAgeMs: number;
  }) => Promise<SharedVideo | null>;
}

export function createFestivalBridgeController(): FestivalBridgeController {
  let festivalBridgeReady = false;
  let festivalSnapshot: FestivalSnapshot | null = null;

  async function readFestivalSnapshotFromPageContext(
    pathname: string,
    pageUrl: string,
  ): Promise<PageVideoSnapshot | null> {
    ensureFestivalBridge();
    const requestId = `bili-syncplay-festival-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return await new Promise<PageVideoSnapshot | null>((resolve) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        resolve(null);
      }, 800);

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        window.removeEventListener("message", onSnapshot as EventListener);
      };

      const onSnapshot = (event: Event) => {
        const messageEvent = event as MessageEvent<{
          type?: string;
          requestId?: string;
          detail?: {
            epId?: string | number;
            bvid?: string;
            cid?: string | number;
            title?: string;
          };
        }>;
        if (messageEvent.source !== window) {
          return;
        }
        if (
          messageEvent.data?.type !== "bili-syncplay:festival-video" ||
          messageEvent.data.requestId !== requestId
        ) {
          return;
        }
        const detail = messageEvent.data.detail;
        cleanup();

        if (!detail?.title) {
          resolve(null);
          return;
        }

        if (pathname.startsWith("/bangumi/play/") && detail.epId) {
          const epId = String(detail.epId);
          const normalizedEpId = epId.startsWith("ep") ? epId : `ep${epId}`;
          resolve({
            videoId: normalizedEpId,
            url: buildBangumiEpisodeShareUrl(epId),
            title: detail.title.trim(),
            epId: normalizedEpId,
            cid: detail.cid === undefined ? undefined : String(detail.cid),
          });
          return;
        }

        if (!detail.bvid || detail.cid === undefined) {
          resolve(null);
          return;
        }

        resolve({
          videoId: `${detail.bvid}:${detail.cid}`,
          url: pathname.startsWith("/festival/")
            ? buildFestivalShareUrl(pageUrl, detail.bvid, String(detail.cid))
            : buildBvidCidShareUrl(detail.bvid, String(detail.cid)),
          title: detail.title.trim(),
          cid: String(detail.cid),
        });
      };

      window.addEventListener("message", onSnapshot as EventListener);
      window.postMessage(
        { type: "bili-syncplay:get-festival-video", requestId },
        "*",
      );
    });
  }

  function normalizeCachedPagePathname(pathname: string): string {
    return pathname.replace(/\/+$/, "");
  }

  function canUseCachedFestivalSnapshot(pathname: string): boolean {
    return (
      pathname.startsWith("/festival/") &&
      festivalSnapshot?.pathname?.startsWith("/festival/") === true &&
      normalizeCachedPagePathname(festivalSnapshot.pathname) ===
        normalizeCachedPagePathname(pathname)
    );
  }

  function ensureFestivalBridge(): void {
    if (festivalBridgeReady) {
      return;
    }

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.async = false;
    script.dataset.biliSyncplayBridge = "true";
    (document.head || document.documentElement).appendChild(script);
    festivalBridgeReady = true;
  }

  return {
    clearSnapshot: () => {
      festivalSnapshot = null;
    },
    getSnapshot: () => festivalSnapshot,
    refreshSnapshot: async ({ pathname, pageUrl, maxAgeMs }) => {
      const isBangumiPage = pathname.startsWith("/bangumi/play/");
      if (!pathname.startsWith("/festival/") && !isBangumiPage) {
        festivalSnapshot = null;
        return null;
      }

      if (
        !isBangumiPage &&
        festivalSnapshot &&
        canUseCachedFestivalSnapshot(pathname) &&
        Date.now() - festivalSnapshot.updatedAt < maxAgeMs
      ) {
        return {
          videoId: festivalSnapshot.videoId,
          url: festivalSnapshot.url,
          title: festivalSnapshot.title,
        };
      }

      const nextSnapshot = await readFestivalSnapshotFromPageContext(
        pathname,
        pageUrl,
      );
      if (!nextSnapshot) {
        return !isBangumiPage &&
          festivalSnapshot &&
          canUseCachedFestivalSnapshot(pathname)
          ? {
              videoId: festivalSnapshot.videoId,
              url: festivalSnapshot.url,
              title: festivalSnapshot.title,
            }
          : null;
      }

      festivalSnapshot = {
        ...nextSnapshot,
        updatedAt: Date.now(),
        pathname,
        pageUrl,
      };
      return nextSnapshot;
    },
  };
}
