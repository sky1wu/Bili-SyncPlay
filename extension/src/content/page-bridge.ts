const REQUEST_TYPE = "bili-syncplay:get-festival-video";
const RESPONSE_TYPE = "bili-syncplay:festival-video";

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
      detail
    },
    "*"
  );
});

function readFestivalVideoDetail(): { bvid?: string; cid?: string | number; title?: string } | null {
  try {
    const initialState = (window as typeof window & {
      __INITIAL_STATE__?: {
        sectionEpisodes?: Array<{
          bvid?: string;
          cid?: string | number;
          title?: string;
        }>;
        videoInfo?: {
          bvid?: string;
          cid?: string | number;
          title?: string;
        };
      };
      player?: {
        __getUserParams?: () => {
          input?: {
            bvid?: string;
            cid?: string | number;
            aid?: string | number;
          };
        };
      };
    }).__INITIAL_STATE__;

    const active = document.querySelector<HTMLElement>(
      "li[data-cid].bpx-state-active, [data-cid].bpx-state-active, [data-cid].active, [data-cid].selected"
    );
    const activeCid = active?.getAttribute("data-cid") ?? null;
    const activeTitle =
      active?.textContent?.trim() ||
      document.querySelector(".bpx-player-top-left-title")?.textContent?.trim() ||
      null;

    const sectionEpisodes = Array.isArray(initialState?.sectionEpisodes) ? initialState.sectionEpisodes : [];
    const matchedByCid = activeCid ? sectionEpisodes.find((episode) => String(episode?.cid ?? "") === activeCid) : null;
    const matchedByTitle =
      !matchedByCid && activeTitle
        ? sectionEpisodes.find((episode) => (episode?.title || "").trim() === activeTitle)
        : null;

    const playerInput = (window as typeof window & {
      player?: {
        __getUserParams?: () => {
          input?: {
            bvid?: string;
            cid?: string | number;
          };
        };
      };
    }).player?.__getUserParams?.()?.input;

    const matched = matchedByCid ?? matchedByTitle ?? playerInput ?? initialState?.videoInfo ?? null;
    if (!matched?.bvid || matched.cid === undefined) {
      return null;
    }

    return {
      bvid: matched.bvid,
      cid: matched.cid,
      title: matched.title || activeTitle || initialState?.videoInfo?.title
    };
  } catch {
    return null;
  }
}
