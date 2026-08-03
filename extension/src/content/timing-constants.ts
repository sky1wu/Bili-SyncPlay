/**
 * Timing constants whose *value* is part of the behaviour, so a regression test
 * can assert against the same number the content script ships with. Everything
 * else stays in `index.ts` with the wiring that uses it.
 */

/**
 * How long a page-load autoplay is suppressed while the tab waits for room state
 * to confirm what should be playing.
 */
export const INITIAL_ROOM_STATE_PAUSE_HOLD_MS = 3000;

/**
 * How long a recorded shared-video natural end stays usable as evidence that the
 * navigation which follows is that video's autoplay-next.
 *
 * This deliberately does NOT reuse {@link INITIAL_ROOM_STATE_PAUSE_HOLD_MS}: the
 * hold answers "how long do we suppress a page-load autoplay?", this answers "how
 * long can Bilibili's next-video countdown take?". They were the same constant
 * until #236, which made the marker expire before *every* countdown-driven
 * autoplay — measured at ~5s between the `ended` event and the SPA navigation, vs
 * a 3s hold. On `/video/` pages the address-bar fallback hid it; on bangumi season
 * pages, where the address bar keeps `ss<id>` and never matches the shared
 * `ep<id>`, the marker is the only evidence there is, so the next episode was
 * never auto-shared.
 *
 * 10s covers the observed countdown plus the navigation watcher's poll interval
 * and slow-load slack. Widening it does not weaken the classification: the marker
 * is URL-bound (it must still name the current `activeSharedUrl`) and is cleared
 * on any shared-url change or room teardown, so a stale end cannot reclassify an
 * unrelated navigation.
 */
export const SHARED_VIDEO_NATURAL_END_WINDOW_MS = 10000;
