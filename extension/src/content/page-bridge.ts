import {
  readFestivalVideoDetailFromSources,
  type PageInitialState,
  type PagePlayInfo,
  type PlayerInput,
} from "./page-bridge-detail";
import {
  installHistoryNavigationHooks,
  type NavigationHookTarget,
} from "./page-bridge-navigation";

const REQUEST_TYPE = "bili-syncplay:get-festival-video";
const RESPONSE_TYPE = "bili-syncplay:festival-video";

// SPA navigations (clicking a related video, a festival/bangumi autoplay-next)
// update the URL through `history.pushState`/`replaceState` without reloading the
// document, and the isolated content world cannot observe those calls. Hook them
// here in the page world so the content script can suppress a non-shared page's
// load autoplay immediately instead of waiting for the next navigation poll tick.
installHistoryNavigationHooks(window as unknown as NavigationHookTarget);

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== REQUEST_TYPE) {
    return;
  }

  const requestId = event.data.requestId;
  const detail = readFestivalVideoDetail();

  window.postMessage(
    {
      type: RESPONSE_TYPE,
      requestId,
      detail,
    },
    "*",
  );
});

function readFestivalVideoDetail(): {
  epId?: string | number;
  bvid?: string;
  cid?: string | number;
  title?: string;
} | null {
  try {
    const initialState = (
      window as typeof window & {
        __INITIAL_STATE__?: PageInitialState;
        __playinfo__?: PagePlayInfo;
        player?: {
          __getUserParams?: () => {
            input?: PlayerInput;
          };
        };
      }
    ).__INITIAL_STATE__;
    const playInfo = (
      window as typeof window & {
        __playinfo__?: PagePlayInfo;
      }
    ).__playinfo__;

    const active = document.querySelector<HTMLElement>(
      "li[data-cid].bpx-state-active, [data-cid].bpx-state-active, [data-cid].active, [data-cid].selected, [data-ep-id].active, [data-episode-id].active, [data-episodeid].active, [data-epid].active",
    );
    const activeCid = active?.getAttribute("data-cid") ?? null;
    const activeEpId =
      active?.getAttribute("data-ep-id") ??
      active?.getAttribute("data-episode-id") ??
      active?.getAttribute("data-episodeid") ??
      active?.getAttribute("data-epid") ??
      null;
    const activeTitle =
      active?.textContent?.trim() ||
      document
        .querySelector(".bpx-player-top-left-title")
        ?.textContent?.trim() ||
      null;

    const playerInput = (
      window as typeof window & {
        player?: {
          __getUserParams?: () => {
            input?: PlayerInput;
          };
        };
      }
    ).player?.__getUserParams?.()?.input;

    return readFestivalVideoDetailFromSources({
      initialState,
      playInfo,
      playerInput,
      activeCid,
      activeEpId,
      activeTitle,
    });
  } catch {
    return null;
  }
}
