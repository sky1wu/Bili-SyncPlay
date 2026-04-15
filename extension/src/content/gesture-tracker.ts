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
}
