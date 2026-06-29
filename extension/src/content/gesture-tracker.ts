// Selectors for the Bilibili video player container across page types (normal
// video, bangumi, festival). A pointer gesture is treated as a play intent only
// when it lands inside one of these.
const PLAYER_CONTAINER_SELECTOR = ".bpx-player-container, #bilibili-player";

// Editable targets (the danmaku / comment input) are never a play intent, even
// when nested inside the player container.
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

// Keys that toggle playback on Bilibili. A keydown only counts as an in-player
// play intent for these (so Esc/Tab/typing do not authorize playback).
const PLAY_TOGGLE_KEYS = new Set([" ", "Spacebar", "k", "K"]);

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
  if (target.closest(EDITABLE_SELECTOR)) {
    return false;
  }
  if (event.type === "keydown") {
    return PLAY_TOGGLE_KEYS.has((event as KeyboardEvent).key);
  }
  return target.closest(PLAYER_CONTAINER_SELECTOR) !== null;
}

export function startUserGestureTracking(
  onGesture: (insidePlayer: boolean) => void,
): void {
  const gestureEvents: Array<keyof DocumentEventMap> = [
    "pointerdown",
    "mousedown",
    "click",
    "touchstart",
    "keydown",
  ];

  const handleGesture = (event: Event) => {
    onGesture(isGestureInsidePlayer(event));
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
  window.addEventListener("popstate", () => onGesture(false), true);
}
