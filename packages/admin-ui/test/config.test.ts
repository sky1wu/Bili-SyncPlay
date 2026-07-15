import { describe, expect, it } from "vitest";
import { normalizeAdminUiConfig } from "../src/config.js";

describe("normalizeAdminUiConfig", () => {
  it("returns defaults for non-object input", () => {
    expect(normalizeAdminUiConfig(null)).toEqual({
      demoEnabled: false,
      apiBaseUrl: "",
    });
    expect(normalizeAdminUiConfig("__ADMIN_UI_CONFIG__")).toEqual({
      demoEnabled: false,
      apiBaseUrl: "",
    });
    expect(normalizeAdminUiConfig(undefined)).toEqual({
      demoEnabled: false,
      apiBaseUrl: "",
    });
  });

  it("strips trailing slashes from apiBaseUrl", () => {
    expect(
      normalizeAdminUiConfig({ apiBaseUrl: "https://example.com//" }),
    ).toEqual({ demoEnabled: false, apiBaseUrl: "https://example.com" });
  });

  it("only accepts demoEnabled === true", () => {
    expect(normalizeAdminUiConfig({ demoEnabled: true }).demoEnabled).toBe(
      true,
    );
    expect(normalizeAdminUiConfig({ demoEnabled: "yes" }).demoEnabled).toBe(
      false,
    );
  });

  it("ignores non-string apiBaseUrl", () => {
    expect(normalizeAdminUiConfig({ apiBaseUrl: 123 }).apiBaseUrl).toBe("");
  });
});
