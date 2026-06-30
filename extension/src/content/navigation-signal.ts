const NAVIGATION_MESSAGE_TYPE = "bili-syncplay:navigation";

/**
 * Subscribes to the SPA navigation signal the page-world bridge posts when the
 * host page calls `history.pushState`/`replaceState` or fires `popstate`. The
 * content script (isolated world) cannot observe those history mutations
 * directly, so this `window.postMessage` relay is how it learns of an in-page
 * navigation in time to suppress a non-shared page's load autoplay.
 *
 * Returns an unsubscribe function so the listener is removed on teardown.
 */
export function startNavigationSignalListener(
  onNavigate: () => void,
): () => void {
  const handler = (event: MessageEvent): void => {
    // Only trust messages this same window posted to itself (the bridge relay);
    // ignore cross-frame / cross-origin chatter.
    if (event.source !== window) {
      return;
    }
    const data = event.data as { type?: unknown } | null;
    if (data?.type !== NAVIGATION_MESSAGE_TYPE) {
      return;
    }
    onNavigate();
  };
  window.addEventListener("message", handler);
  return () => {
    window.removeEventListener("message", handler);
  };
}
