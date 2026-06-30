export const NAVIGATION_MESSAGE_TYPE = "bili-syncplay:navigation";

/**
 * The subset of `window` the navigation hooks touch. Parameterised so the install
 * logic can be unit-tested against a stub without a real DOM, and so the page
 * bridge can pass the genuine `window` at injection time.
 */
export interface NavigationHookTarget {
  history: History;
  postMessage: (message: unknown, targetOrigin: string) => void;
  addEventListener: (type: string, listener: () => void) => void;
  __biliSyncplayNavHooked__?: boolean;
}

/**
 * Wraps `history.pushState`/`replaceState` and listens for `popstate` so an SPA
 * navigation in the page world posts a `bili-syncplay:navigation` signal the
 * isolated content world can observe. Idempotent: a second call (e.g. a duplicate
 * bridge injection) returns without re-wrapping, so a navigation never posts more
 * than one signal.
 */
export function installHistoryNavigationHooks(
  target: NavigationHookTarget,
): void {
  if (target.__biliSyncplayNavHooked__) {
    return;
  }
  target.__biliSyncplayNavHooked__ = true;

  const emit = (): void => {
    try {
      target.postMessage({ type: NAVIGATION_MESSAGE_TYPE }, "*");
    } catch {
      // postMessage can throw in rare cross-origin frame teardown; ignore.
    }
  };

  const originalPushState = target.history.pushState.bind(target.history);
  target.history.pushState = function (
    ...args: Parameters<History["pushState"]>
  ): void {
    originalPushState(...args);
    emit();
  };

  const originalReplaceState = target.history.replaceState.bind(target.history);
  target.history.replaceState = function (
    ...args: Parameters<History["replaceState"]>
  ): void {
    originalReplaceState(...args);
    emit();
  };

  target.addEventListener("popstate", emit);
}
