import {
  isAnnouncement,
  type Announcement,
  type AnnouncementLevel,
} from "@bili-syncplay/protocol";

/**
 * The announcement as stored: everything but its remaining lifetime.
 *
 * The lifetime is not a field because no process may compute it from a stored
 * timestamp: the admin process that wrote it and the node that reads it run on
 * different machines. The store keeps it as a TTL and answers it as one, so
 * the only clock involved is the store's own.
 */
export type StoredAnnouncement = {
  id: string;
  level: AnnouncementLevel;
  message: string;
  /** Epoch milliseconds of the announced event, for display only. */
  scheduledAt: number | null;
  /** Epoch milliseconds, admin process clock; shown in the admin UI only. */
  publishedAt: number;
};

/** A stored announcement together with how long it still has, read at once. */
export type AnnouncementSnapshot = {
  announcement: StoredAnnouncement;
  remainingMs: number;
};

/**
 * Reads a stored body back, or `null` when it is not one.
 *
 * Validated with the very guard every receiver applies, so a body that would be
 * refused on the wire is refused here instead of being broadcast to be dropped.
 */
export function parseStoredAnnouncement(
  raw: string,
): StoredAnnouncement | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const scheduledAt = record.scheduledAt ?? null;
  const publishedAt = record.publishedAt;
  if (
    !(scheduledAt === null || typeof scheduledAt === "number") ||
    typeof publishedAt !== "number" ||
    !Number.isFinite(publishedAt) ||
    !isAnnouncement({
      id: record.id,
      level: record.level,
      message: record.message,
      scheduledAt: scheduledAt ?? undefined,
      // Any positive value: this checks the stored fields, not a lifetime.
      expiresInMs: 1,
    })
  ) {
    return null;
  }
  return {
    id: record.id as string,
    level: record.level as AnnouncementLevel,
    message: record.message as string,
    scheduledAt,
    publishedAt,
  };
}

/**
 * The wire form of a snapshot `elapsedMs` after it was read, or `null` once its
 * lifetime has run out in the meantime.
 */
export function toWireAnnouncement(
  snapshot: AnnouncementSnapshot,
  elapsedMs: number,
): Announcement | null {
  const expiresInMs = Math.floor(snapshot.remainingMs - Math.max(0, elapsedMs));
  if (expiresInMs <= 0) {
    return null;
  }
  const { announcement } = snapshot;
  return {
    id: announcement.id,
    level: announcement.level,
    message: announcement.message,
    ...(announcement.scheduledAt === null
      ? {}
      : { scheduledAt: announcement.scheduledAt }),
    expiresInMs,
  };
}
