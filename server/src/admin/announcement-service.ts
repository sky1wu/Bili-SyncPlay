import { randomUUID } from "node:crypto";
import {
  ANNOUNCEMENT_MESSAGE_MAX_LENGTH,
  isAnnouncementLevel,
} from "@bili-syncplay/protocol";
import type { StoredAnnouncement } from "../announcement.js";
import type { RoomStore } from "../room-store.js";
import type { LogEvent } from "../types.js";
import { AdminActionError } from "./action-service.js";
import {
  appendAuditDetached,
  type GlobalAuditStore,
} from "./global-audit-store.js";
import type { AdminSession } from "./types.js";

/**
 * The longest lifetime a publication may ask for.
 *
 * An announcement is a notice about something coming up, not a banner to leave
 * up indefinitely; a bound also keeps a mistyped year from parking one in
 * Redis until someone remembers to withdraw it.
 */
export const ANNOUNCEMENT_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const WITHDRAW_REASON_MAX_LENGTH = 200;

export type AdminAnnouncementView = StoredAnnouncement & {
  /**
   * When it lapses, on THIS process's clock: its remaining lifetime as the
   * store reports it, added to `now()` here. For a person reading the admin
   * page, not for anything that compares it with another machine's clock.
   */
  expiresAt: number;
};

export type PublishAnnouncementInput = {
  level?: unknown;
  message?: unknown;
  scheduledAt?: unknown;
  expiresAt?: unknown;
};

function badRequest(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new AdminActionError(400, code, message, details);
}

function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Publish / withdraw / read the operator announcement (#325).
 *
 * Deliberately nothing but a store write: every node picks the change up on its
 * next poll (`announcement-broadcaster`), so there is no fan-out here to wait
 * on, confirm or retry.
 */
export function createAdminAnnouncementService(options: {
  instanceId: string;
  roomStore: Pick<
    RoomStore,
    "getAnnouncement" | "setAnnouncement" | "clearAnnouncement"
  >;
  auditLogService: GlobalAuditStore;
  logEvent: LogEvent;
  now?: () => number;
  generateId?: () => string;
}) {
  const now = options.now ?? Date.now;
  const generateId = options.generateId ?? randomUUID;

  function writeAudit(
    actor: AdminSession,
    action: "publish_announcement" | "withdraw_announcement",
    targetId: string,
    request: Record<string, unknown>,
    result: "ok" | "error",
    reason?: string,
  ): void {
    appendAuditDetached(options.auditLogService, options.logEvent, {
      actor,
      action,
      targetType: "announcement",
      targetId,
      request,
      result,
      reason,
      instanceId: options.instanceId,
    });
  }

  async function getCurrent(): Promise<{
    announcement: AdminAnnouncementView | null;
  }> {
    const snapshot = await options.roomStore.getAnnouncement("request");
    if (snapshot === null) {
      return { announcement: null };
    }
    return {
      announcement: {
        ...snapshot.announcement,
        expiresAt: now() + snapshot.remainingMs,
      },
    };
  }

  async function publish(
    actor: AdminSession,
    input: PublishAnnouncementInput,
  ): Promise<{ announcement: AdminAnnouncementView }> {
    if (!isAnnouncementLevel(input.level)) {
      badRequest("invalid_level", "level must be info or warning.");
    }
    if (typeof input.message !== "string" || !input.message.trim()) {
      badRequest("invalid_message", "message is required.");
    }
    const message = input.message.trim();
    if (message.length > ANNOUNCEMENT_MESSAGE_MAX_LENGTH) {
      badRequest("input_too_long", "message is too long.", {
        name: "message",
        maxLength: ANNOUNCEMENT_MESSAGE_MAX_LENGTH,
      });
    }
    const scheduledAt = input.scheduledAt ?? null;
    if (scheduledAt !== null && !isEpochMs(scheduledAt)) {
      badRequest(
        "invalid_scheduled_at",
        "scheduledAt must be epoch milliseconds.",
      );
    }
    if (!isEpochMs(input.expiresAt)) {
      badRequest("invalid_expires_at", "expiresAt must be epoch milliseconds.");
    }
    // The one place an absolute time becomes a lifetime: the admin's chosen
    // time against this process's clock, then handed to the store as a TTL so
    // no reader ever has to compare clocks again.
    const publishedAt = now();
    const ttlMs = input.expiresAt - publishedAt;
    if (ttlMs <= 0) {
      badRequest("expires_at_in_past", "expiresAt must be in the future.");
    }
    if (ttlMs > ANNOUNCEMENT_MAX_LIFETIME_MS) {
      badRequest("expires_at_too_far", "expiresAt must be within 30 days.", {
        maxLifetimeMs: ANNOUNCEMENT_MAX_LIFETIME_MS,
      });
    }

    const announcement: StoredAnnouncement = {
      id: generateId(),
      level: input.level,
      message,
      scheduledAt,
      publishedAt,
    };
    const request = {
      level: announcement.level,
      message,
      scheduledAt,
      expiresAt: input.expiresAt,
    };
    try {
      await options.roomStore.setAnnouncement(announcement, ttlMs);
    } catch (error) {
      writeAudit(
        actor,
        "publish_announcement",
        announcement.id,
        request,
        "error",
      );
      throw error;
    }
    writeAudit(actor, "publish_announcement", announcement.id, request, "ok");
    options.logEvent("announcement_published", {
      announcementId: announcement.id,
      // Not `level`: the logger owns that key for the log level.
      announcementLevel: announcement.level,
      ttlMs,
      actor: actor.username,
      result: "ok",
    });
    return {
      announcement: { ...announcement, expiresAt: publishedAt + ttlMs },
    };
  }

  async function withdraw(
    actor: AdminSession,
    reason?: unknown,
  ): Promise<{ withdrawnId: string | null }> {
    if (reason !== undefined && typeof reason !== "string") {
      badRequest("invalid_reason", "reason must be a string.");
    }
    const trimmedReason = reason?.trim() || undefined;
    if (
      trimmedReason !== undefined &&
      trimmedReason.length > WITHDRAW_REASON_MAX_LENGTH
    ) {
      badRequest("input_too_long", "reason is too long.", {
        name: "reason",
        maxLength: WITHDRAW_REASON_MAX_LENGTH,
      });
    }
    // Read first only to name what is being withdrawn in the audit trail; the
    // delete below does not depend on it, so a publication racing in between
    // is withdrawn too — which is what "withdraw the announcement" asks for.
    const current = await options.roomStore.getAnnouncement("request");
    const targetId = current?.announcement.id ?? "none";
    try {
      await options.roomStore.clearAnnouncement();
    } catch (error) {
      writeAudit(
        actor,
        "withdraw_announcement",
        targetId,
        {},
        "error",
        trimmedReason,
      );
      throw error;
    }
    writeAudit(
      actor,
      "withdraw_announcement",
      targetId,
      {},
      "ok",
      trimmedReason,
    );
    options.logEvent("announcement_withdrawn", {
      announcementId: current?.announcement.id ?? null,
      actor: actor.username,
      result: "ok",
    });
    return { withdrawnId: current?.announcement.id ?? null };
  }

  return { getCurrent, publish, withdraw };
}
