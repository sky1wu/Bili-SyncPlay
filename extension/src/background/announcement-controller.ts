import type { Announcement } from "@bili-syncplay/protocol";
import {
  DISMISSED_ANNOUNCEMENT_LIMIT,
  type AnnouncementView,
} from "../shared/announcement";

/** `setTimeout` takes a signed 32-bit delay; a longer one fires at once. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export interface AnnouncementBadge {
  text: string;
  color: string;
}

export const ANNOUNCEMENT_BADGE_COLORS: Record<
  AnnouncementView["level"],
  string
> = {
  info: "#2563eb",
  warning: "#ea580c",
};

/**
 * Write the badge to the toolbar icon. Never throws: it runs inside every
 * state broadcast, and a browser without a badge (or a failed write) costs the
 * `!` and nothing else.
 */
export function applyActionBadge(
  action:
    | Pick<typeof chrome.action, "setBadgeText" | "setBadgeBackgroundColor">
    | null
    | undefined,
  badge: AnnouncementBadge | null,
): void {
  try {
    void action
      ?.setBadgeText({ text: badge?.text ?? "" })
      .catch(() => undefined);
    if (badge) {
      void action
        ?.setBadgeBackgroundColor({ color: badge.color })
        .catch(() => undefined);
    }
  } catch {
    // See above.
  }
}

export interface AnnouncementController {
  /** Load the remembered dismissals; call before the first `receive`. */
  hydrate(): Promise<void>;
  /** The server's current announcement (`server:announcement`). */
  receive(announcement: Announcement | null): void;
  dismiss(id: string): Promise<void>;
  /** What to show right now, or `null`. */
  getVisible(): AnnouncementView | null;
  /**
   * Push the visible announcement to the badge and content scripts when it
   * changed since the last push. Cheap when it did not; call on every state
   * change.
   */
  refresh(): void;
}

/**
 * Holds the server's announcement and decides whether it is shown (#325).
 *
 * Whether it is shown is DERIVED on every read — in a room, on the server that
 * sent it, not expired, not dismissed — rather than kept as a flag that every
 * leave / server change / expiry path would have to remember to clear. The
 * stored announcement itself is only ever replaced by the server's next one.
 */
export function createAnnouncementController(args: {
  getRoomCode: () => string | null;
  getServerUrl: () => string;
  loadDismissedIds: () => Promise<string[]>;
  saveDismissedIds: (ids: readonly string[]) => Promise<void>;
  setBadge: (badge: AnnouncementBadge | null) => void;
  notifyContentScripts: (announcement: AnnouncementView | null) => void;
  /** Re-broadcast state after a change this controller made on its own. */
  notifyAll: () => void;
  log: (message: string) => void;
  getMonotonicNow?: () => number;
}): AnnouncementController {
  const monotonicNow = () => args.getMonotonicNow?.() ?? performance.now();
  let current: {
    view: AnnouncementView;
    /** Monotonic: the server's remaining lifetime added to our own clock. */
    expiresAtMs: number;
    serverUrl: string;
  } | null = null;
  let dismissedIds: string[] = [];
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  // Distinct from `null` so the first refresh always writes: a service worker
  // that restarted has lost `current`, but the browser kept the badge it set.
  let lastPushedKey: string | null | undefined = undefined;

  function clearExpiryTimer(): void {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
  }

  function scheduleExpiry(): void {
    clearExpiryTimer();
    if (current === null) {
      return;
    }
    const remainingMs = current.expiresAtMs - monotonicNow();
    if (remainingMs <= 0) {
      return;
    }
    expiryTimer = setTimeout(
      () => {
        expiryTimer = null;
        // A lifetime past the timer's limit lands here early; wait out the rest.
        scheduleExpiry();
        args.notifyAll();
      },
      Math.min(remainingMs, MAX_TIMER_DELAY_MS),
    );
  }

  function getVisible(): AnnouncementView | null {
    if (
      current === null ||
      args.getRoomCode() === null ||
      args.getServerUrl() !== current.serverUrl ||
      monotonicNow() >= current.expiresAtMs ||
      dismissedIds.includes(current.view.id)
    ) {
      return null;
    }
    return current.view;
  }

  return {
    async hydrate() {
      // Never fails bootstrap: losing the dismissals only shows one again.
      try {
        dismissedIds = (await args.loadDismissedIds()).slice(
          -DISMISSED_ANNOUNCEMENT_LIMIT,
        );
      } catch (error) {
        args.log(
          `Failed to load dismissed announcements: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    receive(announcement) {
      if (announcement === null) {
        current = null;
      } else {
        current = {
          view: {
            id: announcement.id,
            level: announcement.level,
            message: announcement.message,
            scheduledAt: announcement.scheduledAt ?? null,
          },
          expiresAtMs: monotonicNow() + announcement.expiresInMs,
          serverUrl: args.getServerUrl(),
        };
      }
      scheduleExpiry();
      args.notifyAll();
    },
    async dismiss(id) {
      if (dismissedIds.includes(id)) {
        return;
      }
      dismissedIds = [...dismissedIds, id].slice(-DISMISSED_ANNOUNCEMENT_LIMIT);
      args.notifyAll();
      // Already gone everywhere; a failed write only means it comes back after
      // the browser restarts, which is not worth failing the click for.
      try {
        await args.saveDismissedIds(dismissedIds);
      } catch (error) {
        args.log(
          `Failed to persist dismissed announcement: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    getVisible,
    refresh() {
      const visible = getVisible();
      const key = visible?.id ?? null;
      if (key === lastPushedKey) {
        return;
      }
      lastPushedKey = key;
      args.setBadge(
        visible === null
          ? null
          : { text: "!", color: ANNOUNCEMENT_BADGE_COLORS[visible.level] },
      );
      args.notifyContentScripts(visible);
    },
  };
}
