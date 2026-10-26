import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnnouncementBanner,
  type AnnouncementBarPresenter,
} from "../src/content/announcement-banner";
import type { AnnouncementView } from "../src/shared/announcement";

function makeView(overrides: Partial<AnnouncementView> = {}): AnnouncementView {
  return {
    id: "a1",
    level: "warning",
    message: "今晚维护",
    scheduledAt: null,
    ...overrides,
  };
}

function createHarness(
  requestCurrent: () => Promise<unknown> = async () => null,
) {
  const events: string[] = [];
  const dismissed: string[] = [];
  let shown: { id: string; onDismiss: () => void } | null = null;
  const presenter: AnnouncementBarPresenter = {
    show(announcement, onDismiss) {
      events.push(`show:${announcement.id}`);
      shown = { id: announcement.id, onDismiss };
    },
    hide() {
      events.push("hide");
      shown = null;
    },
  };
  const banner = createAnnouncementBanner({
    requestCurrent,
    dismiss: (id) => dismissed.push(id),
    presenter,
  });
  return {
    banner,
    events,
    dismissed,
    clickDismiss: () => shown?.onDismiss(),
  };
}

test("only a warning announcement is shown on the page", () => {
  const harness = createHarness();

  harness.banner.apply(makeView({ level: "info" }));
  assert.deepEqual(harness.events, []);

  harness.banner.apply(makeView({ id: "a2" }));
  assert.deepEqual(harness.events, ["show:a2"]);
});

test("the same announcement pushed again is not shown anew", () => {
  const harness = createHarness();

  harness.banner.apply(makeView());
  harness.banner.apply(makeView());

  assert.deepEqual(harness.events, ["show:a1"]);
});

test("a withdrawal or a replacement updates the bar", () => {
  const harness = createHarness();

  harness.banner.apply(makeView());
  harness.banner.apply(makeView({ id: "a2" }));
  harness.banner.apply(null);

  assert.deepEqual(harness.events, ["show:a1", "show:a2", "hide"]);
});

test("dismissing hides the bar and tells the background which one", () => {
  const harness = createHarness();
  harness.banner.apply(makeView());

  harness.clickDismiss();

  assert.deepEqual(harness.events, ["show:a1", "hide"]);
  assert.deepEqual(harness.dismissed, ["a1"]);
});

test("the current announcement is fetched when the page loads", async () => {
  const harness = createHarness(async () => ({
    ok: true,
    announcement: makeView(),
  }));

  harness.banner.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.events, ["show:a1"]);
});

test("a push that beats the page-load answer is not overwritten by it", async () => {
  let answer: (value: unknown) => void = () => {};
  const harness = createHarness(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );

  harness.banner.start();
  harness.banner.apply(null);
  answer({ ok: true, announcement: makeView() });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.events, []);
});
