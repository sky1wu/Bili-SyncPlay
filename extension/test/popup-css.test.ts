import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const popupCss = readFileSync(
  path.resolve(import.meta.dirname, "../public/popup.css"),
  "utf8",
);

test("voice mic status dot uses green for live mic and neutral gray for muted connected mic", () => {
  assert.match(ruleBody(".voice-dot.is-connected"), /var\(--voice-muted-dot\)/);
  assert.doesNotMatch(
    ruleBody(".voice-dot.is-connected"),
    /var\(--danger-text\)/,
  );
  assert.match(ruleBody(".voice-dot.is-live"), /var\(--success\)/);
  assert.match(popupCss, /--voice-muted-dot:\s*#8b93a7;/);
  assert.match(popupCss, /--voice-muted-dot:\s*#97a0b3;/);
  assert.doesNotMatch(popupCss, /--voice-muted-dot:\s*#ff/i);
});

test("room heading icon is sized and aligned with the section label", () => {
  assert.match(ruleBody(".section-heading-room"), /inline-flex/);
  assert.match(ruleBody(".section-heading-room"), /align-items:\s*center/);
  assert.match(ruleBody(".room-heading-icon"), /width:\s*14px/);
  assert.match(ruleBody(".room-heading-icon"), /height:\s*14px/);
  assert.match(ruleBody(".room-heading-icon svg"), /width:\s*14px/);
});

function ruleBody(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`).exec(
    popupCss,
  );
  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[1];
}
