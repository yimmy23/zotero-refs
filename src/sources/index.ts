import { hostIdentifiers, isChinese, normalizeTitle } from "../core/text";
import type {
  Identifiers,
  MetaSource,
  PagedRefs,
  RefItem,
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
  if (isChinese(refText || title)) {
    return {
      according: "Title",
      thunks: [
        () => cnki.getInfoByTitle!(title, refText),
        () => readpaper.getInfoByTitle!(title, refText),
      ],
    };
  }
  return {
    according: "Title",
    thunks: [
      () => crossref.getInfoByTitle!(title, refText),
      // PubMed by [Title]: only answers for MEDLINE-indexed papers, but
      // when it does its abstract coverage beats every other source
      () => pubmed.getInfoByTitle(title),
      () => openalex.getInfoByTitle!(title, refText),
      () => semanticscholar.getInfoByTitle!(title, refText),
      () => readpaper.getInfoByTitle!(title, refText),
      () => connectedpapers.getInfoByTitle!(title, refText),
    ],
  };
}

/**
 * Reference list of an item through web APIs.
 * Fallback chain: Crossref -> Semantic Scholar -> OpenAlex -> CNKI (Chinese).
 * Returns the source id used along with the references.
 */
export async function getReferencesByAPI(
  item: Zotero.Item,
  onStatus?: (msg: string) => void,
): Promise<{ refs: RefItem[]; source: string } | null> {
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
      onStatus?.(`Requesting ${src.id} references…`);
      try {
        const refs = await src.getReferences?.(ids, title);
        if (refs?.length) return { refs, source: src.id };
      } catch (e) {
        ztoolkit.log(`[sources] ${src.id} references failed`, e);
      }
    }
  }
  if (isChinese(title) || ids.CNKI) {
    onStatus?.("Requesting CNKI references…");
    try {
      const refs = await cnki.getReferences?.(ids, title);
      if (refs?.length) return { refs, source: cnki.id };
    } catch (e) {
      ztoolkit.log("[sources] cnki references failed", e);
    }
  }
  // last try: resolve DOI by title then crossref/s2
  if (!ids.DOI && title && !isChinese(title)) {
    const doi = await resolveDOIByTitle(title);
    if (doi) {
      for (const src of [crossref, semanticscholar, openalex]) {
        try {
          const refs = await src.getReferences?.({ DOI: doi }, title);
          if (refs?.length) return { refs, source: src.id };
        } catch {
          // try the next source
        }
      }
    }
  }
  return null;
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
): Promise<(PagedRefs & { source: CitationSource }) | null> {
  let empty: (PagedRefs & { source: CitationSource }) | null = null;
  if (only !== "openalex") {
    try {
      const res = await semanticscholar.getCitations?.(ids, offset, limit);
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
    const res = await openalex.getCitations?.(ids, offset, limit);
    if (res?.items.length) return { ...res, source: "openalex" };
    // OpenAlex reports the real total (meta.count), S2 does not — prefer
    // its empty answer so the section can show a definitive 0
    if (res) empty = { ...res, source: "openalex" };
  } catch (e) {
    ztoolkit.log("[sources] openalex citations failed", e);
  }
  return empty;
}

/** recommended / related works; S2 recommendations first */
export async function getRelatedByAPI(
  ids: Identifiers,
  limit = 20,
): Promise<RefItem[] | null> {
  try {
    const res = await semanticscholar.getRelated?.(ids, limit);
    if (res?.length) return res;
  } catch (e) {
    ztoolkit.log("[sources] s2 related failed", e);
  }
  try {
    const res = await openalex.getRelated?.(ids, limit);
    if (res?.length) return res;
  } catch (e) {
    ztoolkit.log("[sources] openalex related failed", e);
  }
  return null;
}

/**
 * Strict title equality (normalized). Substring containment is NOT
 * accepted: Crossref happily ranks derivative records ("Review of X",
 * "Faculty Opinions recommendation of X") above the article, and a
 * containment rule would resolve the WRONG DOI for them (live-verified
 * with "Array programming with NumPy").
 */
function titleSimilar(a?: string, b?: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // a candidate that still equals the query after removing a derivative
  // prefix is the derivative record, not the paper — reject it
  return false;
}

/**
 * Resolve a DOI from a title with validation, so we never import the
 * wrong paper. Crossref bibliographic query -> OpenAlex -> S2.
 */
export async function resolveDOIByTitle(title: string): Promise<string | null> {
  if (!title || title.length < 8) return null;
  try {
    const hit = await crossref.getInfoByTitle?.(title);
    if (hit?.identifiers.DOI && titleSimilar(hit.title, title)) {
      return hit.identifiers.DOI;
    }
  } catch {
    // fall through to the next resolver
  }
  try {
    const hit = await openalex.getInfoByTitle?.(title);
    if (hit?.identifiers.DOI && titleSimilar(hit.title, title)) {
      return hit.identifiers.DOI;
    }
  } catch {
    // fall through to the next resolver
  }
  try {
    const hit = await semanticscholar.getInfoByTitle?.(title);
    if (hit?.identifiers.DOI && titleSimilar(hit.title, title)) {
      return hit.identifiers.DOI;
    }
  } catch {
    // fall through to the next resolver
  }
  return null;
}
