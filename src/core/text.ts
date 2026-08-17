import type { Identifiers, RefItem } from "./types";

/**
 * Text analysis helpers: identifier extraction, raw reference-string parsing,
 * language detection, normalization. Pure functions, no Zotero UI access
 * except DOMParser via ztoolkit.
 */

export const REGEX = {
  DOI: /10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>]+[^.\]\s]/,
  arXiv: /arXiv[.:](\d{4}\.\d{4,5}(?:v\d+)?)/i,
  arXivOld: /arXiv[.:]([a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i,
  PMID: /PMID[:\s]*(\d{6,9})/i,
  URL: /https?:\/\/[^\s]+[^\s.,;)\]]/,
};

export function extractIdentifiers(text: string): Identifiers {
  const identifiers: Identifiers = {};
  const compact = text.replace(/\s+/g, "");
  const doi = compact.match(REGEX.DOI);
  if (doi) {
    // strip trailing punctuation that regex may swallow
    identifiers.DOI = doi[0].replace(/[.,;]+$/, "");
  }
  const arxiv = compact.match(REGEX.arXiv) || compact.match(REGEX.arXivOld);
  if (arxiv) {
    identifiers.arXiv = arxiv[1];
  }
  const pmid = text.match(REGEX.PMID);
  if (pmid) {
    identifiers.PMID = pmid[1];
  }
  return identifiers;
}

/**
 * Identifiers of a library item as the sources need them: DOI from the
 * field or Extra, PMID / arXiv from Extra or URL. Shared by every section
 * so a PubMed-imported item without a DOI field still gets references,
 * related works and a graph via PMID lookups.
 */
export function hostIdentifiers(item: Zotero.Item): Identifiers {
  const ids: Identifiers = {};
  const extra = (item.getField("extra") as string) || "";
  const url = (item.getField("url") as string) || "";
  let doi = ((item.getField("DOI") as string) || "").trim();
  if (!doi) doi = extra.match(/^DOI:\s*(10\.\S+)/im)?.[1] || "";
  if (doi) ids.DOI = doi;
  const arxiv =
    url.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?$/i)?.[1] ||
    extra.match(REGEX.arXiv)?.[1];
  if (arxiv) ids.arXiv = arxiv;
  const pmid =
    extra.match(/^PMID:\s*(\d+)/im)?.[1] ||
    url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/)?.[1];
  if (pmid) ids.PMID = pmid;
  return ids;
}

export function extractURL(text: string): string | undefined {
  const res = text.match(REGEX.URL);
  return res ? res[0] : undefined;
}

export function identifiersToURL(identifiers: Identifiers): string | undefined {
  if (identifiers.DOI) return `https://doi.org/${identifiers.DOI}`;
  if (identifiers.arXiv) return `https://arxiv.org/abs/${identifiers.arXiv}`;
  if (identifiers.PMID)
    return `https://pubmed.ncbi.nlm.nih.gov/${identifiers.PMID}/`;
  if (identifiers.CNKI) return identifiers.CNKI;
  if (identifiers.openAlex)
    return `https://openalex.org/${identifiers.openAlex}`;
  return undefined;
}

/**
 * Only http(s) URLs may be persisted, written to items, or launched.
 * Remote APIs and untrusted PDFs can hand us file:/smb:/custom-scheme
 * URIs; Zotero.launchURL forwards anything but javascript/data/chrome to
 * the OS protocol handler.
 */
export function isHttpUrl(s?: string): s is string {
  return typeof s === "string" && /^https?:\/\/\S+$/i.test(s);
}

export function isDOI(text?: string): boolean {
  if (!text) return false;
  const res = text.match(REGEX.DOI);
  return !!res && res[0] === text && !/(cnki|issn)/i.test(text);
}

export function isChinese(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  if (!t.length) return false;
  return (t.match(/[一-龥]/g)?.length || 0) / t.length > 0.5;
}

export function htmlToText(html?: string): string {
  if (!html) return "";
  let text: string;
  try {
    const doc = ztoolkit
      .getDOMParser()
      .parseFromString(`<div>${html}</div>`, "text/html");
    text = doc.body?.textContent || html;
  } catch {
    text = html;
  }
  return text
    .replace(/<([\w:]+?)>([\s\S]+?)<\/\1>/g, (_m, _p1, p2) => p2)
    .replace(/\n+/g, " ")
    .trim();
}

/**
 * Strip HTML markup / entities that metadata APIs leave in titles
 * ("Resected <i>ALK</i>-Positive…", "&amp;"). Cheap path for the common
 * clean case; falls back to the DOM parser only when markup is present.
 */
