import {
  contradictsAddressBarEpisode,
  readAddressBarEpisodeId,
} from "./video-identity";

/**
 * One thing the page says about the video it is showing: the episode list's
 * highlighted item, a cached page snapshot, an `h1`, the document title. Every
 * field is optional because each source knows a different subset.
 *
 * `title` is the comparison key, not the display string — see
 * {@link titleRecordKey}.
 */
export interface PageVideoRecord {
  episodeId?: string | null;
  cid?: string | null;
  title?: string | null;
}

/**
 * Reduces a title to the form records are compared on. `document.title` arrives
 * decorated (`<episode>_番剧_bilibili`) and is cut at its first `_` to shed the
 * site suffix; that cut lands on titles containing an `_` of their own, so both
 * sides of every comparison must go through it or the derivation launders a
 * stale name past the check — a refuted `OVA_1` has to refute the `OVA` derived
 * from `OVA_1_番剧_bilibili` (#274).
 *
 * That the cut also truncates a genuine `OVA_1` down to `OVA` is older than this
 * function and applies to the current episode's title just the same; it is a
 * display-quality question, not an episode-identity one.
 */
export function titleRecordKey(title: string): string {
  return title.split("_")[0]?.trim() || title.trim();
}

/**
 * Marks each record that is proven to describe an episode this page has already
 * left — on `/bangumi/play/epNNN`, the previous one (#274).
 *
 * Every source of in-player identity is a page global, and an SPA episode switch
 * updates the address bar before it updates any of them. So the proof runs in
 * one direction only: a record naming an episode other than the address bar's is
 * stale, never the reverse. Two rules do the rest:
 *
 * - **Staleness propagates through records that describe the same thing.** A
 *   shared episode id, cid, or title key links two records; a snapshot carrying
 *   no episode id of its own inherits staleness from the list item it shares a
 *   cid with, and an `h1` inherits it from whatever record already carries its
 *   title. Fixing only the record that carried the proof leaves the others to
 *   rebuild the hybrid answer — the new episode's id wearing the old episode's
 *   name — which is how this defect kept coming back one source at a time.
 * - **Direct confirmation outranks propagation.** A record naming exactly the
 *   address bar's episode is never marked, whatever it links to. Inconsistent
 *   page data must not let a link overrule the one source that cannot be stale.
 *
 * Returns a mask parallel to `records`. Routes whose address bar names no
 * episode — `/festival/`, `/bangumi/play/ssNNN` — have nothing to prove anything
 * against, so nothing is ever marked there.
 */
export function markStalePageRecords(args: {
  pathname: string;
  records: readonly (PageVideoRecord | null)[];
}): boolean[] {
  const stale = args.records.map(
    (record) =>
      record !== null &&
      contradictsAddressBarEpisode({
        pathname: args.pathname,
        episodeId: record.episodeId,
      }),
  );

  const addressBarEpisodeId = readAddressBarEpisodeId(args.pathname);
  if (addressBarEpisodeId === null) {
    return stale;
  }
  const confirmed = args.records.map(
    (record) =>
      record?.episodeId?.toLowerCase() === addressBarEpisodeId &&
      record?.episodeId != null,
  );

  // At most a handful of records, so a fixpoint sweep is cheaper to read than a
  // union-find and cannot miss a chain the way a single pass can.
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < args.records.length; i += 1) {
      if (!stale[i]) {
        continue;
      }
      for (let j = 0; j < args.records.length; j += 1) {
        if (stale[j] || confirmed[j]) {
          continue;
        }
        if (describeSameRecord(args.records[i], args.records[j])) {
          stale[j] = true;
          changed = true;
        }
      }
    }
  }

  return stale;
}

function describeSameRecord(
  left: PageVideoRecord | null | undefined,
  right: PageVideoRecord | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  return (
    sharesValue(left.episodeId, right.episodeId, (value) =>
      value.toLowerCase(),
    ) ||
    sharesValue(left.cid, right.cid, (value) => value) ||
    sharesValue(left.title, right.title, titleRecordKey)
  );
}

function sharesValue(
  left: string | null | undefined,
  right: string | null | undefined,
  normalize: (value: string) => string,
): boolean {
  if (!left || !right) {
    return false;
  }
  const normalizedLeft = normalize(left);
  return Boolean(normalizedLeft) && normalizedLeft === normalize(right);
}
