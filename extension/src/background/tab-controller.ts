import {
  decideSharedPlaybackTab,
  rememberSharedSource,
} from "./tab-coordinator";
import type { RoomSessionState, ShareState } from "./runtime-state";

export interface TabController {
  rememberSharedSourceTab(tabId: number | undefined, url: string): void;
  isActiveSharedTab(tabId: number | undefined, url: string): boolean;
  isRememberedSharedSourceTab(tabId: number | undefined): boolean;
  reclaimSharedSourceTabIfUnclaimed(tabId: number | undefined): boolean;
  ensureSharedVideoOpen(): Promise<void>;
  openSharedVideoFromPopup(): Promise<void>;
}

export function createTabController(args: {
  roomSessionState: RoomSessionState;
  shareState: ShareState;
  log: (
    scope: "background" | "popup" | "content" | "server",
    message: string,
  ) => void;
  normalizeUrl: (url: string | undefined | null) => string | null;
  bilibiliVideoUrlPatterns: string[];
}): TabController {
  function rememberSharedSourceTab(
    tabId: number | undefined,
    url: string,
  ): void {
    const next = rememberSharedSource({
      currentSharedTabId: args.shareState.sharedTabId,
      tabId,
      url,
    });
    args.shareState.sharedTabId = next.sharedTabId;
    args.shareState.lastOpenedSharedUrl = next.lastOpenedSharedUrl;
    args.log(
      "background",
      `Shared source tab=${tabId ?? "unknown"} url=${url}`,
    );
  }

  function isActiveSharedTab(tabId: number | undefined, url: string): boolean {
    const decision = decideSharedPlaybackTab({
      tabId,
      sharedTabId: args.shareState.sharedTabId,
      normalizedRoomUrl: args.normalizeUrl(
        args.roomSessionState.roomState?.sharedVideo?.url,
      ),
      normalizedPayloadUrl: args.normalizeUrl(url),
    });
    args.shareState.sharedTabId = decision.nextSharedTabId;

    if (decision.reason === "accepted-first") {
      args.log("background", `Accepted first shared playback tab=${tabId}`);
    } else if (decision.reason === "room-mismatch") {
      args.log(
        "background",
        `Ignored playback from shared tab ${tabId} because url no longer matches room`,
      );
    } else if (
      decision.reason === "ignored-non-shared" &&
      decision.nextSharedTabId !== null
    ) {
      args.log("background", `Ignored playback from non-shared tab ${tabId}`);
    }

    return decision.accepted;
  }

  function isRememberedSharedSourceTab(tabId: number | undefined): boolean {
    return tabId !== undefined && args.shareState.sharedTabId === tabId;
  }

  /**
   * Re-claim the shared source tab when the binding is currently unset (e.g. an
   * MV3 service worker restart dropped the in-memory `sharedTabId` while room
   * state was restored). Only claims an unbound slot — if `sharedTabId` already
   * points at a different tab this is a no-op so a non-source tab cannot hijack
   * the binding. Callers must first confirm the sender is the room's sharer and
   * the room is still on the scheduled video.
   */
  function reclaimSharedSourceTabIfUnclaimed(
    tabId: number | undefined,
  ): boolean {
    if (tabId === undefined || args.shareState.sharedTabId !== null) {
      return false;
    }
    args.shareState.sharedTabId = tabId;
    args.log(
      "background",
      `Re-claimed shared source tab=${tabId} after a lost binding`,
    );
    return true;
  }

  async function ensureSharedVideoOpen(): Promise<void> {
    const targetUrl = args.roomSessionState.roomState?.sharedVideo?.url;
    if (!targetUrl) {
      return;
    }

    if (
      args.shareState.lastOpenedSharedUrl === targetUrl ||
      args.shareState.openingSharedUrl === targetUrl
    ) {
      return;
    }
    args.shareState.openingSharedUrl = targetUrl;

    try {
      if (args.shareState.sharedTabId !== null) {
        try {
          const existingTab = await chrome.tabs.get(
            args.shareState.sharedTabId,
          );
          if (
            args.normalizeUrl(existingTab.url) === args.normalizeUrl(targetUrl)
          ) {
            args.shareState.lastOpenedSharedUrl = targetUrl;
            return;
          }
          await chrome.tabs.update(args.shareState.sharedTabId, {
            url: targetUrl,
            active: true,
          });
          args.shareState.lastOpenedSharedUrl = targetUrl;
          args.log(
            "background",
            `Reusing tab ${args.shareState.sharedTabId} for shared video`,
          );
          return;
        } catch {
          args.shareState.sharedTabId = null;
        }
      }

      const existingTabs = await chrome.tabs.query({
        url: args.bilibiliVideoUrlPatterns,
      });
      const matched = existingTabs.find(
        (tab) => args.normalizeUrl(tab.url) === args.normalizeUrl(targetUrl),
      );
      if (matched?.id !== undefined) {
        args.shareState.sharedTabId = matched.id;
        await chrome.tabs.update(matched.id, { active: true });
        args.shareState.lastOpenedSharedUrl = targetUrl;
        args.log("background", `Activated existing shared tab ${matched.id}`);
        return;
      }

      const created = await chrome.tabs.create({
        url: targetUrl,
        active: true,
      });
      args.shareState.sharedTabId = created.id ?? null;
      args.shareState.lastOpenedSharedUrl = targetUrl;
      args.log(
        "background",
        `Opened shared video in new tab ${args.shareState.sharedTabId ?? "unknown"}`,
      );
    } finally {
      if (args.shareState.openingSharedUrl === targetUrl) {
        args.shareState.openingSharedUrl = null;
      }
    }
  }

  async function openSharedVideoFromPopup(): Promise<void> {
    const targetUrl = args.roomSessionState.roomState?.sharedVideo?.url;
    if (!targetUrl) {
      return;
    }

    const existingTabs = await chrome.tabs.query({
      url: args.bilibiliVideoUrlPatterns,
    });
    const matched = existingTabs.find(
      (tab) => args.normalizeUrl(tab.url) === args.normalizeUrl(targetUrl),
    );
    if (matched?.id !== undefined) {
      args.shareState.sharedTabId = matched.id;
      args.shareState.lastOpenedSharedUrl = targetUrl;
      await chrome.tabs.update(matched.id, { active: true });
      args.log("background", `Popup activated shared tab ${matched.id}`);
      return;
    }

    const created = await chrome.tabs.create({ url: targetUrl, active: true });
    args.shareState.sharedTabId = created.id ?? null;
    args.shareState.lastOpenedSharedUrl = targetUrl;
    args.log(
      "background",
      `Popup opened shared video in new tab ${args.shareState.sharedTabId ?? "unknown"}`,
    );
  }

  return {
    rememberSharedSourceTab,
    isActiveSharedTab,
    isRememberedSharedSourceTab,
    reclaimSharedSourceTabIfUnclaimed,
    ensureSharedVideoOpen,
    openSharedVideoFromPopup,
  };
}