export function cleanText<T extends string | undefined>(s: T): T {
  if (!s || (!s.includes("<") && !s.includes("&"))) return s;
  return (
    htmlToText(s)
      // markup boundaries leave whitespace scars: "<i>ALK</i>\n -Positive"
      .replace(/\s+/g, " ")
      .replace(/\s+([-–])(?=\S)/g, "$1")
      .replace(/\s+([,.;:!?)])/g, "$1")
      .replace(/\(\s+/g, "(")
      .trim() as T
  );
}

/** lowercase, keep only letters / digits / CJK — for title matching */
export function normalizeTitle(s?: string): string {
  if (!s) return "";
  return (
    s
      .toLowerCase()
      .match(/[0-9a-z一-龥]+/g)
      ?.join("") || ""
  );
}

/**
 * Heuristic parse of a raw bibliography string into title / authors / year /
 * venue. Ported from zotero-reference with fixes.
 */
export function parseRefText(text: string): {
  year?: string;
  authors?: string[];
  title: string;
  publicationVenue?: string;
} {
  try {
    text = text
      .replace(/^\[\d+?\]/, "")
      .replace(/\s+/g, " ")
      .trim();
    let title: string;
    let titleMatch: string;
    const quoted = text.match(/[“"](.+?)[”"]/);
    if (quoted) {
      titleMatch = quoted[0];
      title = quoted[1];
      if (title.endsWith(",")) title = title.slice(0, -1);
    } else {
      const segments =
        text.indexOf(". ") !== -1 && (text.match(/\.\s/g)?.length || 0) >= 2
          ? text.split(". ")
          : text.split(".");
      const candidates = segments
        .sort((a, b) => b.length - a.length)
        // score: fraction of abbreviation/symbol/digit chars — authors score high
        .map((s) => {
          let count = 0;
          for (const regex of [/[A-Z]\./g, /[,.\-():]/g, /\d/g]) {
            count += s.match(regex)?.length || 0;
          }
          return [count / Math.max(s.length, 1), s] as [number, string];
        })
        // a title should have at least a few words
        .filter((entry) => (entry[1].match(/\s+/g)?.length || 0) >= 3)
        .sort((a, b) => a[0] - b[0]);
      if (!candidates.length) return { title: text };
      title = titleMatch = candidates[0][1];
      title = title.replace(/\[[A-Z]\]$/, "");
    }
    title = title.trim();
    const splitByTitle = text.split(titleMatch);
    let authorInfo = (splitByTitle[0] || "").trim();
    const publicationVenue = splitByTitle[1]
      ?.match(/[^.\s].+[^.]/)?.[0]
      ?.split(/[,\d]/)[0]
      ?.trim();
    if (authorInfo.indexOf("et al.") !== -1) {
      authorInfo = authorInfo.split("et al.")[0] + "et al.";
    }
    const currentYear = new Date().getFullYear();
    const yearCandidates = text
      .match(/[^\d]\d{4}[^\d-]/g)
      ?.map((s) => s.match(/\d+/)![0]);
    const year = yearCandidates?.find(
      (s) => Number(s) > 1600 && Number(s) <= currentYear + 1,
    );
    if (year) {
      authorInfo = authorInfo.replace(`${year}.`, "").replace(year, "").trim();
    }
    return {
      year,
      title,
      authors: authorInfo ? [authorInfo] : [],
      publicationVenue,
    };
  } catch {
    return { title: text };
  }
}

/** raw reference string -> minimal RefItem */
export function refTextToInfo(text: string): RefItem {
  const identifiers = extractIdentifiers(text);
  const parsed = parseRefText(text);
  return {
    identifiers,
    url: extractURL(text) || identifiersToURL(identifiers),
    authors: parsed.authors || [],
    title: parsed.title,
    year: parsed.year,
    primaryVenue: parsed.publicationVenue,
    text,
    type: identifiers.arXiv ? "preprint" : "journalArticle",
  };
}

export function parseCNKIURL(cnkiURL?: string) {
  if (!cnkiURL) return undefined;
  try {
    const fileName = cnkiURL.match(/filename=(\w+)/i)![1];
    const dbName = cnkiURL.match(/dbname=(\w+)/i)![1];
    const dbCode = cnkiURL.match(/dbcode=(\w+)/i)?.[1] || dbName.slice(0, 4);
    return { fileName, dbName, dbCode };
  } catch {
    return undefined;
  }
}

/** shorten long strings for progress windows */
export function collapseText(text: string, n?: number): string {
  const limit = n ?? (isChinese(text) ? 15 : 35);
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}
