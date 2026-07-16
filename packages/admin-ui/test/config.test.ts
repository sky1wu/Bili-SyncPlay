import { describe, expect, it } from "vitest";
import { normalizeAdminUiConfig } from "../src/config.js";

describe("normalizeAdminUiConfig", () => {
  it("returns defaults for non-object input", () => {
    expect(normalizeAdminUiConfig(null)).toEqual({ apiBaseUrl: "" });
    expect(normalizeAdminUiConfig("__ADMIN_UI_CONFIG__")).toEqual({
      apiBaseUrl: "",
    });
    expect(normalizeAdminUiConfig(undefined)).toEqual({ apiBaseUrl: "" });
  });

  it("strips trailing slashes from apiBaseUrl", () => {
    expect(
      normalizeAdminUiConfig({ apiBaseUrl: "https://example.com//" }),
    ).toEqual({ apiBaseUrl: "https://example.com" });
  });

  it("ignores non-string apiBaseUrl", () => {
    expect(normalizeAdminUiConfig({ apiBaseUrl: 123 }).apiBaseUrl).toBe("");
  });
});
