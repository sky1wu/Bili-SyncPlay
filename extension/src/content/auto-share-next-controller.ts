import type {
  ContentToBackgroundMessage,
  ShareCurrentVideoResponse,
} from "../shared/messages";

export interface AutoShareNextController {
  scheduleForNavigation(args: {
    previousSharedUrl: string;
    nextNormalizedPageUrl: string;
    previousAutoShareTargetUrl?: string | null;
  }): void;
  /**
   * Invalidate any pending/in-flight auto-share. Called when a fresh navigation
   * is not itself a sharer autoplay (e.g. a manual detour, even back to the same
   * target) so a stale settle timer cannot later fire and bypass the manual
   * share confirmation.
   */
  cancelPending(): void;
  destroy(): void;
}

interface PendingAutoShare {
  previousSharedUrl: string;
  targetNormalizedUrl: string;
  attempt: number;
  /**
   * Identifies the navigation that produced this request. A later navigation —
   * even one back to the same target — bumps the active generation and
   * supersedes any in-flight request: the stale request abandons itself instead
   * of rescheduling, so its failure retry cannot cancel the newer navigation's
   * pending timer.
   */
  generation: number;
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
  /**
   * The room's *currently* confirmed shared video, read fresh when a request is
   * about to be sent. Used to re-anchor `previousSharedUrl` so a chained autoplay
   * that confirms an intermediate step during the settle window is not sent with
   * a now-stale anchor. Optional: when absent, the value captured at schedule
   * time is used unchanged.
   */
  getActiveSharedUrl?: () => string | null;
  runtimeSendMessage: <T>(message: unknown) => Promise<T | null>;
  debugLog: (message: string) => void;
}): AutoShareNextController {
  const maxAttempts = args.maxAttempts ?? 4;
  const retryDelayMs = args.retryDelayMs ?? args.settleDelayMs;

  let pendingTimer: number | null = null;
  let pendingNormalizedUrl: string | null = null;
  let pendingPreviousSharedUrl: string | null = null;
  let scheduleGeneration = 0;
  // Targets this controller has actually *sent* in the current uninterrupted
  // chain. The room's confirmed shared video, when it is ours, is always one of
  // these — so a request whose scheduled anchor went stale may safely re-anchor
  // to the live shared video iff it is in this set. Reset when a fresh
  // (non-chained) auto-share starts; see {@link scheduleForNavigation}.
  const sentChainTargets = new Set<string>();

  function clearPendingTimer(): void {
    if (pendingTimer !== null) {
      window.clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  }

  function scheduleRequest(pending: PendingAutoShare, delayMs: number): void {
    clearPendingTimer();
    pendingNormalizedUrl = pending.targetNormalizedUrl;
    pendingPreviousSharedUrl = pending.previousSharedUrl;
    pendingTimer = window.setTimeout(() => {
      pendingTimer = null;
      pendingNormalizedUrl = null;
      pendingPreviousSharedUrl = null;
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

    // Re-anchor to the room's *currently* confirmed shared video when — and only
    // when — it is a video THIS chain has already sent that just confirmed. A
    // chained autoplay (A→B→C) schedules B→C while B is still unconfirmed, so the
    // anchor is A; but B's `room:state` can confirm during this settle window,
    // moving the room to B. Sending the stale anchor A would make the background
    // see room=B ≠ A, classify it as "moved-on", and skip C with `ok:true` (no
    // retry) — stranding the room on B. Re-anchoring to B keeps the background
    // "on-scheduled" so it advances to C.
    //
    // Restricting the re-anchor to our own sent targets handles deeper lag too:
    // if B→C→D rapidly superseded down to D while only B was actually sent, B
    // (not the immediately-prior page C) is what confirms, and B ∈ sentChainTargets
    // so D still re-anchors to it. Conversely, if the room moved during the window
    // to a video we never sent — e.g. the same member manually shared X from
    // another tab and it confirmed — X ∉ sentChainTargets, so we keep the
    // scheduled anchor and let the background skip this stale auto-share as
    // moved-on rather than clobber X.
    const liveAnchor = args.getActiveSharedUrl?.() ?? null;
    const previousSharedUrl =
      liveAnchor !== null && sentChainTargets.has(liveAnchor)
        ? liveAnchor
        : pending.previousSharedUrl;

    // Record the target before sending: once dispatched, the room may confirm it,
    // and a later chain step whose anchor goes stale must be able to re-anchor to
    // it here.
    sentChainTargets.add(pending.targetNormalizedUrl);

    const message: ContentToBackgroundMessage = {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl,
        targetNormalizedUrl: pending.targetNormalizedUrl,
      },
    };
    const response =
      await args.runtimeSendMessage<ShareCurrentVideoResponse>(message);

    // A newer navigation arrived while this request was in flight (it bumped the
    // generation, even if it targets the same URL). Abandon this stale request
    // so its retry cannot cancel the newer navigation's pending timer.
    if (pending.generation !== scheduleGeneration) {
      return;
    }

    if (response?.ok === false) {
      // Connectivity deferral: the sharer is reconnecting and the background
      // cannot safely act on stale room state yet. Keep retrying *without*
      // consuming the short page-bridge attempt budget — a WebSocket reconnect
      // can easily take longer than maxAttempts × retryDelayMs, and no separate
      // event re-triggers this auto-share afterwards, so spending the budget
      // here would strand the room on the old video.
      if (response.deferred) {
        scheduleRequest({ ...pending }, retryDelayMs);
        args.debugLog(
          "Auto-share next video deferred while offline, will retry after reconnect",
        );
        return;
      }
      // The background reports failure when the page bridge has not resolved the
      // scheduled next video yet (a slow SPA transition) or when sharing
      // transiently failed. In both cases the room is still stuck on the
      // previous video, so retry instead of leaving the sharer ahead of it.
      if (pending.attempt < maxAttempts) {
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
    /**
     * The sharer's own in-flight auto-share target this navigation advanced FROM,
     * or `null`/absent when this is not a chained step (it came straight from the
     * room's confirmed shared video). A `null`/absent value marks a fresh chain,
     * so the sent-target lineage from any previous chain is reset.
     */
    previousAutoShareTargetUrl?: string | null;
  }): void {
    if (input.previousSharedUrl === input.nextNormalizedPageUrl) {
      return;
    }
    // A fresh (non-chained) auto-share starts a new lineage: the room cannot be
    // on a target an earlier, now-abandoned chain sent, so clear the set to keep
    // the re-anchor (in `requestAutoShare`) from adopting a stale prior target.
    if (input.previousAutoShareTargetUrl == null) {
      sentChainTargets.clear();
    }
    // Coalesce only with a still-pending timer for the exact same transition —
    // same target *and* same source shared video — so rapid duplicate
    // navigation signals do not keep pushing back the settle deadline. A new
    // navigation to the same target but from a different `previousSharedUrl`
    // (e.g. the room moved A→C and the sharer autoplays C→B while an A→B retry
    // was still pending) is a distinct legitimate advance and must supersede the
    // old pending request via the generation bump below, not be dropped. Once
    // the timer has fired (the request is in flight), any fresh navigation also
    // supersedes it through the same generation bump.
    if (
      pendingNormalizedUrl === input.nextNormalizedPageUrl &&
      pendingPreviousSharedUrl === input.previousSharedUrl
    ) {
      return;
    }

    scheduleGeneration += 1;
    scheduleRequest(
      {
        previousSharedUrl: input.previousSharedUrl,
        targetNormalizedUrl: input.nextNormalizedPageUrl,
        attempt: 1,
        generation: scheduleGeneration,
      },
      args.settleDelayMs,
    );
  }

  function cancelPending(): void {
    clearPendingTimer();
    pendingNormalizedUrl = null;
    pendingPreviousSharedUrl = null;
    // Bump the generation so any in-flight request abandons itself instead of
    // rescheduling — a manual/non-autoplay navigation must fully invalidate a
    // pending auto-share, including one already awaiting the background.
    scheduleGeneration += 1;
  }

  function destroy(): void {
    cancelPending();
  }

  return {
    scheduleForNavigation,
    cancelPending,
    destroy,
  };
}
