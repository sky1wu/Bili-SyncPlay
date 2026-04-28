const REQUEST_TYPE = "bili-syncplay:get-festival-video";
const RESPONSE_TYPE = "bili-syncplay:festival-video";

interface PageVideoCandidate {
  id?: string | number;
  ep_id?: string | number;
  epId?: string | number;
  bvid?: string;
  cid?: string | number;
  title?: string;
  long_title?: string;
}

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
        __INITIAL_STATE__?: {
          epInfo?: PageVideoCandidate;
          sectionEpisodes?: PageVideoCandidate[];
          episodes?: PageVideoCandidate[];
          epList?: PageVideoCandidate[];
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
      }
    ).__INITIAL_STATE__;

    const active = document.querySelector<HTMLElement>(
      "li[data-cid].bpx-state-active, [data-cid].bpx-state-active, [data-cid].active, [data-cid].selected, [data-ep-id].active, [data-episode-id].active, [data-epid].active",
    );
    const activeCid = active?.getAttribute("data-cid") ?? null;
    const activeEpId =
      active?.getAttribute("data-ep-id") ??
      active?.getAttribute("data-episode-id") ??
      active?.getAttribute("data-epid") ??
      null;
    const activeTitle =
      active?.textContent?.trim() ||
      document
        .querySelector(".bpx-player-top-left-title")
        ?.textContent?.trim() ||
      null;

    const episodes = [
      ...(Array.isArray(initialState?.sectionEpisodes)
        ? initialState.sectionEpisodes
        : []),
      ...(Array.isArray(initialState?.episodes) ? initialState.episodes : []),
      ...(Array.isArray(initialState?.epList) ? initialState.epList : []),
    ];
    const matchedByEpId = activeEpId
      ? episodes.find(
          (episode) =>
            String(episode?.id ?? "") === activeEpId ||
            String(episode?.ep_id ?? "") === activeEpId ||
            String(episode?.epId ?? "") === activeEpId,
        )
      : null;
    const matchedByCid = activeCid
      ? episodes.find((episode) => String(episode?.cid ?? "") === activeCid)
      : null;
    const matchedByTitle =
      !matchedByEpId && !matchedByCid && activeTitle
        ? episodes.find(
            (episode) =>
              (episode?.title || "").trim() === activeTitle ||
              (episode?.long_title || "").trim() === activeTitle,
          )
        : null;

    const playerInput = (
      window as typeof window & {
        player?: {
          __getUserParams?: () => {
            input?: {
              bvid?: string;
              cid?: string | number;
            };
          };
        };
      }
    ).player?.__getUserParams?.()?.input;

    const matched: PageVideoCandidate | null =
      matchedByEpId ??
      matchedByCid ??
      matchedByTitle ??
      initialState?.epInfo ??
      playerInput ??
      initialState?.videoInfo ??
      null;
    const epId =
      typeof matched === "object" && matched !== null
        ? (matched.epId ?? matched.ep_id ?? matched.id)
        : undefined;

    if (!epId && (!matched?.bvid || matched.cid === undefined)) {
      return null;
    }

    return {
      epId,
      bvid: matched.bvid,
      cid: matched.cid,
      title:
        (typeof matched === "object" &&
        matched !== null &&
        "title" in matched &&
        typeof matched.title === "string"
          ? matched.title
          : undefined) ||
        (typeof matched === "object" &&
        matched !== null &&
        "long_title" in matched &&
        typeof matched.long_title === "string"
          ? matched.long_title
          : undefined) ||
        activeTitle ||
        initialState?.epInfo?.title ||
        initialState?.epInfo?.long_title ||
        initialState?.videoInfo?.title,
    };
  } catch {
    return null;
  }
}
