import { hostIdentifiers, isChinese, titlesMatch } from "../core/text";
import { SOURCE_NAME } from "../core/types";
import {
  RELATED_SOURCES,
  fuseRelated,
  relatedLimit,
  snapshotRelatedRefs,
} from "../core/related";
import type { RelatedResult, RelatedSnapshot } from "../core/related";
import { getString } from "../utils/locale";
import type {
  Identifiers,
  MetaSource,
  PagedRefs,
  RefItem,
  SourceRequestOptions,
  ReferenceResult,
} from "../core/types";
import { arxiv } from "./arxiv";
import { cnki } from "./cnki";
import { connectedpapers } from "./connectedpapers";
import { crossref } from "./crossref";
import { openalex } from "./openalex";
import { pubmed } from "./pubmed";
import { readpaper } from "./readpaper";
import { semanticscholar } from "./semanticscholar";
import { unpaywall } from "./unpaywall";

export const sources = {
  crossref,
  semanticscholar,
  openalex,
  arxiv,
  pubmed,
  unpaywall,
  cnki,
  readpaper,
  connectedpapers,
} satisfies Record<string, MetaSource>;

export type According = "arXiv" | "DOI" | "PMID" | "Title";

/**
 * Remote metadata candidates for the hover popup, ordered. The caller
 * prepends its own "local info" candidate at index 0.
 */
export function infoCandidates(ref: RefItem): {
  according: According;
  thunks: Array<() => Promise<RefItem | null>>;
} {
  const ids = ref.identifiers;
  if (ids.arXiv) {
    const arXiv = ids.arXiv;
    return {
      according: "arXiv",
      thunks: [
        () => arxiv.getInfoByArXiv!(arXiv),
        () => semanticscholar.getInfoByArXiv!(arXiv),
      ],
    };
  }
  if (ids.DOI) {
    const DOI = ids.DOI;
    return {
      according: "DOI",
      thunks: [
        ...(ids.PMID ? [() => pubmed.getInfoByPMID(ids.PMID!)] : []),
        () => semanticscholar.getInfoByDOI!(DOI),
        () => crossref.getInfoByDOI!(DOI),
        () => openalex.getInfoByDOI!(DOI),
        () => unpaywall.getInfoByDOI!(DOI),
        () => readpaper.getInfoByTitleWithDOI(ref.title || ref.text || "", DOI),
      ],
    };
  }
  if (ids.PMID) {
    const PMID = ids.PMID;
    return {
      according: "PMID",
      thunks: [
        () => pubmed.getInfoByPMID!(PMID),
        () => semanticscholar.getInfoByPMID!(PMID),
        () => openalex.getInfoByPMID!(PMID),
      ],
    };
  }
  const title = ref.title || ref.text || "";
  const refText = ref.text;
  const exact = (lookup: () => Promise<RefItem | null>) => async () => {
    const info = await lookup();
    return info && titlesMatch(info.title, title) ? info : null;
  };
  if (isChinese(refText || title)) {
    return {
      according: "Title",
      thunks: [
        exact(() => cnki.getInfoByTitle!(title, refText)),
        exact(() => readpaper.getInfoByTitle!(title, refText)),
      ],
    };
  }
  return {
    according: "Title",
    thunks: [
      exact(() => crossref.getInfoByTitle!(title, refText)),
      // PubMed by [Title]: only answers for MEDLINE-indexed papers, but
      // when it does its abstract coverage beats every other source
      exact(() => pubmed.getInfoByTitle(title)),
      exact(() => openalex.getInfoByTitle!(title, refText)),
      exact(() => semanticscholar.getInfoByTitle!(title, refText)),
      exact(() => readpaper.getInfoByTitle!(title, refText)),
      exact(() => connectedpapers.getInfoByTitle!(title, refText)),
    ],
  };
}

/**
 * Reference list of an item through web APIs.
 * Fallback chain: Crossref -> Semantic Scholar -> OpenAlex -> CNKI (Chinese).
 * Returns the source id used along with the references.
 */
export type ReferenceAPIResult = Omit<ReferenceResult, "items"> & {
  refs: RefItem[];
  source: string;
};

export async function getReferencesByAPI(
  item: Zotero.Item,
  onStatus?: (msg: string) => void,
  options: SourceRequestOptions = {},
): Promise<ReferenceAPIResult | null> {
  options = { ...options, deadline: options.deadline ?? Date.now() + 30000 };
  let incomplete: ReferenceAPIResult | null = null;
  const lookup = async (src: MetaSource, ids: Identifiers, title: string) => {
    if (src.getReferencesResult) {
      const { items, ...state } = await src.getReferencesResult(
        ids,
        title,
        options,
      );
      const result = { ...state, refs: items, source: src.id };
      if (state.status === "ok" && items.length) return result;
      if (state.status === "partial" || (!incomplete && state.error))
        incomplete = result;
      return null;
    }
    const refs = await src.getReferences?.(ids, title, options);
    return refs?.length
      ? { refs, source: src.id, status: "ok" as const }
      : null;
  };
  const title = (item.getField("title") as string) || "";
  const url = (item.getField("url") as string) || "";
  const ids: Identifiers = hostIdentifiers(item);
  if (/cnki/i.test(url)) ids.CNKI = url;

  if (ids.DOI || ids.PMID || ids.arXiv) {
    // Crossref only knows DOIs; S2 / OpenAlex resolve PMID and arXiv too
    const chain = ids.DOI
      ? [crossref, semanticscholar, openalex]
      : [semanticscholar, openalex];
    for (const src of chain) {
      onStatus?.(
        getString("panel-requesting-source", {
          args: { source: SOURCE_NAME[src.id] || src.id },
        }),
      );
      try {
        const result = await lookup(src, ids, title);
        if (result) return result;
      } catch (e) {
        ztoolkit.log(`[sources] ${src.id} references failed`, e);
      }
    }
  }
  if (isChinese(title) || ids.CNKI) {
    onStatus?.(
      getString("panel-requesting-source", { args: { source: "CNKI" } }),
    );
    try {
      const result = await lookup(cnki, ids, title);
      if (result) return result;
    } catch (e) {
      ztoolkit.log("[sources] cnki references failed", e);
    }
  }
  // last try: resolve DOI by title then crossref/s2
  if (!ids.DOI && title && !isChinese(title)) {
    const authors = item
      .getCreatorsJSON()
      .filter((creator) => creator.creatorType === "author")
      .map(
        (creator) =>
          creator.name ||
          [creator.firstName, creator.lastName].filter(Boolean).join(" "),
      );
    const doi = await resolveDOIByTitle(
      {
        identifiers: ids,
        title,
        authors,
        year: String(item.getField("date") || "").match(/\b\d{4}\b/)?.[0],
      },
      options,
    );
    if (doi) {
      for (const src of [crossref, semanticscholar, openalex]) {
        try {
          const result = await lookup(src, { DOI: doi }, title);
          if (result) return result;
        } catch {
          // try the next source
        }
      }
    }
  }
  return incomplete;
}

