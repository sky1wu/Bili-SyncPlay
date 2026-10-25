import type { ServerMessage } from "@bili-syncplay/protocol";
import {
  toWireAnnouncement,
  type AnnouncementSnapshot,
} from "./announcement.js";
import { createMaintenancePass } from "./maintenance-pass.js";
import {
  hasAttachedSocket,
  type LogEvent,
  type SendMessage,
  type Session,
} from "./types.js";

/** First protocol version whose clients understand `server:announcement`. */
export const ANNOUNCEMENT_PROTOCOL_VERSION = 5;

/**
 * How often each node re-reads the announcement.
 *
 * The delivery delay of a publication or a withdrawal. Fifteen seconds is
 * nothing next to a maintenance notice given minutes or hours ahead, and a poll
 * that slow costs one Redis call per node per interval.
 */
export const DEFAULT_ANNOUNCEMENT_POLL_INTERVAL_MS = 15_000;

/** Caps one poll; below the interval so a stall reports before the next tick. */
export const DEFAULT_ANNOUNCEMENT_POLL_TIMEOUT_MS = 5_000;

export type AnnouncementBroadcaster = {
  start: () => void;
  /** Stops polling and waits, bounded, for a read still in flight. */
  stop: () => Promise<void>;
  /** Polls once now, under the same cap and overlap rule as the timer. */
  pollNow: () => Promise<void>;
  /**
   * Sends the current announcement — `null` included — to a session that just
   * entered a room. Nothing is sent before the first poll answered, since
   * "not read yet" is not "there is none".
   */
  sendCurrentTo: (session: Session) => void;
};

/**
 * Keeps every local client's announcement in step with the stored one.
 *
 * Polled rather than pushed through the admin command bus: that bus is a
 * request/reply addressed to one instance, and a push is a one-shot broadcast —
 * a node that misses it (restarting, briefly disconnected from Redis) would
 * keep the old announcement indefinitely. Re-reading the stored state on every
 * tick needs no delivery trail: a missed tick is repaired by the next one, and
 * a node that just started catches up on its first.
 *
 * What it sends is the CURRENT state, never a diff, so sending it twice is
 * harmless. That is also why the same message serves both the change broadcast
 * and the copy each joining session gets.
 */
export function createAnnouncementBroadcaster(options: {
  readAnnouncement: () => Promise<AnnouncementSnapshot | null>;
  /** Every local session currently seated in a room. */
  listRoomSessions: () => Session[];
  send: SendMessage;
  logEvent?: LogEvent;
  intervalMs?: number;
  timeoutMs?: number;
  /** Monotonic: only ever used to measure how long ago a snapshot was read. */
  monotonicNow?: () => number;
}): AnnouncementBroadcaster {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const intervalMs =
    options.intervalMs ?? DEFAULT_ANNOUNCEMENT_POLL_INTERVAL_MS;
  // Kept below the interval whatever it is configured to, so the tick after a
  // stalled read reports `stalled` rather than `overlapped`.
  const timeoutMs =
    options.timeoutMs ??
    Math.min(DEFAULT_ANNOUNCEMENT_POLL_TIMEOUT_MS, Math.max(1, intervalMs / 2));

  /**
   * The last answer and when its read STARTED. Anchoring at the start rather
   * than at the answer counts the round trip as already elapsed, so the
   * lifetime sent out can only err short — a client hides a notice a moment
   * early rather than showing an expired one.
   */
  let known: {
    snapshot: AnnouncementSnapshot | null;
    readStartedAtMs: number;
  } | null = null;

  function currentMessage(): ServerMessage | null {
    if (known === null) {
      return null;
    }
    return {
      type: "server:announcement",
      payload: {
        announcement:
          known.snapshot === null
            ? null
            : toWireAnnouncement(
                known.snapshot,
                monotonicNow() - known.readStartedAtMs,
              ),
      },
    };
  }

  function sendTo(session: Session, message: ServerMessage): boolean {
    if (
      !hasAttachedSocket(session) ||
      (session.protocolVersion ?? 1) < ANNOUNCEMENT_PROTOCOL_VERSION
    ) {
      return false;
    }
    options.send(session.socket, message);
    return true;
  }

  /** Returns how many sessions it reached. */
  function broadcast(): number {
    const message = currentMessage();
    if (message === null) {
      return 0;
    }
    let recipients = 0;
    for (const session of options.listRoomSessions()) {
      if (sendTo(session, message)) {
        recipients += 1;
      }
    }
    options.logEvent?.("announcement_broadcast", {
      announcementId:
        message.type === "server:announcement"
          ? (message.payload.announcement?.id ?? null)
          : null,
      recipients,
      result: "ok",
    });
    return recipients;
  }

  const pass = createMaintenancePass<
    { snapshot: AnnouncementSnapshot | null; readStartedAtMs: number },
    void
  >({
    name: "announcement poll",
    intervalMs,
    timeoutMs,
    autoStart: false,
    // It only relays state; a process with nothing else to do may exit.
    unrefTimer: true,
    run: async () => {
      const readStartedAtMs = monotonicNow();
      const snapshot = await options.readAnnouncement();
      return { snapshot, readStartedAtMs };
    },
    onSuccess: (result) => {
      const previousId =
        known === null ? undefined : (known.snapshot?.announcement.id ?? null);
      known = result;
      const currentId = result.snapshot?.announcement.id ?? null;
      // Ids are minted per publication, so "same id" means "same content".
      // The first answer always goes out: sessions that joined before it got
      // nothing, and may still hold a notice from before a restart.
      const changed = previousId !== currentId;
      const recipients = changed ? broadcast() : 0;
      // Every successful poll, changed or not: `announcement_broadcast` fires
      // only on a change, so on its own a healthy idle poller and a stopped one
      // are the same silence. This line is what tells them apart.
      options.logEvent?.("announcement_polled", {
        announcementId: currentId,
        changed,
        recipients,
        result: "ok",
      });
    },
    onFailure: ({ reason, error }) => {
      // `known` stays as it was. A read that failed says nothing about the
      // announcement, and broadcasting `null` for it would withdraw a live
      // notice from every client each time Redis hiccups.
      options.logEvent?.("announcement_poll_failed", {
        reason,
        timeoutMs,
        result: reason === "overlapped" ? "ignored" : "error",
        error: error instanceof Error ? error.message : String(error),
      });
    },
    onSettleTimeout: ({ pendingCalls, budgetMs }) => {
      options.logEvent?.("announcement_poll_stop_unsettled", {
        pendingCalls,
        budgetMs,
        result: "error",
      });
    },
  });

  return {
    start() {
      pass.start();
      void pass.runNow().catch(() => undefined);
    },
    stop: () => pass.stop(),
    pollNow: () => pass.runNow(),
    sendCurrentTo(session) {
      const message = currentMessage();
      if (message !== null) {
        sendTo(session, message);
      }
    },
  };
}
