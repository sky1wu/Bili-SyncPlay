import {
  isAnnouncementLevel,
  type AnnouncementLevel,
} from "@bili-syncplay/protocol";
import { t } from "./i18n";

/**
 * What the popup and content scripts are told to show (#325): the server's
 * announcement minus its lifetime, which only the background tracks. Absent —
 * `null` — whenever it should not be shown, for whatever reason; receivers do
 * not second-guess it.
 */
export interface AnnouncementView {
  id: string;
  level: AnnouncementLevel;
  message: string;
  /** Epoch milliseconds of the announced event, for display only. */
  scheduledAt: number | null;
}

/** How many dismissed announcement ids are remembered, newest kept. */
export const DISMISSED_ANNOUNCEMENT_LIMIT = 20;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * "维护时间：10-27 04:30（约 6 小时后）". The relative part reads `scheduledAt`
 * against this machine's clock, which is fine for a rough hint to a person and
 * is why it is rounded to the hour or day — and dropped once the time has
 * passed — rather than counted down.
 */
export function formatAnnouncementSchedule(
  scheduledAt: number,
  nowMs: number,
): string {
  const date = new Date(scheduledAt);
  const time = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const remainingMs = scheduledAt - nowMs;
  if (remainingMs <= 0) {
    return t("announcementScheduledAt", { time });
  }
  let relative: string;
  if (remainingMs < HOUR_MS) {
    relative = t("announcementInMinutes", {
      count: Math.max(1, Math.round(remainingMs / MINUTE_MS)),
    });
  } else if (remainingMs < 2 * DAY_MS) {
    relative = t("announcementInHours", {
      count: Math.round(remainingMs / HOUR_MS),
    });
  } else {
    relative = t("announcementInDays", {
      count: Math.round(remainingMs / DAY_MS),
    });
  }
  return t("announcementScheduledAtRelative", { time, relative });
}

export function isAnnouncementView(value: unknown): value is AnnouncementView {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<Record<keyof AnnouncementView, unknown>>;
  return (
    typeof record.id === "string" &&
    isAnnouncementLevel(record.level) &&
    typeof record.message === "string" &&
    (record.scheduledAt === null ||
      (typeof record.scheduledAt === "number" &&
        Number.isFinite(record.scheduledAt)))
  );
}
