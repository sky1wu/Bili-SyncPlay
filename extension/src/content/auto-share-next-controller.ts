import type {
  ContentToBackgroundMessage,
  ShareCurrentVideoResponse,
} from "../shared/messages";

export interface AutoShareNextController {
  scheduleForNavigation(args: {
    previousSharedUrl: string;
    nextNormalizedPageUrl: string;
  }): void;
  destroy(): void;
}

export function createAutoShareNextController(args: {
  settleDelayMs: number;
  getCurrentPageUrl: () => string;
  normalizeVideoPageUrl: (url: string) => string | null;
  runtimeSendMessage: <T>(message: unknown) => Promise<T | null>;
  debugLog: (message: string) => void;
}): AutoShareNextController {
  let pendingTimer: number | null = null;
  let pendingNormalizedUrl: string | null = null;
  let lastRequestedNormalizedUrl: string | null = null;

  function clearPendingTimer(): void {
    if (pendingTimer !== null) {
      window.clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  }

  async function requestAutoShare(targetNormalizedUrl: string): Promise<void> {
    const currentNormalizedUrl = args.normalizeVideoPageUrl(
      args.getCurrentPageUrl(),
    );
    if (currentNormalizedUrl !== targetNormalizedUrl) {
      args.debugLog(
        `Skipped auto-share next video because page moved from ${targetNormalizedUrl} to ${currentNormalizedUrl ?? "unknown"}`,
      );
      return;
    }

    lastRequestedNormalizedUrl = targetNormalizedUrl;
    const message: ContentToBackgroundMessage = {
      type: "content:auto-share-next-video",
    };
    const response =
      await args.runtimeSendMessage<ShareCurrentVideoResponse>(message);
    if (response?.ok === false && response.error) {
      args.debugLog(`Auto-share next video failed: ${response.error}`);
    }
  }

  function scheduleForNavigation(input: {
    previousSharedUrl: string;
    nextNormalizedPageUrl: string;
  }): void {
    if (input.previousSharedUrl === input.nextNormalizedPageUrl) {
      return;
    }
    if (
      pendingNormalizedUrl === input.nextNormalizedPageUrl ||
      lastRequestedNormalizedUrl === input.nextNormalizedPageUrl
    ) {
      return;
    }

    clearPendingTimer();
    pendingNormalizedUrl = input.nextNormalizedPageUrl;
    pendingTimer = window.setTimeout(() => {
      const targetNormalizedUrl = pendingNormalizedUrl;
      pendingTimer = null;
      pendingNormalizedUrl = null;
      if (!targetNormalizedUrl) {
        return;
      }
      void requestAutoShare(targetNormalizedUrl).catch((error) => {
        args.debugLog(
          `Auto-share next video failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, args.settleDelayMs);
  }

  function destroy(): void {
    clearPendingTimer();
    pendingNormalizedUrl = null;
  }

  return {
    scheduleForNavigation,
    destroy,
  };
}
