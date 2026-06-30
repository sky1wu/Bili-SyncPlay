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
  /**
   * Injects the page-world bridge script if it is not already present. Festival
   * snapshot reads inject it lazily, but the bridge also installs the SPA
   * navigation hooks (`history.pushState`/`replaceState`/`popstate`), which must
   * be armed on every page — including plain `/video/` pages that never read a
   * festival snapshot — so the content script learns about a navigation the
   * instant it happens rather than at the next poll tick.
   */
  ensureBridgeInjected: () => void;
  getSnapshot: () => FestivalSnapshot | null;
  /**
   * Resolves the in-player video URL for an address-bar-opaque festival page from
   * the cached snapshot. Festival pages keep a fixed `/festival/<id>` route while
   * the player swaps videos, so this is the only reliable way for the navigation
   * watcher and auto-share self-check to observe the current video. Returns the
   * snapshot's resolved share URL (with `bvid`/`cid`) when the cached snapshot
   * belongs to `pathname`, otherwise `null` (non-festival page, or no/stale
   * matching snapshot — callers fall back to the address bar).
   *
   * When `maxAgeMs` is provided, a snapshot older than it is treated as stale and
   * `null` is returned: a cached video the user may already have left must not be
   * reported as the *trustworthy current* video (it would let the auto-share
   * self-check confirm a now-wrong target). Omit `maxAgeMs` to accept any cached
   * snapshot regardless of age.
   */
  resolveVideoUrlForPage: (
    pathname: string,
    maxAgeMs?: number,
  ) => string | null;
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
    festivalBridgeReady = true;
    // The bridge may already be in the DOM from an earlier eager injection (the
    // navigation hooks are armed at content init). Re-injecting would evaluate a
    // second copy of the script; the page-world hook install is itself guarded,
    // but skip the redundant work here too.
    if (
      document.querySelector('script[data-bili-syncplay-bridge="true"]') !==
      null
    ) {
      return;
    }
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.async = false;
    script.dataset.biliSyncplayBridge = "true";
    (document.head || document.documentElement).appendChild(script);
  }

  return {
    clearSnapshot: () => {
      festivalSnapshot = null;
    },
    ensureBridgeInjected: () => {
      ensureFestivalBridge();
    },
    getSnapshot: () => festivalSnapshot,
    resolveVideoUrlForPage: (
      pathname: string,
      maxAgeMs?: number,
    ): string | null => {
      if (!pathname.startsWith("/festival/")) {
        return null;
      }
      if (
        !festivalSnapshot?.pathname?.startsWith("/festival/") ||
        normalizeCachedPagePathname(festivalSnapshot.pathname) !==
          normalizeCachedPagePathname(pathname)
      ) {
        return null;
      }
      // A snapshot older than the freshness bound may no longer reflect the page
      // (the user could have moved to another video within the same festival route
      // without the snapshot being refreshed). Don't report it as the current
      // video, so the auto-share self-check cannot confirm a stale target.
      if (
        maxAgeMs !== undefined &&
        Date.now() - festivalSnapshot.updatedAt >= maxAgeMs
      ) {
        return null;
      }
      return festivalSnapshot.url;
    },
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
        // Mirror the fast-path freshness gate above: when a fresh read fails, only
        // fall back to the cached snapshot while it is still within `maxAgeMs`.
        // Without the TTL bound a read failure could resurrect an arbitrarily stale
        // snapshot for the authoritative auto-share target validation, sharing a
        // video the user has already left.
        return !isBangumiPage &&
          festivalSnapshot &&
          canUseCachedFestivalSnapshot(pathname) &&
          Date.now() - festivalSnapshot.updatedAt < maxAgeMs
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
