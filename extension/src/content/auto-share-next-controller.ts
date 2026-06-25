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

interface PendingAutoShare {
  previousSharedUrl: string;
  targetNormalizedUrl: string;
  attempt: number;
}

export function createAutoShareNextController(args: {
  settleDelayMs: number;
  /**
   * Maximum number of attempts (including the first) before giving up when the
   * background keeps reporting the page bridge is not ready yet. Defaults to 4.
   */
  maxAttempts?: number;
  /**
   * Delay before retrying when an attempt fails because the SPA navigation has
   * not settled yet. Defaults to {@link settleDelayMs}.
   */
  retryDelayMs?: number;
  getCurrentPageUrl: () => string;
  normalizeVideoPageUrl: (url: string) => string | null;
  runtimeSendMessage: <T>(message: unknown) => Promise<T | null>;
  debugLog: (message: string) => void;
}): AutoShareNextController {
  const maxAttempts = args.maxAttempts ?? 4;
  const retryDelayMs = args.retryDelayMs ?? args.settleDelayMs;

  let pendingTimer: number | null = null;
  let pendingNormalizedUrl: string | null = null;
  let lastRequestedNormalizedUrl: string | null = null;

  function clearPendingTimer(): void {
    if (pendingTimer !== null) {
      window.clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  }

  function scheduleRequest(pending: PendingAutoShare, delayMs: number): void {
    clearPendingTimer();
    pendingNormalizedUrl = pending.targetNormalizedUrl;
    pendingTimer = window.setTimeout(() => {
      pendingTimer = null;
      pendingNormalizedUrl = null;
      void requestAutoShare(pending).catch((error) => {
        args.debugLog(
          `Auto-share next video failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, delayMs);
  }

  async function requestAutoShare(pending: PendingAutoShare): Promise<void> {
    const currentNormalizedUrl = args.normalizeVideoPageUrl(
      args.getCurrentPageUrl(),
    );
    if (currentNormalizedUrl !== pending.targetNormalizedUrl) {
      args.debugLog(
        `Skipped auto-share next video because page moved from ${pending.targetNormalizedUrl} to ${currentNormalizedUrl ?? "unknown"}`,
      );
      return;
    }

    lastRequestedNormalizedUrl = pending.targetNormalizedUrl;
    const message: ContentToBackgroundMessage = {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl: pending.previousSharedUrl,
      },
    };
    const response =
      await args.runtimeSendMessage<ShareCurrentVideoResponse>(message);
    if (response?.ok === false) {
      // The background reports failure when the page bridge has not resolved
      // the new video yet (a slow SPA transition) or when sharing transiently
      // failed. In both cases the room is still stuck on the previous video, so
      // retry instead of leaving the sharer ahead of the room. Allow a retry to
      // re-run by clearing the de-duplication marker first.
      if (pending.attempt < maxAttempts) {
        lastRequestedNormalizedUrl = null;
        scheduleRequest(
          { ...pending, attempt: pending.attempt + 1 },
          retryDelayMs,
        );
        args.debugLog(
          `Auto-share next video not ready, retry ${pending.attempt + 1}/${maxAttempts}${response.error ? `: ${response.error}` : ""}`,
        );
        return;
      }
      args.debugLog(
        `Auto-share next video gave up after ${maxAttempts} attempts${response.error ? `: ${response.error}` : ""}`,
      );
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

    scheduleRequest(
      {
        previousSharedUrl: input.previousSharedUrl,
        targetNormalizedUrl: input.nextNormalizedPageUrl,
        attempt: 1,
      },
      args.settleDelayMs,
    );
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