export type CitationSource = "semanticscholar" | "openalex";

/**
 * Works citing this work; S2 first (rich paging), OpenAlex fallback.
 * Pass `only` to pin one source: mixing sources across pages would
 * interleave two differently-ordered lists and show duplicates.
 *
 * null means "nobody could answer" — the caller shows a warning and keeps
 * the retry button. A source that ANSWERED with an empty list is not that:
 * a paper published last week has no citations yet, and reporting it as a
 * failure marks a correct "0" with a warning and an endless "load more".
 * So an answered-but-empty page is kept and returned when no source has
 * anything better.
 */
export async function getCitationsByAPI(
  ids: Identifiers,
  offset = 0,
  limit = 25,
  only?: CitationSource,
  options: SourceRequestOptions = {},
): Promise<(PagedRefs & { source: CitationSource }) | null> {
  options = { ...options, deadline: options.deadline ?? Date.now() + 30000 };
  let empty: (PagedRefs & { source: CitationSource }) | null = null;
  if (only !== "openalex") {
    try {
      const res = await semanticscholar.getCitations?.(
        ids,
        offset,
        limit,
        options,
      );
      if (res?.items.length || only === "semanticscholar") {
        return res ? { ...res, source: "semanticscholar" } : null;
      }
      if (res) empty = { ...res, source: "semanticscholar" };
    } catch (e) {
      ztoolkit.log("[sources] s2 citations failed", e);
      if (only === "semanticscholar") return null;
    }
  }
  try {
    const res = await openalex.getCitations?.(ids, offset, limit, options);
    if (res?.items.length) return { ...res, source: "openalex" };
    // OpenAlex reports the real total (meta.count), S2 does not — prefer
    // its empty answer so the section can show a definitive 0
    if (res) empty = { ...res, source: "openalex" };
  } catch (e) {
    ztoolkit.log("[sources] openalex citations failed", e);
  }
  return empty;
}

/** Independent recommendation lists, fused by original rank (not citations). */
export async function getRelatedByAPI(
  ids: Identifiers,
  limit = 40,
  onProgress?: (result: RelatedResult) => void,
  shouldContinue: () => boolean = () => true,
  options: SourceRequestOptions = {},
): Promise<RelatedResult> {
  options = { ...options, deadline: options.deadline ?? Date.now() + 30000 };
  const bounded = relatedLimit(limit);
  const query = { ...ids };
  const snapshots: RelatedSnapshot[] = RELATED_SOURCES.map((source) => ({
    source,
    status: "loading",
    items: [],
  }));
  const publish = () => {
    if (!shouldContinue()) return;
    try {
      onProgress?.(fuseRelated(snapshots, bounded));
    } catch (error) {
      ztoolkit.log("[sources] related progress failed", error);
    }
  };
  publish();
  await Promise.all(
    RELATED_SOURCES.map(async (source, index) => {
      if (!shouldContinue()) return;
      let refs: RefItem[] | null = null;
      try {
        refs =
          source === "openalex"
            ? await openalex.getRelated(query, bounded, shouldContinue, options)
            : ((await semanticscholar.getRelated?.(query, bounded, options)) ??
              null);
      } catch (error) {
        if (shouldContinue())
          ztoolkit.log(`[sources] ${source} related failed`, error);
      }
      // Cancelled work remains incomplete, never masquerades as a successful 0.
      if (!shouldContinue()) return;
      snapshots[index] = {
        source,
        status: refs === null ? "unavailable" : "ready",
        items: refs === null ? [] : snapshotRelatedRefs(refs, bounded),
      };
      publish();
    }),
  );
  return fuseRelated(snapshots, bounded);
}

/**
 * Verify a title query against a bounded Crossref candidate set. Title, first
 * author and publication year must agree, with one plausible DOI. Crossref's
 * total-results counts broad ranked hits, not exact-title identities; this is
 * verification within the returned candidates, not proof of global uniqueness.
 * Providers exposing only one selected hit cannot establish candidate identity.
 */
export async function resolveDOIByTitle(
  ref: string | RefItem,
  options?: SourceRequestOptions,
): Promise<string | null> {
  if (typeof ref === "string") return null;
  try {
    const hit = await crossref.getInfoByReference(ref, options);
    return hit?.identifiers.DOI || null;
  } catch {
    return null;
  }
}
