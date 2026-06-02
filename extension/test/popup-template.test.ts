import assert from "node:assert/strict";
import test from "node:test";
import { renderPopupTemplate } from "../src/popup/popup-template";
import { setLocaleForTests } from "../src/shared/i18n";

test("popup room section heading renders a decorative room icon before the label", () => {
  setLocaleForTests("en-US");
  try {
    const html = renderPopupTemplate();
    const headingMatch =
      /<div class="section-heading section-heading-room">([\s\S]*?)<\/div>/.exec(
        html,
      );

    assert.ok(headingMatch, "missing room section heading");
    const headingHtml = headingMatch[1];
    assert.match(headingHtml, /class="room-heading-icon"/);
    assert.match(headingHtml, /aria-hidden="true"/);
    assert.ok(
      headingHtml.indexOf("room-heading-icon") < headingHtml.indexOf("Room"),
      "room icon should render before the Room label",
    );
  } finally {
    setLocaleForTests(null);
  }
});
