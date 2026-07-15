import { describe, expect, it } from "vitest";
import {
  clearStoredToken,
  getStoredToken,
  setStoredToken,
} from "../src/auth/token-store.js";

describe("token-store", () => {
  it("round-trips a token and shares the legacy storage key", () => {
    expect(getStoredToken()).toBe("");
    setStoredToken("token-abc");
    expect(getStoredToken()).toBe("token-abc");
    expect(localStorage.getItem("bili-syncplay-admin-token")).toBe("token-abc");
    clearStoredToken();
    expect(getStoredToken()).toBe("");
  });
});
