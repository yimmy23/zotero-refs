import { http, politeEmail } from "../core/http";
import {
  htmlToText,
  identifiersToURL,
  normalizeTitle,
  refTextToInfo,
} from "../core/text";
import type { Identifiers, MetaSource, RefItem, RefTag } from "../core/types";

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
  const entryTitle =
    item["article-title"] || item["volume-title"] || item["series-title"];
  if (item.unstructured) {
    text = item.unstructured;
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
    year: item.year || textInfo.year,
    text,
    type: TYPE_MAP[item.type] || textInfo.type || "journalArticle",
    url,
    number: index + 1,
  };
}

/** Map a Crossref `message` (work) object to a RefItem. */
function mapWork(w: any): RefItem {
  const doi: string | undefined = w.DOI;
  const identifiers: Identifiers = doi ? { DOI: doi } : {};

  const title = Array.isArray(w.title) ? w.title[0] : w.title;
  const authors: string[] = Array.isArray(w.author)
    ? w.author.map((a: any) => a.family || a.name).filter(Boolean)
    : [];

  const dateParts =
    w.published?.["date-parts"]?.[0] || w.created?.["date-parts"]?.[0];
  const year = dateParts?.[0] !== undefined ? String(dateParts[0]) : undefined;
  const publishDate = dateParts?.length ? dateParts.join("-") : undefined;

  const refCount = w["is-referenced-by-count"];
  const tags: RefTag[] =
    typeof refCount === "number" && refCount > 0
      ? [{ text: refCount, color: "#2fb8cb", tip: "is-referenced-by-count" }]
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
    abstract: w.abstract ? htmlToText(w.abstract) : undefined,
    publishDate,
    primaryVenue: Array.isArray(w["container-title"])
      ? w["container-title"][0]
      : undefined,
    source: "crossref",
    citationCount: typeof refCount === "number" ? refCount : undefined,
    tags: tags.length ? tags : undefined,
    references,
  };
}

export const crossref: MetaSource & {
  getInfoByDOI(doi: string): Promise<RefItem | null>;
  getInfoByTitle(title: string, refText?: string): Promise<RefItem | null>;
  getReferences(ids: Identifiers): Promise<RefItem[] | null>;
} = {
  id: "crossref",

  async getInfoByDOI(doi: string): Promise<RefItem | null> {
    const url = withMailto(`${BASE}/works/${encodeURIComponent(doi)}`);
    const res = await http.getJSON(url);
    const message = res?.message;
    if (!message) return null;
    return mapWork(message);
  },

  async getInfoByTitle(title: string): Promise<RefItem | null> {
    const url = withMailto(
      `${BASE}/works?query.bibliographic=${encodeURIComponent(title)}&rows=5`,
    );
    const res = await http.getJSON(url);
    const items: any[] = res?.message?.items;
    if (!Array.isArray(items) || !items.length) return null;
    // derivative records (peer reviews, datasets like Faculty Opinions
    // recommendations) often outrank the actual article
    const SKIP_TYPES = new Set(["component", "peer-review", "dataset"]);
    const candidates = items.filter((it) => !SKIP_TYPES.has(it.type));
    if (!candidates.length) return null;
    const want = normalizeTitle(title);
    const exact = candidates.find(
      (it) => normalizeTitle(it.title?.[0]) === want,
    );
    return mapWork(exact || candidates[0]);
  },

  async getReferences(ids: Identifiers): Promise<RefItem[] | null> {
    if (!ids.DOI) return null;
    const info = await crossref.getInfoByDOI(ids.DOI);
    return info?.references?.length ? info.references : null;
  },
};
