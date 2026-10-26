import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAnnouncementSchedule,
  isAnnouncementView,
} from "../src/shared/announcement";
import { setLocaleForTests } from "../src/shared/i18n";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

test("the schedule line gives the time and a rounded hint", () => {
  setLocaleForTests("zh-CN");
  const scheduledAt = new Date(2026, 9, 27, 4, 30).getTime();

  assert.equal(
    formatAnnouncementSchedule(scheduledAt, scheduledAt - 6 * HOUR_MS),
    "维护时间：10-27 04:30（约 6 小时后）",
  );
  assert.equal(
    formatAnnouncementSchedule(scheduledAt, scheduledAt - 20 * MINUTE_MS),
    "维护时间：10-27 04:30（约 20 分钟后）",
  );
  assert.equal(
    formatAnnouncementSchedule(scheduledAt, scheduledAt - 10_000),
    "维护时间：10-27 04:30（约 1 分钟后）",
  );
  assert.equal(
    formatAnnouncementSchedule(scheduledAt, scheduledAt - 3 * 24 * HOUR_MS),
    "维护时间：10-27 04:30（约 3 天后）",
  );
});

test("the schedule line drops the hint once the time has passed", () => {
  setLocaleForTests("zh-CN");
  const scheduledAt = new Date(2026, 9, 27, 4, 30).getTime();

  assert.equal(
    formatAnnouncementSchedule(scheduledAt, scheduledAt + MINUTE_MS),
    "维护时间：10-27 04:30",
  );
});

test("the schedule line is localized", () => {
  setLocaleForTests("en-US");
  const scheduledAt = new Date(2026, 9, 27, 4, 30).getTime();

  assert.equal(
    formatAnnouncementSchedule(scheduledAt, scheduledAt - 2 * HOUR_MS),
    "Scheduled: 10-27 04:30 (in about 2 h)",
  );
  setLocaleForTests(null);
});

test("isAnnouncementView accepts views and rejects malformed ones", () => {
  const view = { id: "a1", level: "info", message: "m", scheduledAt: null };
  assert.equal(isAnnouncementView(view), true);
  assert.equal(isAnnouncementView({ ...view, scheduledAt: 5 }), true);
  assert.equal(isAnnouncementView({ ...view, level: "error" }), false);
  assert.equal(isAnnouncementView({ ...view, scheduledAt: undefined }), false);
  assert.equal(isAnnouncementView({ ...view, id: 1 }), false);
  assert.equal(isAnnouncementView(null), false);
});
