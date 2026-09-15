import { http, politeEmail } from "../core/http";
import { CITED_CHIP_COLOR } from "../core/types";
import { getString } from "../utils/locale";
import { normalizeAbstractText } from "../core/abstractText";
import {
  identifiersToURL,
  normalizeTitle,
  identifiersConflict,
  refTextToInfo,
  cleanText,
} from "../core/text";
import type { Identifiers, MetaSource, RefItem, RefTag } from "../core/types";
import type { SourceRequestOptions } from "../core/types";
import { authorFamilyName } from "../core/authorNames";

/**
 * Crossref (api.crossref.org) — the official DOI registration agency
 * metadata source. Free, no key required; a `mailto` param buys access to
 * Crossref's "polite pool" (faster, more reliable rate limits).
 */

const BASE = "https://api.crossref.org";

const TYPE_MAP: Record<string, string> = {
  "journal-article": "journalArticle",
  report: "report",
  "posted-content": "preprint",
  "book-chapter": "bookSection",
  "proceedings-article": "conferencePaper",
  book: "book",
};

function withMailto(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}mailto=${encodeURIComponent(politeEmail())}`;
}

/** Map a single `message.reference[]` entry to a RefItem. */
function mapReference(item: any, index: number): RefItem {
  let text: string;
  let textInfo: Partial<RefItem> = {};
  // books/chapters carry their title in volume-title / series-title
  const entryTitle = cleanText(
    item["article-title"] || item["volume-title"] || item["series-title"],
  );
  if (item.unstructured) {
    text = cleanText(item.unstructured);
    textInfo = refTextToInfo(text);
  } else {
    // build a readable citation from Crossref's structured fields instead
    // of dumping raw key/value pairs
    const venue =
      item["journal-title"] ||
      (entryTitle !== item["series-title"] ? item["series-title"] : undefined);
    text = [
      item.author && `${item.author} et al.`,
      item.year,
      entryTitle,
      venue,
      item.volume,
      item["first-page"],
    ]
      .filter(Boolean)
      .join(", ");
    if (!text) {
      text = item.DOI ? `doi:${item.DOI}` : item.key || `[${index + 1}]`;
    }
  }

  let identifiers: Identifiers = textInfo.identifiers || {};
  let url: string | undefined = textInfo.url;
  if (item.DOI) {
    identifiers = { ...identifiers, DOI: item.DOI };
    url = identifiersToURL(identifiers);
  }

  return {
    identifiers,
    title: entryTitle || textInfo.title,
    authors: item.author ? [item.author] : textInfo.authors || [],
    year: item.year != null ? String(item.year) : textInfo.year,
    text: cleanText(text),
    type: TYPE_MAP[item.type] || textInfo.type || "journalArticle",
    url,
    number: index + 1,
  };
}

/** Map a Crossref `message` (work) object to a RefItem. */
function mapWork(w: any): RefItem {
  const doi: string | undefined = w.DOI;
  const identifiers: Identifiers = doi ? { DOI: doi } : {};

  const title = cleanText(Array.isArray(w.title) ? w.title[0] : w.title);
  const authors: string[] = Array.isArray(w.author)
    ? w.author
        .map((a: any) =>
          cleanText(
            a.family ? [a.given, a.family].filter(Boolean).join(" ") : a.name,
          ),
        )
        .filter(Boolean)
    : [];

  const dateParts =
    w.published?.["date-parts"]?.[0] ||
    w.issued?.["date-parts"]?.[0] ||
    w["published-print"]?.["date-parts"]?.[0] ||
    w["published-online"]?.["date-parts"]?.[0];
  const year = dateParts?.[0] !== undefined ? String(dateParts[0]) : undefined;
  const publishDate = dateParts?.length ? dateParts.join("-") : undefined;

  const refCount = w["is-referenced-by-count"];
  const tags: RefTag[] =
    typeof refCount === "number" && refCount > 0
      ? [
          {
            text: refCount,
            color: CITED_CHIP_COLOR,
            tip: getString("tag-cited-tip", { args: { source: "Crossref" } }),
          },
        ]
      : [];

  const references: RefItem[] | undefined = Array.isArray(w.reference)
    ? w.reference.map((r: any, i: number) => mapReference(r, i))
    : undefined;

  return {
    identifiers,
    title,
    authors,
    year,
    type: TYPE_MAP[w.type] || "journalArticle",
    url: w.URL,
    abstract:
      typeof w.abstract === "string"
        ? normalizeAbstractText(w.abstract) || undefined
        : undefined,
    publishDate,
    primaryVenue: cleanText(
      Array.isArray(w["container-title"]) ? w["container-title"][0] : undefined,
    ),
    source: "crossref",
    citationCount: typeof refCount === "number" ? refCount : undefined,
    tags: tags.length ? tags : undefined,
    references,
  };
}

export const crossref: MetaSource & {
  getInfoByDOI(
    doi: string,
    options?: SourceRequestOptions,
  ): Promise<RefItem | null>;
  getInfoByTitle(
    title: string,
    refText?: string,
    options?: SourceRequestOptions,
  ): Promise<RefItem | null>;
  getTitleCandidates(
    title: string,
    options?: SourceRequestOptions,
  ): Promise<RefItem[] | null>;
  getInfoByReference(
    ref: RefItem,
    options?: SourceRequestOptions,
  ): Promise<RefItem | null>;
  getReferences(
    ids: Identifiers,
    title?: string,
    options?: SourceRequestOptions,
  ): Promise<RefItem[] | null>;
} = {
  id: "crossref",

  async getInfoByDOI(
    doi: string,
    options?: SourceRequestOptions,
  ): Promise<RefItem | null> {
    const url = withMailto(`${BASE}/works/${encodeURIComponent(doi)}`);
    const res = await http.getJSON(url, options);
    const message = res?.message;
    if (!message) return null;
    return mapWork(message);
  },

  async getTitleCandidates(
    title: string,
    options?: SourceRequestOptions,
  ): Promise<RefItem[] | null> {
    const url = withMailto(
      `${BASE}/works?query.bibliographic=${encodeURIComponent(title)}&rows=20`,
    );
    const res = await http.getJSON(url, options);
    const items: any[] = res?.message?.items;
    if (!Array.isArray(items)) return null;
    // derivative records (peer reviews, datasets like Faculty Opinions
    // recommendations) often outrank the actual article
    const SKIP_TYPES = new Set(["component", "peer-review", "dataset"]);
    return items.filter((it) => it && !SKIP_TYPES.has(it.type)).map(mapWork);
  },

  async getInfoByReference(
    ref: RefItem,
    options?: SourceRequestOptions,
  ): Promise<RefItem | null> {
    const title = normalizeTitle(ref.title);
    const author = normalizeTitle(authorFamilyName(ref.authors?.[0]));
    const year = String(ref.year || "").match(/^\d{4}$/)?.[0];
    // A bare title is a search query, not sufficient evidence to write a DOI.
    if (title.length < 8 || !author || !year) return null;
    const candidates = await crossref.getTitleCandidates(ref.title!, options);
    if (!candidates) return null;
    const plausible = candidates.filter((candidate) => {
      if (
        normalizeTitle(candidate.title) !== title ||
        identifiersConflict(ref.identifiers, candidate.identifiers)
      )
        return false;
      const candidateAuthor = normalizeTitle(
        authorFamilyName(candidate.authors?.[0]),
      );
      return (
        !(candidate.year && candidate.year !== year) &&
        !(candidateAuthor && candidateAuthor !== author)
      );
    });
    // A same-title record lacking corroboration remains a plausible rival;
    // do not discard it just to manufacture a unique candidate.
    const byDOI = new Map<string, RefItem>();
    for (const candidate of plausible) {
      const doi = candidate.identifiers.DOI?.trim().toLowerCase();
      if (!doi || !/^10\.\d{4,9}\/\S+$/.test(doi)) return null;
      byDOI.set(doi, candidate);
    }
    if (byDOI.size !== 1) return null;
    const selected = [...byDOI.values()][0];
    return selected.year === year &&
      normalizeTitle(authorFamilyName(selected.authors?.[0])) === author
      ? selected
      : null;
  },

  async getInfoByTitle(
    title: string,
    refText?: string,
    options?: SourceRequestOptions,
  ): Promise<RefItem | null> {
    const parsed: Partial<RefItem> = refText ? refTextToInfo(refText) : {};
    return crossref.getInfoByReference(
      { authors: [], ...parsed, title, identifiers: parsed.identifiers || {} },
      options,
    );
  },

  async getReferences(
    ids: Identifiers,
    _title?: string,
    options?: SourceRequestOptions,
  ): Promise<RefItem[] | null> {
    if (!ids.DOI) return null;
    const info = await crossref.getInfoByDOI(ids.DOI, options);
    return info?.references?.length ? info.references : null;
  },
};
