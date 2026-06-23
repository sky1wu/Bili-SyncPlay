import assert from "node:assert/strict";
import test from "node:test";
import { getUiLanguage, setLocaleForTests } from "../src/shared/i18n";

const originalChrome = globalThis.chrome;

test.afterEach(() => {
  globalThis.chrome = originalChrome;
  setLocaleForTests(null);
});

test("getUiLanguage falls back when the extension context is invalidated", () => {
  globalThis.chrome = {
    i18n: {
      getUILanguage() {
        throw { message: "Extension context invalidated." };
      },
    },
  } as unknown as typeof chrome;

  assert.equal(typeof getUiLanguage(), "string");
});

test("getUiLanguage still rethrows unrelated chrome i18n errors", () => {
  globalThis.chrome = {
    i18n: {
      getUILanguage() {
        throw new Error("boom");
      },
    },
  } as unknown as typeof chrome;

  assert.throws(() => getUiLanguage(), /boom/);
});
