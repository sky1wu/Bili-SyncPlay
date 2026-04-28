export interface PageVideoCandidate {
  id?: string | number;
  ep_id?: string | number;
  epId?: string | number;
  bvid?: string;
  cid?: string | number;
  title?: string;
  long_title?: string;
}

export interface PageInitialState {
  epInfo?: PageVideoCandidate;
  sectionEpisodes?: PageVideoCandidate[];
  episodes?: PageVideoCandidate[];
  epList?: PageVideoCandidate[];
  videoInfo?: {
    bvid?: string;
    cid?: string | number;
    title?: string;
  };
}

export interface PlayerInput {
  bvid?: string;
  cid?: string | number;
  aid?: string | number;
}

export function readFestivalVideoDetailFromSources(args: {
  initialState?: PageInitialState;
  playerInput?: PlayerInput;
  activeCid?: string | null;
  activeEpId?: string | null;
  activeTitle?: string | null;
}): {
  epId?: string | number;
  bvid?: string;
  cid?: string | number;
  title?: string;
} | null {
  const {
    initialState,
    playerInput,
    activeCid = null,
    activeEpId = null,
    activeTitle = null,
  } = args;

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
      ? (matched.epId ?? matched.ep_id ?? matched.id ?? activeEpId ?? undefined)
      : undefined;
  const cid =
    typeof matched === "object" && matched !== null
      ? (matched.cid ?? activeCid ?? undefined)
      : undefined;

  if (!epId && (!matched?.bvid || cid === undefined)) {
    return null;
  }

  return {
    epId,
    bvid: matched.bvid,
    cid,
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
}
