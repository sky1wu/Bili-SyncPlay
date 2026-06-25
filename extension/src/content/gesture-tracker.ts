export function startUserGestureTracking(onGesture: () => void): void {
  const gestureEvents: Array<keyof DocumentEventMap> = [
    "pointerdown",
    "mousedown",
    "click",
    "touchstart",
    "keydown",
  ];

  for (const eventName of gestureEvents) {
    document.addEventListener(eventName, onGesture, true);
    window.addEventListener(eventName, onGesture, true);
  }

  // Browser-level history navigation (back/forward, or a bookmarked entry
  // resolved within the SPA) fires `popstate` rather than any of the pointer /
  // key events above. Treat it as a user gesture so it is not mistaken for
  // player-driven autoplay continuation (which uses `pushState` and never
  // emits `popstate`); otherwise a sharer using the browser back/forward
  // controls would auto-share the destination without the manual share step.
  window.addEventListener("popstate", onGesture, true);
}
