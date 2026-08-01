// Selectors for the Bilibili video player container across page types (normal
// video, bangumi, festival). A pointer gesture is treated as a play intent only
// when it lands inside one of these.
const PLAYER_CONTAINER_SELECTOR = ".bpx-player-container, #bilibili-player";

// Editable targets (the danmaku / comment input) are never a play intent, even
// when nested inside the player container. The `[contenteditable]` clause
// excludes only the explicit `false` value so every truly editable variant
// (empty string, `true`, `plaintext-only`, …) is covered; `isContentEditable`
// below additionally catches targets that inherit editability from an ancestor.
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

// Keys that toggle playback on Bilibili. A keydown only counts as an in-player
// play intent for these (so Esc/Tab/typing do not authorize playback).
const PLAY_TOGGLE_KEYS = new Set([" ", "Spacebar", "k", "K"]);

// Physical keys that set a playback SPEED on Bilibili when combined with Shift
// (Shift+1 → 1x, Shift+2 → 2x). Matched on `code` rather than `key` because
// `key` carries the SHIFTED character — Shift+1 reports "!" on a US layout — so
// a `key` comparison would silently never match. `code` is the physical key and
// is layout-independent.
const RATE_CONTROL_SHIFT_CODES = new Set(["Digit1", "Digit2"]);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return (
    target.closest(EDITABLE_SELECTOR) !== null ||
    (target as HTMLElement).isContentEditable
  );
}

/**
 * Whether a gesture is the user operating the player's playback-SPEED control.
 *
 * Deliberately separate from {@link isGestureInsidePlayer}: that predicate
 * authorizes PLAYBACK on "load paused" pages, so widening it with speed keys
 * would wave the page-load autoplay through. This one only ever ends a rate
 * catch-up session, so the two must not share a key set.
 *
 * Its whole purpose is to be POSITIVE evidence that something other than our own
 * catch-up moved the rate. Inferring that from "the element's rate is not the one
 * we wrote" does not work — the player resets the live rate by itself while
 * recovering from a stall — so the signal has to come from the input itself.
 *
 * The hold-to-fast-forward key is matched only while it REPEATS. A short
 * ArrowRight press is a 5s seek and leaves the rate alone; only holding it
 * engages 3x, and holding is exactly what produces auto-repeat keydowns. Without
 * that distinction every arrow-key seek would count as a speed change and a
 * stall-reset landing next to one would be misread as a user takeover.
 */
export function isRateControlGesture(event: Event): boolean {
  if (event.type !== "keydown" || isEditableTarget(event.target)) {
    return false;
  }
  const keyboardEvent = event as KeyboardEvent;
  if (keyboardEvent.key === "ArrowRight") {
    return keyboardEvent.repeat;
  }
  return (
    keyboardEvent.shiftKey && RATE_CONTROL_SHIFT_CODES.has(keyboardEvent.code)
  );
}

/**
 * Whether a user gesture event represents an intent to control the player
 * itself — a pointer/touch gesture inside the player container, or a play-toggle
 * key. Used to authorize manual playback of a non-shared video on a "load
 * paused" page WITHOUT letting a stray click on blank space / a popup (the
 * gesture tracker is document/window level) wave through the page-load autoplay.
 */
export function isGestureInsidePlayer(event: Event): boolean {
  const target = event.target;
  if (!(target instanceof Element)) {
    return false;
  }
  if (
    target.closest(EDITABLE_SELECTOR) ||
    (target as HTMLElement).isContentEditable
  ) {
    return false;
  }
  if (event.type === "keydown") {
    const keyboardEvent = event as KeyboardEvent;
    // Auto-repeat keydowns from holding the key are not discrete play intents.
    // Counting them would keep refreshing `lastUserGestureInPlayerAt` past a
    // forced pause, letting a single held press masquerade as a NEW post-pause
    // gesture and wrongly release the load hold without the user pressing again.
    if (keyboardEvent.repeat) {
      return false;
    }
    return PLAY_TOGGLE_KEYS.has(keyboardEvent.key);
  }
  return target.closest(PLAYER_CONTAINER_SELECTOR) !== null;
}

export function startUserGestureTracking(
  onGesture: (insidePlayer: boolean, rateControl: boolean) => void,
): void {
  const gestureEvents: Array<keyof DocumentEventMap> = [
    "pointerdown",
    "mousedown",
    "click",
    "touchstart",
    "keydown",
  ];

  const handleGesture = (event: Event) => {
    onGesture(isGestureInsidePlayer(event), isRateControlGesture(event));
  };

  for (const eventName of gestureEvents) {
    document.addEventListener(eventName, handleGesture, true);
    window.addEventListener(eventName, handleGesture, true);
  }

  // Browser-level history navigation (back/forward, or a bookmarked entry
  // resolved within the SPA) fires `popstate` rather than any of the pointer /
  // key events above. Treat it as a user gesture so it is not mistaken for
  // player-driven autoplay continuation (which uses `pushState` and never
  // emits `popstate`); otherwise a sharer using the browser back/forward
  // controls would auto-share the destination without the manual share step.
  // It is never an in-player play intent.
  window.addEventListener("popstate", () => onGesture(false, false), true);
}
