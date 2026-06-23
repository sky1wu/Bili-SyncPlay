import assert from "node:assert/strict";
import test from "node:test";
import { isExtensionContextInvalidatedError } from "../src/shared/extension-errors";

test("detects extension context invalidated errors across thrown value shapes", () => {
  assert.equal(
    isExtensionContextInvalidatedError(
      new Error("Extension context invalidated."),
    ),
    true,
  );
  assert.equal(
    isExtensionContextInvalidatedError({
      message: "Extension context invalidated.",
    }),
    true,
  );
  assert.equal(
    isExtensionContextInvalidatedError("Extension context invalidated."),
    true,
  );
});

test("does not treat unrelated errors as extension context invalidation", () => {
  assert.equal(isExtensionContextInvalidatedError(new Error("boom")), false);
  assert.equal(isExtensionContextInvalidatedError({ message: "boom" }), false);
  assert.equal(isExtensionContextInvalidatedError(null), false);
});
