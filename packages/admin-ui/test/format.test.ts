import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatDuration,
  formatTime,
} from "../src/lib/format.js";

describe("formatDuration", () => {
  it("formats each magnitude with two units", () => {
    expect(formatDuration(5_000)).toBe("5 秒");
    expect(formatDuration(3 * 60_000 + 20_000)).toBe("3 分钟 20 秒");
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2 小时 5 分钟");
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3 天 4 小时");
  });

  it("returns a dash for invalid input", () => {
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("formatDateTime / formatTime", () => {
  it("returns a dash for missing timestamps", () => {
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime(0)).toBe("—");
    expect(formatTime(null)).toBe("—");
  });

  it("formats valid timestamps", () => {
    const timestamp = Date.UTC(2026, 0, 2, 3, 4, 5);
    expect(formatDateTime(timestamp)).not.toBe("—");
    expect(formatTime(timestamp)).not.toBe("—");
  });
});
